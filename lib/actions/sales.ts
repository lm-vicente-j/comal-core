"use server"

import z, { success, treeifyError } from "zod";
import { randomUUID } from "node:crypto";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { isAdmin } from "../permissions";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { PaymentMethodSchema, SaleItemsSchema, SaleStatusSchema, SalesSchema } from "./schemas";
import {
    CUSTOMER_PREFIX,
    customerSource,
    FREE_SALE_SOURCE,
    FREE_TICKET_PREFIX,
    freeTicketNumber,
    freeTicketSource,
    isFreeTicket,
    nextFreeTicketNumber,
} from "../pos-source";
import { businessDate, timestampRange, toBusinessCalendarDate } from "../analytics";
import {
    acquireJornadaTicketLock,
    createReservation,
    deleteReservation,
    deleteReservationByToken,
    getReservation,
    lockOpenJornada,
    pruneAndListReservations,
} from "../ticket-reservations";

const SaleSchema = z.object({
    id: z.number().int(),
    customerID: z.number().int().nullable().optional(),
    jornadaId: z.number().int().nullable().optional(),
    ticketAccountId: z.string().nullable().optional(),
    placedBy: z.number().int(),
    status: z.enum(["UNPAID", "PAID", "DEBT", "CANCELLED"]),
    source_type: z.string(),

    total: z.number().or(z.string()),
    createdAt: z.date().optional().or(z.string()),

    sale_items: z.array(
        z.object({
            productID: z.number().int(),
            quantity: z.number().int(),
            unitPrice: z.number().or(z.string()),
            subtotal: z.number().or(z.string()),
            products: z.object({
                id: z.number(),
                name: z.string(),
                price: z.number()
            }).nullable().optional()
        })
    )
});

const INT4_MAX = 2_147_483_647;

function accountSource(sale: { source_type: string | null; customerID: number | null }) {
    if (sale.source_type?.startsWith(CUSTOMER_PREFIX) && sale.customerID != null) {
        return customerSource(sale.customerID);
    }
    return sale.source_type;
}

export type Sale = z.infer<typeof SaleSchema>;

export async function createSale(
    sale_items: { productID: number, quantity: number }[],
    status: "UNPAID" | "PAID" | "DEBT",
    source_type: string,
    customerID: number,
    paymentMethod: "CASH" | "TRANSFER" = "CASH",
    reservationToken?: string,
    ticketSaleIds?: number[],
    ticketAccountId?: string,
): Promise<ActionResult<{ saleId: number; ticketAccountId?: string }>> {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    const placedBy = Number(session.user.id);
    if (!Number.isInteger(placedBy) || placedBy <= 0 || placedBy > INT4_MAX) return actionFail("UNAUTHORIZED");

    // Server actions receive whatever the client sends; the TS types are not enough.
    const input = z.object({
        sale_items: z.array(SaleItemsSchema.pick({ productID: true, quantity: true })).min(1),
        status: SaleStatusSchema.exclude(["CANCELLED"]),
        source_type: SalesSchema.shape.source_type,
        customerID: SalesSchema.shape.customerID,
        paymentMethod: PaymentMethodSchema,
        reservationToken: z.string().min(1).max(100).optional(),
        ticketSaleIds: z.array(SalesSchema.shape.id).min(1).optional(),
        ticketAccountId: z.uuid().optional(),
    }).safeParse({ sale_items, status, source_type, customerID, paymentMethod, reservationToken, ticketSaleIds, ticketAccountId });
    if (!input.success) {
        return actionFail("INVALID_INPUT", { fieldErrors: z.flattenError(input.error).fieldErrors });
    }

    const receivedSourceType = input.data.source_type;
    const isCustomerAccount = receivedSourceType.startsWith(CUSTOMER_PREFIX);
    if (isCustomerAccount && customerID <= 0) {
        return actionFail("INVALID_INPUT");
    }
    const cleanSourceType = isCustomerAccount ? customerSource(customerID) : receivedSourceType;
    const cleanTicketNumber = freeTicketNumber(cleanSourceType);

    // Reject malformed walk-in ticket prefixes like "VL-01", "vl-1", or out-of-range integers
    if (/^VL-/i.test(cleanSourceType) && cleanTicketNumber === null) {
        return actionFail("INVALID_INPUT");
    }

    if (status === "DEBT" && (!customerID || customerID <= 0)) {
        return actionFail("INVALID_INPUT");
    }

    if (cleanTicketNumber !== null && status === "DEBT") {
        return actionFail("INVALID_INPUT");
    }

    if (customerID < -1) {
        return actionFail("INVALID_INPUT");
    }

    // Merge duplicate productID lines so each sale has at most one sale_items row per product
    // (preserving inventory math invariants for updateSaleQuantity).
    const mergedItemMap = new Map<number, number>();
    for (const item of input.data.sale_items) {
        const nextQty = (mergedItemMap.get(item.productID) ?? 0) + item.quantity;
        if (nextQty > 2_147_483_647) {
            return actionFail("INVALID_INPUT");
        }
        mergedItemMap.set(item.productID, nextQty);
    }
    const mergedSaleItems = Array.from(mergedItemMap.entries()).map(([productID, quantity]) => ({
        productID,
        quantity,
    }));

    if (customerID > 0) {
        const customer = await prisma.customer.findUnique({
            where: { id: customerID },
            select: { id: true },
        });
        if (!customer) {
            return actionFail("INVALID_INPUT");
        }
    }

    let transactionResult: ActionResult<{ saleId: number; ticketAccountId?: string }>;

    try {
        transactionResult = await prisma.$transaction(async (tx): Promise<ActionResult<{ saleId: number; ticketAccountId?: string }>> => {
            // 1. Fetch Open Jornada
            const activeJornada = await lockOpenJornada(tx);

            if (!activeJornada) {
                // Notice this returns an object, it doesn't throw, so it won't hit the catch block
                return actionFail("NO_OPEN_JORNADA");
            }

            // VENTA_LIBRE is strictly an immediate settlement source; walk-in open tabs must use VL-<n>.
            if (status === "UNPAID" && cleanSourceType === FREE_SALE_SOURCE) {
                return actionFail("INVALID_INPUT");
            }

            // 1b. For walk-in guest tickets, serialize with nextFreeSaleTicket / closeJornada
            // and verify reservation ownership before writing.
            const ticketNumber = cleanTicketNumber;
            let activeTicketAccountId: string | undefined;
            if (ticketNumber !== null) {
                const existingRes = await getReservation(tx, activeJornada.id, ticketNumber);
                if (reservationToken) {
                    if (!existingRes || existingRes.token !== reservationToken) {
                        return actionFail("TICKET_TAKEN");
                    }
                    if (status === "UNPAID") activeTicketAccountId = randomUUID();
                } else {
                    if (existingRes || (status === "UNPAID" && !input.data.ticketSaleIds && !input.data.ticketAccountId)) {
                        return actionFail("TICKET_TAKEN");
                    }
                    if (status === "PAID") {
                        return actionFail("INVALID_INPUT");
                    }
                    const existingSale = await tx.sales.findFirst({
                        where: {
                            ...(input.data.ticketAccountId
                                ? { ticketAccountId: input.data.ticketAccountId }
                                : { id: { in: input.data.ticketSaleIds } }),
                            jornadaId: activeJornada.id,
                            source_type: cleanSourceType,
                            status: "UNPAID",
                        },
                        select: { ticketAccountId: true },
                    });
                    if (!existingSale) return actionFail("TICKET_TAKEN");
                    activeTicketAccountId = existingSale.ticketAccountId ?? randomUUID();
                    if (!existingSale.ticketAccountId) {
                        await tx.sales.updateMany({
                            where: {
                                jornadaId: activeJornada.id, source_type: cleanSourceType,
                                status: "UNPAID", ticketAccountId: null,
                            },
                            data: { ticketAccountId: activeTicketAccountId },
                        });
                    }
                }
            }

            // 2. Pre-fetch ALL products in a single database query
            const productIDs = mergedSaleItems.map((item) => item.productID);
            const products = await tx.products.findMany({
                where: { id: { in: productIDs } },
                include: { recipes: true }
            });

            // Map for instant O(1) in-memory lookups
            const productMap = new Map(products.map(p => [p.id, p]));

            let totalSale = 0;
            const itemsToInsert = [];
            const supplyDecrements: Record<number, number> = {}; 

            // 3. Perform all math and supply aggregation in memory (Extremely fast)
            for (const item of mergedSaleItems) {
                const product = productMap.get(item.productID);
                if (!product) throw new Error("PRODUCT_NOT_FOUND"); 

                const subtotal = product.price.toNumber() * item.quantity;
                totalSale += subtotal;
                if (!Number.isFinite(subtotal) || !Number.isFinite(totalSale)) {
                    throw new Error("INVALID_INPUT");
                }

                itemsToInsert.push({
                    productID: item.productID,
                    quantity: item.quantity,
                    unitPrice: product.price,
                    subtotal: subtotal,
                });

                //// INVENTORY AGGREGATION
                for (const recipe of product.recipes) {
                    if (recipe.quantityUsed) {
                        const quantity = Number(recipe.quantityUsed) * item.quantity;
                        const supplyID = recipe.supplyID;
                        // Accumulate the needed decrements so we only hit the DB once per supply
                        supplyDecrements[supplyID] = (supplyDecrements[supplyID] || 0) + quantity;
                        if (!Number.isFinite(supplyDecrements[supplyID])) {
                            throw new Error("INVALID_INPUT");
                        }
                    }
                }
            }

            // 4. REGISTER SALE (Must happen first to get newSale.id)
            // Walk-in tickets VL-<n> are UNPAID-only; direct PAID settlements normalize to VENTA_LIBRE.
            const persistedSourceType =
                ticketNumber !== null && status === "PAID" ? FREE_SALE_SOURCE : cleanSourceType;
            const newSale = await tx.sales.create({
                data: {
                    total: totalSale,
                    status: status,
                    source_type: persistedSourceType,
                    ticketAccountId: activeTicketAccountId,
                    customerID: (customerID === -1 || customerID === 0 || !customerID) ? undefined : customerID,
                    placedBy: placedBy,
                    payment_method: status === "PAID" ? paymentMethod : null,
                    jornadaId: activeJornada.id,
                    sale_items: {
                        create: itemsToInsert
                    }
                }
            });

            // Once a sale exists for a guest ticket, the UNPAID row in `sales`
            // (or immediate settlement for PAID/DEBT) supersedes the empty
            // ticket reservation atomically within the same transaction.
            if (ticketNumber !== null) {
                await deleteReservation(tx, activeJornada.id, ticketNumber);
            }

            // 5. Prepare Parallel Writes for Inventory, Debtors, and Customers
            const parallelWrites: Promise<any>[] = [];
            const hasValidCustomer = customerID && customerID > 0;
            const isDebt = status === "DEBT";

            // Push Inventory Updates
            for (const [supplyID, totalQty] of Object.entries(supplyDecrements)) {
                parallelWrites.push(
                    tx.supplies.update({
                        where: { id: Number(supplyID) },
                        data: { currentStock: { decrement: totalQty } }
                    })
                );
            }

            // Push Combined Customer & Debt Updates
            if (hasValidCustomer) {
                // Combine both updates (consumption date + balance) into one payload
                const customerUpdateData: any = {
                    lastConsumption: toBusinessCalendarDate()
                };

                if (isDebt) {
                    customerUpdateData.currentBalance = { increment: totalSale };
                    
                    // Add debtor creation
                    parallelWrites.push(
                        tx.debtors.create({
                            data: {
                                saleID: newSale.id,
                                customerID: customerID,
                                amount: totalSale,
                                status: "DEBT",
                                createdJornadaId: activeJornada.id
                            }
                        })
                    );
                }

                // Add single customer update
                parallelWrites.push(
                    tx.customer.update({
                        where: { id: customerID },
                        data: customerUpdateData
                    })
                );
            }

            // 6. Execute all non-dependent writes at the exact same time
            await Promise.all(parallelWrites);

            return actionOk({ saleId: newSale.id, ticketAccountId: activeTicketAccountId });
        });

    } catch (e) {
        console.error("createSale failed:", e);
        if (e instanceof Error && e.message === "PRODUCT_NOT_FOUND") {
            return actionFail("PRODUCT_NOT_FOUND");
        }
        if (e instanceof Error && e.message === "INVALID_INPUT") {
            return actionFail("INVALID_INPUT");
        }
        return actionFail("INTERNAL ERROR");
    }

    // 7. Revalidate Cache OUTSIDE the try/catch and transaction block
    // We only trigger this if the database transaction safely succeeded.
    if (transactionResult.success) {
        revalidatePath("/pos");
        revalidatePath("/debtors");
    }

    return transactionResult;
}
// Explicit discriminated union so callers can narrow on `success` and reach
// `data.sourceType` and `data.reservationToken` without a cast.
type NextTicketResult = ActionResult<{ sourceType: string; reservationToken: string }>;

/**
 * Atomically allocates and persists a reservation for the lowest walk-in
 * ticket number not already taken by an open UNPAID sale or an active
 * reservation in the open jornada.
 *
 * Backed by PostgreSQL and serialized with a transaction-scoped advisory lock
 * so concurrent requests across terminals or serverless instances cannot
 * receive the same ticket number before products are added.
 */
export async function nextFreeSaleTicket(): Promise<NextTicketResult> {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    const userId = Number(session.user.id);
    if (!Number.isInteger(userId) || userId <= 0 || userId > INT4_MAX) return actionFail("UNAUTHORIZED");

    try {
        return await prisma.$transaction(async (tx): Promise<NextTicketResult> => {
            const activeJornada = await tx.jornada.findFirst({
                where: { status: "OPEN" },
                select: { id: true }
            });

            if (!activeJornada) {
                return actionFail("NO_OPEN_JORNADA");
            }

            await acquireJornadaTicketLock(tx, activeJornada.id);

            const verifiedJornada = await tx.jornada.findUnique({
                where: { id: activeJornada.id },
                select: { status: true }
            });
            if (!verifiedJornada || verifiedJornada.status !== "OPEN") {
                return actionFail("NO_OPEN_JORNADA");
            }

            const activeReservations = await pruneAndListReservations(tx, activeJornada.id);

            const openTickets = await tx.sales.findMany({
                where: {
                    jornadaId: activeJornada.id,
                    status: "UNPAID",
                    source_type: { startsWith: FREE_TICKET_PREFIX }
                },
                distinct: ["source_type"],
                select: { source_type: true }
            });

            const takenInDb = openTickets
                .map((t) => freeTicketNumber(t.source_type ?? ""))
                .filter((n): n is number => n !== null);

            const taken = Array.from(new Set([...takenInDb, ...activeReservations.keys()]));
            const nextNumber = nextFreeTicketNumber(taken);

            const reservation = await createReservation(tx, activeJornada.id, nextNumber, userId);

            return actionOk({
                sourceType: freeTicketSource(nextNumber),
                reservationToken: reservation.token,
            });
        });
    } catch (e) {
        console.error(e);
        return actionFail("INTERNAL_ERROR");
    }
}

export async function releaseTicketReservationAction(
    sourceType: string,
    reservationToken: string
): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    const input = z.object({
        sourceType: z.string().regex(/^VL-[1-9]\d*$/),
        reservationToken: z.string().min(1).max(100),
    }).safeParse({ sourceType, reservationToken });
    if (!input.success) return actionFail("INVALID_INPUT");

    const ticketNum = freeTicketNumber(input.data.sourceType);
    if (ticketNum === null) return actionFail("INVALID_INPUT");

    try {
        return await prisma.$transaction(async (tx): Promise<ActionResult> => {
            const activeJornada = await tx.jornada.findFirst({
                where: { status: "OPEN" },
                select: { id: true }
            });
            if (!activeJornada) return actionFail("NO_OPEN_JORNADA");

            await acquireJornadaTicketLock(tx, activeJornada.id);

            const verifiedJornada = await tx.jornada.findUnique({
                where: { id: activeJornada.id },
                select: { status: true }
            });
            if (!verifiedJornada || verifiedJornada.status !== "OPEN") {
                return actionFail("NO_OPEN_JORNADA");
            }

            const existingSales = await tx.sales.count({
                where: {
                    jornadaId: activeJornada.id,
                    source_type: input.data.sourceType,
                    status: "UNPAID",
                }
            });
            if (existingSales > 0) {
                return actionFail("TICKET_HAS_SALES");
            }

            const released = await deleteReservationByToken(
                tx,
                activeJornada.id,
                ticketNum,
                input.data.reservationToken
            );
            if (!released) {
                return actionFail("RESERVATION_MISMATCH");
            }

            return actionOk();
        });
    } catch (e) {
        console.error(e);
        return actionFail("INTERNAL_ERROR");
    }
}

export async function closeAccountAction(
    sourceType: string,
    paymentMethod: "CASH" | "TRANSFER" = "CASH",
    saleIds?: number[],
    expectedTotal?: number,
): Promise<ActionResult<{ count: number }>> {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    const input = z.object({
        sourceType: SalesSchema.shape.source_type,
        paymentMethod: PaymentMethodSchema,
        saleIds: z.array(SalesSchema.shape.id).optional(),
        expectedTotal: z.number().nonnegative().optional(),
    }).safeParse({ sourceType, paymentMethod, saleIds, expectedTotal });
    if (!input.success) return actionFail("INVALID_INPUT");

    const cleanSourceType = input.data.sourceType;
    const uniqueSaleIds = Array.from(new Set(input.data.saleIds));
    try {
        const txResult = await prisma.$transaction(async (tx): Promise<ActionResult<{ count: number }>> => {
            const activeJornada = await lockOpenJornada(tx);
            if (!activeJornada) return actionFail("NO_OPEN_JORNADA");
            if (uniqueSaleIds.length === 0) return actionFail("NO_SALES_TO_CLOSE");

            const requestedSales = await tx.sales.findMany({
                where: { id: { in: uniqueSaleIds } },
                select: { id: true, status: true, source_type: true, jornadaId: true, customerID: true, total: true },
            });
            const matchingSales = requestedSales.filter((sale) =>
                sale.status === "UNPAID" && accountSource(sale) === cleanSourceType
            );
            if (matchingSales.some((sale) => sale.jornadaId !== activeJornada.id)) {
                return actionFail("DIFFERENT_JORNADA");
            }
            if (matchingSales.length !== uniqueSaleIds.length) {
                return actionFail("SALES_CHANGED");
            }

            if (input.data.expectedTotal === undefined) {
                return actionFail("INVALID_INPUT");
            }
            const totalsById = new Map(matchingSales.map((sale) => [sale.id, Number(sale.total)]));
            const total = uniqueSaleIds.reduce((sum, id) => sum + (totalsById.get(id) ?? 0), 0);
            if (total !== input.data.expectedTotal) {
                return actionFail("SALES_CHANGED");
            }

            const { count } = await tx.sales.updateMany({
                where: { id: { in: uniqueSaleIds }, status: "UNPAID", jornadaId: activeJornada.id },
                data: {
                    status: "PAID",
                    payment_method: paymentMethod,
                    source_type: isFreeTicket(cleanSourceType) ? FREE_SALE_SOURCE : cleanSourceType,
                },
            });
            if (count !== uniqueSaleIds.length) throw new Error("SALES_CHANGED");
            return actionOk({ count });
        });

        if (txResult.success) revalidatePath("/pos");
        return txResult;
    } catch (e) {
        if (e instanceof Error && e.message === "SALES_CHANGED") {
            return actionFail("SALES_CHANGED");
        }
        console.error(e);
        return actionFail("Error al cerrar la cuenta");
    }
}

export async function getSalesHistory() {
    const session = await auth();
    if (!session?.user) return [];

    const sales = await prisma.sales.findMany({
        include: {
            customer: isAdmin(session.user.role) ? true : { select: { id: true, customerName: true, alias: true, lastConsumption: true, registeredDate: true } },
            // Never expose credentials to the client. Staff receives only
            // display fields (id and name), withholding directory and role details.
            users: isAdmin(session.user.role)
                ? { select: { id: true, name: true, email: true, username: true, role: true, registeredAt: true, active: true } }
                : { select: { id: true, name: true } },
            sale_items: {
                include: { products: true }
            }
        },
        orderBy: { createdAt: 'desc' }

    });

    return sales.map(s => ({
        ...s,
        total: Number(s.total),
        createdAt: s.createdAt?.toISOString(),
        itemsCount: s.sale_items.length,
        customer: s.customer ? {
            ...s.customer,
            currentBalance: (s.customer as any).currentBalance !== undefined ? Number((s.customer as any).currentBalance) : undefined
        } : null,
        sale_items: s.sale_items.map(item => ({
            ...item,
            unitPrice: Number(item.unitPrice),
            subtotal: Number(item.subtotal),
            products: item.products
                ? { ...item.products, price: Number(item.products.price) }
                : item.products
        }))
    }))
}

export async function getTodaySalesHistory() {

    const session = await auth();
    if (!session?.user) return [];

    const today = businessDate();
    const { gte: startOfDay, lt: endOfDay } = timestampRange({ from: today, to: today });

    const activeJornada = await prisma.jornada.findFirst({
        where: { status: "OPEN" },
        select: { id: true },
    });

    const sales = await prisma.sales.findMany({
        where: {
            // Cancelled sales stay in the DB for auditing but leave the
            // POS "pedidos recientes" list, so deleting a line visibly works.
            status: { not: "CANCELLED" },
            OR: [
                {
                    createdAt: {
                        gte: startOfDay,
                        lt: endOfDay,
                    },
                },
                ...(activeJornada
                    ? [{ status: "UNPAID" as const, jornadaId: activeJornada.id }]
                    : []),
            ],
        },
        // Only what the POS renders: the full customer/users rows were
        // transferred on every reload and nothing in /pos reads them.
        select: {
            id: true,
            customerID: true,
            jornadaId: true,
            ticketAccountId: true,
            placedBy: true,
            status: true,
            source_type: true,
            total: true,
            createdAt: true,
            sale_items: {
                select: {
                    productID: true,
                    quantity: true,
                    unitPrice: true,
                    subtotal: true,
                    products: {
                        select: { id: true, name: true, price: true }
                    }
                }
            }
        },
        orderBy: { createdAt: 'desc' }

    });

    // Plain numbers/strings instead of Decimals and Dates, so the page can
    // pass the result straight to client components without a JSON
    // round-trip through stringify/parse. The cast is the same contract the
    // old JSON wash papered over: nullable columns arrive filled in practice.
    return sales.map(s => ({
        ...s,
        source_type: s.status === "UNPAID" ? accountSource(s) : s.source_type,
        total: Number(s.total),
        createdAt: s.createdAt?.toISOString(),
        itemsCount: s.sale_items.length,
        sale_items: s.sale_items.map(item => ({
            ...item,
            unitPrice: Number(item.unitPrice),
            subtotal: Number(item.subtotal),
            products: item.products
                ? { ...item.products, price: Number(item.products.price) }
                : item.products
        }))
    })) as Sale[]
}

export async function cancelSaleAction(saleId: number): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    if (!SalesSchema.shape.id.safeParse(saleId).success) return actionFail("INVALID_INPUT");

    try {
        return await prisma.$transaction(async (tx): Promise<ActionResult> => {
            const target = await tx.sales.findUnique({ where: { id: saleId }, select: { jornadaId: true } });
            if (target?.jornadaId != null) await acquireJornadaTicketLock(tx, target.jornadaId);
            await tx.$executeRaw`SELECT id FROM sales WHERE id = ${saleId} FOR UPDATE`;

            const sale = await tx.sales.findUnique({
                where: { id: saleId },
                include: {
                    sale_items: { include: { products: { include: { recipes: true } } } },
                    debtors: true,
                    jornada: true,
                }
            });

            if (!sale || sale.status === "CANCELLED") return actionFail("INVALID SALE");

            // Closed jornada check: once a jornada is closed (counted), its sales cannot be cancelled
            if (sale.jornada?.status === "CLOSED") {
                return actionFail("JORNADA_CLOSED");
            }

            // Role check: only ADMIN can cancel PAID sales or sales with debt
            if ((sale.status === "PAID" || sale.status === "DEBT") && !isAdmin(session.user.role)) {
                return actionFail("UNAUTHORIZED");
            }

            if (sale.debtors?.status === "PAID") {
                return actionFail("CANNOT_CANCEL_PAID_DEBT");
            }

            // Replenish inventory
            for (const item of sale.sale_items) {
                for (const recipe of item.products?.recipes || []) {
                    const quantity = Number(recipe.quantityUsed) * (item.quantity || 0);
                    await tx.supplies.update({
                        where: { id: recipe.supplyID },
                        data: { currentStock: { increment: quantity } }
                    });
                }
            }

            await tx.sales.update({
                where: { id: saleId },
                data: { status: "CANCELLED" }
            });

            // An open debt dies with its sale: otherwise it would keep showing
            // as receivable and inflate the customer's balance.
            if (sale.debtors?.status === "DEBT") {
                await tx.debtors.update({
                    where: { id: sale.debtors.id },
                    data: { status: "CANCELLED" }
                });
                await tx.customer.update({
                    where: { id: sale.debtors.customerID },
                    data: { currentBalance: { decrement: sale.debtors.amount } }
                });
                revalidatePath("/debtors");
            }

            revalidatePath("/pos");
            revalidatePath("/admin/inventory");
            return actionOk();
        });
    } catch (error) {
        return actionFail("INTERNAL ERROR");
    }
}

export async function updateSaleQuantity(saleId: number, quantity: number, productId: number): Promise<ActionResult> {

    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    const input = z.object({
        saleId: SalesSchema.shape.id,
        productId: SaleItemsSchema.shape.productID,
        quantity: SaleItemsSchema.shape.quantity,
    }).safeParse({ saleId, productId, quantity });
    if (!input.success) return actionFail("INVALID_INPUT");

    try {
        return await prisma.$transaction(async (tx): Promise<ActionResult> => {
            const target = await tx.sales.findUnique({ where: { id: saleId }, select: { jornadaId: true } });
            if (target?.jornadaId != null) await acquireJornadaTicketLock(tx, target.jornadaId);
            await tx.$executeRaw`SELECT id FROM sales WHERE id = ${saleId} FOR UPDATE`;

            const sale = await tx.sales.findUnique({
                where: { id: saleId },
                include: { debtors: true, jornada: true }
            });
            if (!sale) return actionFail("NOT FOUND SALE");
            if (sale.status === "CANCELLED") {
                return actionFail("CANNOT_MODIFY_CANCELLED_SALE");
            }
            if (sale.jornada?.status === "CLOSED") {
                return actionFail("JORNADA_CLOSED");
            }
            if ((sale.status === "PAID" || sale.status === "DEBT") && session.user.role !== "ADMIN") {
                return actionFail("UNAUTHORIZED");
            }
            if (sale.debtors?.status === "PAID") {
                return actionFail("CANNOT_MODIFY_PAID_DEBT");
            }

            const matchingItems = await tx.sale_items.findMany({
                where: { saleID: saleId, productID: productId },
                include: { products: { include: { recipes: true } } },
                orderBy: { id: "asc" },
            });

            const currentItem = matchingItems[0];
            if (!currentItem || !currentItem.products) return actionFail("NOT FOUND ITEM");

            const oldQuantity = matchingItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
            const quantityDiff = quantity - oldQuantity;

            for (const recipe of currentItem.products.recipes) {
                if (recipe.quantityUsed) {
                    const totalAdjustment = Number(recipe.quantityUsed) * quantityDiff;
                    if (!Number.isFinite(totalAdjustment)) {
                        throw new Error("INVALID_INPUT");
                    }
                    await tx.supplies.update({
                        where: { id: recipe.supplyID },
                        data: { currentStock: { decrement: totalAdjustment } }
                    });
                }
            }

            const newSubtotal = currentItem.unitPrice.toNumber() * quantity;
            if (!Number.isFinite(newSubtotal)) {
                throw new Error("INVALID_INPUT");
            }
            await tx.sale_items.update({
                where: { id: currentItem.id },
                data: {
                    quantity: quantity,
                    subtotal: newSubtotal
                }
            });
            if (matchingItems.length > 1) {
                await tx.sale_items.deleteMany({
                    where: { id: { in: matchingItems.slice(1).map((item) => item.id) } },
                });
            }

            const allItems = await tx.sale_items.findMany({
                where: { saleID: saleId }
            });
            const newTotalSale = allItems.reduce((acc, item) => acc + Number(item.subtotal), 0);
            if (!Number.isFinite(newTotalSale)) {
                throw new Error("INVALID_INPUT");
            }

            await tx.sales.update({
                where: { id: saleId },
                data: { total: newTotalSale }
            });

            // Synchronize active debt row and customer balance if the sale is in DEBT
            if (sale?.status === "DEBT" && sale.debtors && sale.debtors.status === "DEBT") {
                const oldTotal = Number(sale.total ?? sale.debtors.amount ?? 0);
                const diff = newTotalSale - oldTotal;

                await tx.debtors.update({
                    where: { id: sale.debtors.id },
                    data: { amount: newTotalSale }
                });

                const targetCustomerId = sale.customerID ?? sale.debtors.customerID;
                if (targetCustomerId) {
                    await tx.customer.update({
                        where: { id: targetCustomerId },
                        data: { currentBalance: { increment: diff } }
                    });
                }
                revalidatePath("/debtors");
            }

            revalidatePath("/pos");
            return actionOk();
        });
    } catch (e) {
        if (e instanceof Error && e.message === "INVALID_INPUT") {
            return actionFail("INVALID_INPUT");
        }
        console.error(e);
        return actionFail("Error al actualizar cantidad");
    }
}
