"use server"

import z from "zod";
import type { Prisma } from "@/app/generated/prisma/client";
import { randomUUID } from "node:crypto";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { isAdmin } from "../permissions";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { toSafeInteger } from "../scaled-values";
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

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
function isSafeBigInt(value: bigint): boolean {
    return value >= MIN_SAFE_BIGINT && value <= MAX_SAFE_BIGINT;
}

type ConsumptionLine = { supplyID: number; quantityUsedMilliunits: bigint | null };
type SaleItemWithConsumption = {
    quantity: number;
    consumptionRecorded: boolean;
    consumptions: ConsumptionLine[];
    products: { recipes: ConsumptionLine[] } | null;
};

function getItemRecipeLines(item: SaleItemWithConsumption): ConsumptionLine[] {
    return item.consumptionRecorded ? item.consumptions : (item.products?.recipes ?? []);
}

/**
 * Accumulates per-supply consumption (`perUnit * multiplier`) for a sale item
 * into `target`, returning false if any term or running total overflows JS safe integers.
 */
function accumulateItemConsumption(
    target: Map<number, bigint>,
    item: SaleItemWithConsumption,
    multiplier: bigint,
): boolean {
    for (const line of getItemRecipeLines(item)) {
        const perUnit = line.quantityUsedMilliunits ?? BigInt(0);
        if (perUnit <= BigInt(0)) continue;
        const delta = perUnit * multiplier;
        if (!isSafeBigInt(delta)) return false;
        const nextTotal = (target.get(line.supplyID) ?? BigInt(0)) + delta;
        if (!isSafeBigInt(nextTotal)) return false;
        target.set(line.supplyID, nextTotal);
    }
    return true;
}

/**
 * Locks and reads the given supplies in deterministic ascending `id` order
 * inside the current transaction to prevent TOCTOU races and deadlocks.
 */
async function lockAndReadSupplies(
    tx: Prisma.TransactionClient,
    supplyIds: Iterable<number>,
): Promise<{ id: number; currentStockMilliunits: bigint; active: boolean }[]> {
    const sortedIds = Array.from(new Set(supplyIds)).sort((a, b) => a - b);
    if (sortedIds.length === 0) return [];
    await tx.$executeRaw`
        SELECT id
        FROM supplies
        WHERE id = ANY(${sortedIds}::int4[])
        ORDER BY id ASC
        FOR UPDATE
    `;
    return tx.supplies.findMany({
        where: { id: { in: sortedIds } },
        select: { id: true, currentStockMilliunits: true, active: true },
        orderBy: { id: "asc" },
    });
}

async function checkPaidEmployeeSafeBounds(
    tx: Prisma.TransactionClient,
    jornadaId: number,
    employeeDeltas: Map<number, bigint>,
): Promise<boolean> {
    if (employeeDeltas.size === 0) return true;
    const empSales = await tx.sales.groupBy({
        by: ["placedBy"],
        where: { jornadaId, status: "PAID", placedBy: { in: Array.from(employeeDeltas.keys()) } },
        _sum: { totalCents: true },
    });
    const existingByEmp = new Map(empSales.map((row) => [row.placedBy, row._sum.totalCents ?? BigInt(0)]));
    for (const [empId, empDelta] of employeeDeltas) {
        if (!isSafeBigInt((existingByEmp.get(empId) ?? BigInt(0)) + empDelta)) {
            return false;
        }
    }
    return true;
}

async function checkPaidJornadaSafeBounds(
    tx: Prisma.TransactionClient,
    jornadaId: number,
    paymentMethod: "CASH" | "TRANSFER",
    deltaCents: bigint,
    employeeDeltas: Map<number, bigint>,
): Promise<boolean> {
    const [jornadaRow, methodSalesAgg, methodDebtAgg, methodBillsAgg, methodSalariesAgg, depositsAgg, empSafe] = await Promise.all([
        tx.jornada.findUnique({ where: { id: jornadaId }, select: { openingAmountCents: true } }),
        tx.sales.aggregate({
            where: { jornadaId, status: "PAID", debtors: { is: null }, payment_method: paymentMethod },
            _sum: { totalCents: true },
        }),
        tx.debtors.aggregate({
            where: { paidJornadaId: jornadaId, status: "PAID", sales: { status: "PAID", payment_method: paymentMethod } },
            _sum: { amountCents: true },
        }),
        tx.bill.aggregate({ where: { jornadaId, payment_method: paymentMethod }, _sum: { amountCents: true } }),
        tx.salary.aggregate({ where: { jornadaId, payment_method: paymentMethod }, _sum: { amountCents: true } }),
        paymentMethod === "CASH"
            ? tx.savings_movement.aggregate({ where: { jornadaId, type: "DEPOSIT" }, _sum: { amountCents: true } })
            : Promise.resolve({ _sum: { amountCents: null } }),
        checkPaidEmployeeSafeBounds(tx, jornadaId, employeeDeltas),
    ]);
    if (!empSafe) return false;

    const nextMethodSales = (methodSalesAgg._sum.totalCents ?? BigInt(0)) + deltaCents;
    if (!isSafeBigInt(nextMethodSales)) return false;

    const nextExpected = (paymentMethod === "CASH" ? (jornadaRow?.openingAmountCents ?? BigInt(0)) : BigInt(0))
        + nextMethodSales
        + (methodDebtAgg._sum.amountCents ?? BigInt(0))
        - (methodBillsAgg._sum.amountCents ?? BigInt(0))
        - (methodSalariesAgg._sum.amountCents ?? BigInt(0))
        - (depositsAgg._sum.amountCents ?? BigInt(0));
    if (!isSafeBigInt(nextExpected)) return false;

    return true;
}

const INT4_MAX = 2_147_483_647;

function accountSource(sale: { source_type: string | null; customerID: number | null }) {
    if (sale.source_type?.startsWith(CUSTOMER_PREFIX) && sale.customerID != null) {
        return customerSource(sale.customerID);
    }
    return sale.source_type;
}

export type Sale = {
    id: number;
    customerID?: number | null;
    jornadaId?: number | null;
    ticketAccountId?: string | null;
    placedBy: number;
    status: z.infer<typeof SaleStatusSchema>;
    source_type: string;
    total: number;
    createdAt?: Date | string;
    sale_items: {
        productID: number;
        quantity: number;
        unitPrice: number;
        subtotal: number;
        products?: { id: number; name: string; price: number } | null;
    }[];
};

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
    const isCustomerAccount = receivedSourceType.startsWith(CUSTOMER_PREFIX) || /^CL-/i.test(receivedSourceType);
    if (isCustomerAccount && customerID <= 0) {
        return actionFail("INVALID_INPUT");
    }
    const cleanSourceType = isCustomerAccount ? customerSource(customerID) : receivedSourceType;
    const cleanTicketNumber = freeTicketNumber(cleanSourceType);

    // Reject malformed walk-in ticket prefixes like "VL-01", "vl-1", or out-of-range integers
    if (/^VL-/i.test(cleanSourceType) && cleanTicketNumber === null) {
        return actionFail("INVALID_INPUT");
    }

    const isWalkInSource = cleanSourceType === FREE_SALE_SOURCE || cleanTicketNumber !== null;
    const tableMatch = /^MESA_([1-9]\d*)$/.exec(cleanSourceType);
    const tableNumber = tableMatch ? Number(tableMatch[1]) : null;
    const isTableSource = tableNumber !== null && Number.isSafeInteger(tableNumber) && tableNumber <= 2_147_483_647;

    if ((isWalkInSource || isTableSource) && customerID > 0) {
        return actionFail("INVALID_INPUT");
    }

    const isValidSource =
        isCustomerAccount
        || cleanTicketNumber !== null
        || isTableSource
        || cleanSourceType === FREE_SALE_SOURCE;
    if (!isValidSource) {
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
            const sortedProductIDs = [...productIDs].sort((a, b) => a - b);
            await tx.$executeRaw`SELECT id FROM products WHERE id = ANY(${sortedProductIDs}::int4[]) ORDER BY id FOR UPDATE`;
            const products = await tx.products.findMany({
                where: { id: { in: productIDs } },
                include: { recipes: true }
            });

            // Map for instant O(1) in-memory lookups
            const productMap = new Map(products.map(p => [p.id, p]));
            if (products.some(p => !p.active)) throw new Error("INACTIVE_ITEM");
            const recipeSupplyIds = [...new Set(products.flatMap(p => p.recipes.map(r => r.supplyID)))];
            const recipeSupplies = await lockAndReadSupplies(tx, recipeSupplyIds);
            if (recipeSupplies.length !== recipeSupplyIds.length || recipeSupplies.some(s => !s.active)) throw new Error("INACTIVE_ITEM");

            let totalSale = BigInt(0);
            const itemsToInsert = [];
            const supplyDecrements: Record<number, bigint> = {};

            // 3. Perform all math and supply aggregation in memory (Extremely fast)
            for (const item of mergedSaleItems) {
                const product = productMap.get(item.productID);
                if (!product) throw new Error("PRODUCT_NOT_FOUND"); 

                const subtotal = product.priceCents * BigInt(item.quantity);
                totalSale += subtotal;
                if (!Number.isSafeInteger(Number(subtotal)) || !Number.isSafeInteger(Number(totalSale))) {
                    throw new Error("INVALID_INPUT");
                }

                const consumptionsToInsert: { supplyID: number; quantityUsedMilliunits: bigint }[] = [];

                //// INVENTORY AGGREGATION
                for (const recipe of product.recipes) {
                    if (recipe.quantityUsedMilliunits && recipe.quantityUsedMilliunits > BigInt(0)) {
                        const quantity = recipe.quantityUsedMilliunits * BigInt(item.quantity);
                        const supplyID = recipe.supplyID;
                        // Accumulate the needed decrements so we only hit the DB once per supply
                        supplyDecrements[supplyID] = (supplyDecrements[supplyID] ?? BigInt(0)) + quantity;
                        if (!Number.isSafeInteger(Number(supplyDecrements[supplyID]))) {
                            throw new Error("INVALID_INPUT");
                        }
                        consumptionsToInsert.push({
                            supplyID,
                            quantityUsedMilliunits: recipe.quantityUsedMilliunits,
                        });
                    }
                }

                itemsToInsert.push({
                    productID: item.productID,
                    quantity: item.quantity,
                    unitPriceCents: product.priceCents,
                    subtotalCents: subtotal,
                    consumptionRecorded: true,
                    ...(consumptionsToInsert.length > 0 && {
                        consumptions: { create: consumptionsToInsert },
                    }),
                });
            }

            // 3b. Verify cumulative persisted aggregates remain within safe integer bounds
            const hasValidCustomer = Boolean(customerID && customerID > 0);
            const isDebt = status === "DEBT";

            const persistedSourceType =
                ticketNumber !== null && status === "PAID" ? FREE_SALE_SOURCE : cleanSourceType;

            const supplyIdsToDecrement = Object.keys(supplyDecrements).map(Number);
            const [
                existingSupplies,
                existingUnpaidSales,
                existingCustomer,
                existingOpenDebts,
                existingJornadaDebts,
            ] = await Promise.all([
                supplyIdsToDecrement.length > 0
                    ? lockAndReadSupplies(tx, supplyIdsToDecrement)
                    : Promise.resolve([]),
                status === "UNPAID"
                    ? tx.sales.aggregate({
                        where: {
                            jornadaId: activeJornada.id,
                            status: "UNPAID",
                            source_type: persistedSourceType,
                        },
                        _sum: { totalCents: true },
                    })
                    : Promise.resolve({ _sum: { totalCents: null } }),
                hasValidCustomer && isDebt
                    ? tx.customer.findUnique({
                        where: { id: customerID },
                        select: { currentBalanceCents: true },
                    })
                    : Promise.resolve(null),
                hasValidCustomer && isDebt
                    ? tx.debtors.aggregate({
                        where: { status: "DEBT" },
                        _sum: { amountCents: true },
                    })
                    : Promise.resolve({ _sum: { amountCents: null } }),
                hasValidCustomer && isDebt
                    ? tx.debtors.aggregate({
                        where: { createdJornadaId: activeJornada.id, status: { not: "CANCELLED" } },
                        _sum: { amountCents: true },
                    })
                    : Promise.resolve({ _sum: { amountCents: null } }),
            ]);

            for (const supply of existingSupplies) {
                const dec = supplyDecrements[supply.id] ?? BigInt(0);
                if (!isSafeBigInt(supply.currentStockMilliunits - dec)) {
                    throw new Error("INVALID_INPUT");
                }
            }

            if (status === "PAID") {
                const paidSafe = await checkPaidJornadaSafeBounds(
                    tx,
                    activeJornada.id,
                    paymentMethod,
                    totalSale,
                    new Map([[placedBy, totalSale]]),
                );
                if (!paidSafe) {
                    throw new Error("INVALID_INPUT");
                }
            } else if (status === "UNPAID") {
                const nextSalesSum = (existingUnpaidSales._sum.totalCents ?? BigInt(0)) + totalSale;
                if (!isSafeBigInt(nextSalesSum)) {
                    throw new Error("INVALID_INPUT");
                }
            }

            if (hasValidCustomer && isDebt) {
                const nextBalance = (existingCustomer?.currentBalanceCents ?? BigInt(0)) + totalSale;
                const nextOpenDebts = (existingOpenDebts._sum.amountCents ?? BigInt(0)) + totalSale;
                const nextJornadaDebts = (existingJornadaDebts._sum.amountCents ?? BigInt(0)) + totalSale;
                if (!isSafeBigInt(nextBalance) || !isSafeBigInt(nextOpenDebts) || !isSafeBigInt(nextJornadaDebts)) {
                    throw new Error("INVALID_INPUT");
                }
            }

            // 4. REGISTER SALE (Must happen first to get newSale.id)
            // Walk-in tickets VL-<n> are UNPAID-only; direct PAID settlements normalize to VENTA_LIBRE.
            const newSale = await tx.sales.create({
                data: {
                    totalCents: totalSale,
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

            // 5. Update Inventory in deterministic ascending supplyID order, then Customer & Debtors
            const sortedDecrements = Object.entries(supplyDecrements)
                .map(([supplyID, totalQty]) => [Number(supplyID), totalQty] as const)
                .sort(([a], [b]) => a - b);
            for (const [supplyID, totalQty] of sortedDecrements) {
                await tx.supplies.update({
                    where: { id: supplyID },
                    data: { currentStockMilliunits: { decrement: totalQty } }
                });
            }

            const parallelWrites: Promise<unknown>[] = [];

            // Push Combined Customer & Debt Updates
            if (hasValidCustomer) {
                // Combine both updates (consumption date + balance) into one payload
                const customerUpdateData: Prisma.customerUpdateInput = {
                    lastConsumption: toBusinessCalendarDate()
                };

                if (isDebt) {
                    customerUpdateData.currentBalanceCents = { increment: totalSale };
                    
                    // Add debtor creation
                    parallelWrites.push(
                        tx.debtors.create({
                            data: {
                                saleID: newSale.id,
                                customerID: customerID,
                                amountCents: totalSale,
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
        if (e instanceof Error && e.message === "INACTIVE_ITEM") return actionFail("INACTIVE_ITEM");
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
        revalidatePath("/admin/inventory");
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
        expectedTotal: z.number().int().safe().nonnegative().optional(),
    }).safeParse({ sourceType, paymentMethod, saleIds, expectedTotal });
    if (!input.success) return actionFail("INVALID_INPUT");

    const cleanSourceType = input.data.sourceType;
    const uniqueSaleIds = Array.from(new Set(input.data.saleIds));
    if (input.data.saleIds && uniqueSaleIds.length !== input.data.saleIds.length) {
        return actionFail("INVALID_INPUT");
    }
    try {
        const txResult = await prisma.$transaction(async (tx): Promise<ActionResult<{ count: number }>> => {
            const activeJornada = await lockOpenJornada(tx);
            if (!activeJornada) return actionFail("NO_OPEN_JORNADA");
            if (uniqueSaleIds.length === 0) return actionFail("NO_SALES_TO_CLOSE");

            const requestedSales = await tx.sales.findMany({
                where: { id: { in: uniqueSaleIds } },
                select: { id: true, status: true, source_type: true, jornadaId: true, customerID: true, placedBy: true, totalCents: true },
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
            const total = matchingSales.reduce((sum, sale) => sum + (sale.totalCents ?? BigInt(0)), BigInt(0));
            if (total !== BigInt(input.data.expectedTotal)) {
                return actionFail("SALES_CHANGED");
            }

            const employeeDeltas = new Map<number, bigint>();
            for (const sale of matchingSales) {
                employeeDeltas.set(sale.placedBy, (employeeDeltas.get(sale.placedBy) ?? BigInt(0)) + (sale.totalCents ?? BigInt(0)));
            }
            const paidSafe = await checkPaidJornadaSafeBounds(tx, activeJornada.id, paymentMethod, total, employeeDeltas);
            if (!paidSafe) {
                return actionFail("INVALID_INPUT");
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

    return sales.map(({ totalCents, customer, sale_items, ...s }) => {
        const { currentBalanceCents, ...customerDetails } = customer ?? {};
        return {
            ...s,
            total: toSafeInteger(totalCents ?? BigInt(0)),
            createdAt: s.createdAt?.toISOString(),
            itemsCount: sale_items.length,
            customer: customer ? {
                ...customerDetails,
                currentBalance: currentBalanceCents === undefined ? undefined : toSafeInteger(currentBalanceCents),
            } : null,
            sale_items: sale_items.map(({ unitPriceCents, subtotalCents, products, ...item }) => {
                const { priceCents, ...product } = products ?? {};
                return {
                    ...item,
                    unitPrice: toSafeInteger(unitPriceCents),
                    subtotal: toSafeInteger(subtotalCents),
                    products: priceCents === undefined ? null : { ...product, price: toSafeInteger(priceCents) },
                };
            }),
        };
    });
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
            totalCents: true,
            createdAt: true,
            sale_items: {
                select: {
                    productID: true,
                    quantity: true,
                    unitPriceCents: true,
                    subtotalCents: true,
                    products: {
                        select: { id: true, name: true, priceCents: true }
                    }
                }
            }
        },
        orderBy: { createdAt: 'desc' }

    });

    return sales.map(({ totalCents, sale_items, ...s }) => ({
        ...s,
        source_type: s.status === "UNPAID" ? accountSource(s) : s.source_type,
        total: toSafeInteger(totalCents ?? BigInt(0)),
        createdAt: s.createdAt?.toISOString(),
        itemsCount: sale_items.length,
        sale_items: sale_items.map(({ unitPriceCents, subtotalCents, products, ...item }) => ({
            ...item,
            unitPrice: toSafeInteger(unitPriceCents),
            subtotal: toSafeInteger(subtotalCents),
            products: products ? { id: products.id, name: products.name, price: toSafeInteger(products.priceCents) } : null,
        })),
    })) as Sale[]
}

export async function cancelSaleAction(saleId: number): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    if (!SalesSchema.shape.id.safeParse(saleId).success) return actionFail("INVALID_INPUT");

    let txOutcome: { result: ActionResult; revalidateDebtors: boolean };

    try {
        txOutcome = await prisma.$transaction(async (tx): Promise<{ result: ActionResult; revalidateDebtors: boolean }> => {
            const target = await tx.sales.findUnique({ where: { id: saleId }, select: { jornadaId: true } });
            if (target?.jornadaId != null) await acquireJornadaTicketLock(tx, target.jornadaId);
            await tx.$executeRaw`SELECT id FROM sales WHERE id = ${saleId} FOR UPDATE`;

            const sale = await tx.sales.findUnique({
                where: { id: saleId },
                include: {
                    sale_items: {
                        include: {
                            consumptions: true,
                            products: { include: { recipes: true } },
                        },
                    },
                    debtors: true,
                    jornada: true,
                }
            });

            if (!sale || sale.status === "CANCELLED") {
                return { result: actionFail("INVALID SALE"), revalidateDebtors: false };
            }

            if (sale.status === "PAID") {
                return { result: actionFail("CANNOT_CANCEL_PAID_SALE"), revalidateDebtors: false };
            }

            // Closed jornada check: once a jornada is closed (counted), its sales cannot be cancelled
            if (sale.jornada?.status === "CLOSED") {
                return { result: actionFail("JORNADA_CLOSED"), revalidateDebtors: false };
            }

            // Only ADMIN can cancel sales with debt.
            if (sale.status === "DEBT" && !isAdmin(session.user.role)) {
                return { result: actionFail("UNAUTHORIZED"), revalidateDebtors: false };
            }

            if (sale.debtors?.status === "PAID") {
                return { result: actionFail("CANNOT_CANCEL_PAID_DEBT"), revalidateDebtors: false };
            }

            // Aggregate inventory replenishment from snapshotted consumption (with legacy fallback)
            const supplyIncrements = new Map<number, bigint>();
            for (const item of sale.sale_items) {
                if (!accumulateItemConsumption(supplyIncrements, item, BigInt(item.quantity ?? 0))) {
                    return { result: actionFail("INVALID_INPUT"), revalidateDebtors: false };
                }
            }
            if (supplyIncrements.size > 0) {
                const currentSupplies = await lockAndReadSupplies(tx, supplyIncrements.keys());
                for (const sup of currentSupplies) {
                    const inc = supplyIncrements.get(sup.id) ?? BigInt(0);
                    if (!isSafeBigInt(inc) || !isSafeBigInt(sup.currentStockMilliunits + inc)) {
                        return { result: actionFail("INVALID_INPUT"), revalidateDebtors: false };
                    }
                }
            }
            if (sale.debtors?.status === "DEBT") {
                const cust = await tx.customer.findUnique({
                    where: { id: sale.debtors.customerID },
                    select: { currentBalanceCents: true },
                });
                if (cust && !isSafeBigInt(cust.currentBalanceCents - sale.debtors.amountCents)) {
                    return { result: actionFail("INVALID_INPUT"), revalidateDebtors: false };
                }
            }
            // Replenish inventory in deterministic ascending supplyId order
            const sortedIncrements = Array.from(supplyIncrements.entries()).sort(([a], [b]) => a - b);
            for (const [supplyId, quantity] of sortedIncrements) {
                await tx.supplies.update({
                    where: { id: supplyId },
                    data: { currentStockMilliunits: { increment: quantity } }
                });
            }

            await tx.sales.update({
                where: { id: saleId },
                data: { status: "CANCELLED" }
            });

            // An open debt dies with its sale: otherwise it would keep showing
            // as receivable and inflate the customer's balance.
            let revalidateDebtors = false;
            if (sale.debtors?.status === "DEBT") {
                await tx.debtors.update({
                    where: { id: sale.debtors.id },
                    data: { status: "CANCELLED" }
                });
                await tx.customer.update({
                    where: { id: sale.debtors.customerID },
                    data: { currentBalanceCents: { decrement: sale.debtors.amountCents } }
                });
                revalidateDebtors = true;
            }

            return { result: actionOk(), revalidateDebtors };
        });
    } catch {
        return actionFail("INTERNAL ERROR");
    }

    if (txOutcome.result.success) {
        if (txOutcome.revalidateDebtors) {
            revalidatePath("/debtors");
        }
        revalidatePath("/pos");
        revalidatePath("/admin/inventory");
    }

    return txOutcome.result;
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

    let txOutcome: { result: ActionResult; revalidateDebtors: boolean };

    try {
        txOutcome = await prisma.$transaction(async (tx): Promise<{ result: ActionResult; revalidateDebtors: boolean }> => {
            const target = await tx.sales.findUnique({ where: { id: saleId }, select: { jornadaId: true } });
            if (target?.jornadaId != null) await acquireJornadaTicketLock(tx, target.jornadaId);
            await tx.$executeRaw`SELECT id FROM sales WHERE id = ${saleId} FOR UPDATE`;

            const sale = await tx.sales.findUnique({
                where: { id: saleId },
                include: { debtors: true, jornada: true }
            });
            if (!sale) return { result: actionFail("NOT FOUND SALE"), revalidateDebtors: false };
            if (sale.status === "CANCELLED") {
                return { result: actionFail("CANNOT_MODIFY_CANCELLED_SALE"), revalidateDebtors: false };
            }
            if (sale.status === "PAID") {
                return { result: actionFail("CANNOT_MODIFY_PAID_SALE"), revalidateDebtors: false };
            }
            if (sale.jornada?.status === "CLOSED") {
                return { result: actionFail("JORNADA_CLOSED"), revalidateDebtors: false };
            }
            if (sale.status === "DEBT" && session.user.role !== "ADMIN") {
                return { result: actionFail("UNAUTHORIZED"), revalidateDebtors: false };
            }
            if (sale.debtors?.status === "PAID") {
                return { result: actionFail("CANNOT_MODIFY_PAID_DEBT"), revalidateDebtors: false };
            }

            await tx.$executeRaw`SELECT id FROM products WHERE id = ${productId} FOR UPDATE`;
            const matchingItems = await tx.sale_items.findMany({
                where: { saleID: saleId, productID: productId },
                include: {
                    consumptions: true,
                    products: { include: { recipes: true } },
                },
                orderBy: { id: "asc" },
            });

            const currentItem = matchingItems[0];
            if (!currentItem || !currentItem.products) {
                return { result: actionFail("NOT FOUND ITEM"), revalidateDebtors: false };
            }

            const oldQuantity = matchingItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
            if (quantity > oldQuantity) {
                const currentProduct = await tx.products.findUnique({ where: { id: productId }, include: { recipes: true } });
                if (!currentProduct?.active) return { result: actionFail("INACTIVE_ITEM"), revalidateDebtors: false };
                const supplyIds = [...new Set([
                    ...currentProduct.recipes.map(r => r.supplyID),
                    ...matchingItems.flatMap(item => item.consumptions.map(c => c.supplyID)),
                ])];
                const supplies = await lockAndReadSupplies(tx, supplyIds);
                if (supplies.length !== supplyIds.length || supplies.some(s => !s.active)) {
                    return { result: actionFail("INACTIVE_ITEM"), revalidateDebtors: false };
                }
            }

            const oldConsumption = new Map<number, bigint>();
            for (const item of matchingItems) {
                if (!accumulateItemConsumption(oldConsumption, item, BigInt(item.quantity || 0))) {
                    throw new Error("INVALID_INPUT");
                }
            }
            // Keep each historical line's price and consumption snapshot. Reductions
            // remove the newest units first; increases extend the oldest line.
            let remaining = quantity;
            const lineQuantities = matchingItems.map((item, index) => {
                const lineQuantity = index === 0 && quantity > oldQuantity
                    ? item.quantity + (quantity - oldQuantity)
                    : Math.min(item.quantity, remaining);
                remaining -= lineQuantity;
                return lineQuantity;
            });
            const newConsumption = new Map<number, bigint>();
            for (const [index, item] of matchingItems.entries()) {
                if (!accumulateItemConsumption(newConsumption, item, BigInt(lineQuantities[index]))) {
                    throw new Error("INVALID_INPUT");
                }
            }

            const supplyAdjustments = new Map<number, bigint>();
            for (const supplyID of new Set([...oldConsumption.keys(), ...newConsumption.keys()])) {
                const netDecrement = (newConsumption.get(supplyID) ?? BigInt(0)) - (oldConsumption.get(supplyID) ?? BigInt(0));
                if (!isSafeBigInt(netDecrement)) {
                    throw new Error("INVALID_INPUT");
                }
                if (netDecrement !== BigInt(0)) {
                    supplyAdjustments.set(supplyID, netDecrement);
                }
            }
            if (supplyAdjustments.size > 0) {
                const currentSupplies = await lockAndReadSupplies(tx, supplyAdjustments.keys());
                for (const sup of currentSupplies) {
                    const adj = supplyAdjustments.get(sup.id) ?? BigInt(0);
                    if (!isSafeBigInt(adj) || !isSafeBigInt(sup.currentStockMilliunits - adj)) {
                        throw new Error("INVALID_INPUT");
                    }
                }
            }

            const newSubtotals = matchingItems.map((item, index) => item.unitPriceCents * BigInt(lineQuantities[index]));
            const newSubtotal = newSubtotals.reduce((sum, subtotal) => sum + subtotal, BigInt(0));
            if (newSubtotals.some(subtotal => !isSafeBigInt(subtotal)) || !isSafeBigInt(newSubtotal)) {
                throw new Error("INVALID_INPUT");
            }
            const otherItems = await tx.sale_items.findMany({
                where: { saleID: saleId, NOT: { productID: productId } },
                select: { subtotalCents: true },
            });
            const newTotalSale = otherItems.reduce((acc, item) => acc + item.subtotalCents, newSubtotal);
            if (!isSafeBigInt(newTotalSale)) {
                throw new Error("INVALID_INPUT");
            }

            const oldTotal = sale.totalCents ?? BigInt(0);
            const totalDiff = newTotalSale - oldTotal;

            if (sale.status === "UNPAID" && sale.jornadaId != null && sale.source_type) {
                const unpaidAgg = await tx.sales.aggregate({
                    where: { jornadaId: sale.jornadaId, status: "UNPAID", source_type: sale.source_type },
                    _sum: { totalCents: true },
                });
                if (!isSafeBigInt((unpaidAgg._sum.totalCents ?? BigInt(0)) + totalDiff)) {
                    throw new Error("INVALID_INPUT");
                }
            } else if (sale.status === "DEBT" && sale.debtors && sale.debtors.status === "DEBT") {
                const debtOld = sale.debtors.amountCents;
                const debtDiff = newTotalSale - debtOld;
                const targetCustomerId = sale.customerID ?? sale.debtors.customerID;
                const [custRow, openDebtsAgg, jornadaDebtsAgg] = await Promise.all([
                    targetCustomerId
                        ? tx.customer.findUnique({ where: { id: targetCustomerId }, select: { currentBalanceCents: true } })
                        : Promise.resolve(null),
                    tx.debtors.aggregate({ where: { status: "DEBT" }, _sum: { amountCents: true } }),
                    tx.debtors.aggregate({
                        where: { createdJornadaId: sale.debtors.createdJornadaId, status: { not: "CANCELLED" } },
                        _sum: { amountCents: true },
                    }),
                ]);
                if (
                    (custRow && !isSafeBigInt(custRow.currentBalanceCents + debtDiff))
                    || !isSafeBigInt((openDebtsAgg._sum.amountCents ?? BigInt(0)) + debtDiff)
                    || !isSafeBigInt((jornadaDebtsAgg._sum.amountCents ?? BigInt(0)) + debtDiff)
                ) {
                    throw new Error("INVALID_INPUT");
                }
            }

            const sortedAdjustments = Array.from(supplyAdjustments.entries()).sort(([a], [b]) => a - b);
            for (const [supplyId, totalAdjustment] of sortedAdjustments) {
                await tx.supplies.update({
                    where: { id: supplyId },
                    data: { currentStockMilliunits: { decrement: totalAdjustment } }
                });
            }

            for (const [index, item] of matchingItems.entries()) {
                if (lineQuantities[index] === 0) {
                    await tx.sale_items.delete({ where: { id: item.id } });
                } else {
                    await tx.sale_items.update({
                        where: { id: item.id },
                        data: { quantity: lineQuantities[index], subtotalCents: newSubtotals[index] },
                    });
                }
            }

            await tx.sales.update({
                where: { id: saleId },
                data: { totalCents: newTotalSale }
            });

            // Synchronize active debt row and customer balance if the sale is in DEBT
            let revalidateDebtors = false;
            if (sale?.status === "DEBT" && sale.debtors && sale.debtors.status === "DEBT") {
                const oldTotal = sale.debtors.amountCents;
                const diff = newTotalSale - oldTotal;

                await tx.debtors.update({
                    where: { id: sale.debtors.id },
                    data: { amountCents: newTotalSale }
                });

                const targetCustomerId = sale.customerID ?? sale.debtors.customerID;
                if (targetCustomerId) {
                    await tx.customer.update({
                        where: { id: targetCustomerId },
                        data: { currentBalanceCents: { increment: diff } }
                    });
                }
                revalidateDebtors = true;
            }

            return { result: actionOk(), revalidateDebtors };
        });
    } catch (e) {
        if (e instanceof Error && e.message === "INVALID_INPUT") {
            return actionFail("INVALID_INPUT");
        }
        console.error(e);
        return actionFail("Error al actualizar cantidad");
    }

    if (txOutcome.result.success) {
        if (txOutcome.revalidateDebtors) {
            revalidatePath("/debtors");
        }
        revalidatePath("/pos");
        revalidatePath("/admin/inventory");
    }

    return txOutcome.result;
}
