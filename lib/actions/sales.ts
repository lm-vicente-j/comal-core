"use server"

import z, { success, treeifyError } from "zod";
import prisma from "../prisma";
import { revalidatePath } from "next/cache";
import { auth } from "../auth";
import { isAdmin } from "../permissions";
import { PaymentMethodSchema, SaleItemsSchema, SaleStatusSchema, SalesSchema } from "./schemas";
import {
    FREE_SALE_SOURCE,
    FREE_TICKET_PREFIX,
    freeTicketNumber,
    freeTicketSource,
    isFreeTicket,
    nextFreeTicketNumber,
} from "../pos-source";

const SaleSchema = z.object({
    id: z.number().int(),
    customerID: z.number().int().nullable().optional(),
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

export type Sale = z.infer<typeof SaleSchema>;

export async function createSale(sale_items: { productID: number, quantity: number }[], status: "UNPAID" | "PAID" | "DEBT", source_type: string, customerID: number, paymentMethod: "CASH" | "TRANSFER" = "CASH") {
    const session = await auth();
    if (!session?.user) return { success: false, error: "UNAUTHORIZED" };

    const placedBy = Number(session.user.id);
    if (!Number.isInteger(placedBy)) return { success: false, error: "UNAUTHORIZED" };

    // Server actions receive whatever the client sends; the TS types are not enough.
    const input = z.object({
        sale_items: z.array(SaleItemsSchema.pick({ productID: true, quantity: true })).min(1),
        status: SaleStatusSchema.exclude(["CANCELLED"]),
        source_type: SalesSchema.shape.source_type,
        customerID: SalesSchema.shape.customerID,
        paymentMethod: PaymentMethodSchema,
    }).safeParse({ sale_items, status, source_type, customerID, paymentMethod });
    if (!input.success) {
        return { success: false, error: "INVALID_INPUT", fieldErrors: z.flattenError(input.error).fieldErrors };
    }

    if (status === "DEBT" && (!customerID || customerID <= 0)) {
        return { success: false, error: "INVALID_INPUT" };
    }

    if (customerID < -1) {
        return { success: false, error: "INVALID_INPUT" };
    }

    if (customerID > 0) {
        const customer = await prisma.customer.findUnique({
            where: { id: customerID },
            select: { id: true },
        });
        if (!customer) {
            return { success: false, error: "INVALID_INPUT" };
        }
    }

    let transactionResult;

    try {
        transactionResult = await prisma.$transaction(async (tx) => {
            // 1. Fetch Open Jornada
            const activeJornada = await tx.jornada.findFirst({
                where: { status: "OPEN" }
            });

            if (!activeJornada) {
                // Notice this returns an object, it doesn't throw, so it won't hit the catch block
                return { success: false, error: "NO_OPEN_JORNADA", message: "NO_OPEN_JORNADA" }; 
            }

            // 2. Pre-fetch ALL products in a single database query
            const productIDs = sale_items.map((item) => item.productID);
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
            for (const item of sale_items) {
                const product = productMap.get(item.productID);
                if (!product) throw new Error("PRODUCT_NOT_FOUND"); 

                const subtotal = product.price.toNumber() * item.quantity;
                totalSale += subtotal;

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
                    }
                }
            }

            // 4. REGISTER SALE (Must happen first to get newSale.id)
            const newSale = await tx.sales.create({
                data: {
                    total: totalSale,
                    status: status,
                    source_type: source_type,
                    customerID: (customerID === -1 || customerID === 0 || !customerID) ? undefined : customerID,
                    placedBy: placedBy,
                    payment_method: status === "PAID" ? paymentMethod : null,
                    jornadaId: activeJornada.id,
                    sale_items: {
                        create: itemsToInsert
                    }
                }
            });

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
                    lastConsumption: new Date().toISOString()
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

            return { success: true, saleId: newSale.id, message: "success" };
        });

    } catch (e) {
        console.error("createSale failed:", e);
        if (e instanceof Error && e.message === "PRODUCT_NOT_FOUND") {
            return { success: false, message: "PRODUCT_NOT_FOUND" };
        }
        return { success: false, message: "INTERNAL ERROR" };
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
// `sourceType` without a cast.
type NextTicketResult =
    | { success: true; sourceType: string }
    | { success: false; message: string };

/**
 * Source type for a new walk-in ticket: the lowest number not already taken
 * by an open one, so several walk-in accounts can be served at the same time.
 *
 * The number is assigned here and not in the browser on purpose: tickets can
 * be opened from more than one terminal, and the POS only refreshes its copy
 * of the sales every few seconds, so a client-side guess could hand the same
 * number to two customers.
 */
export async function nextFreeSaleTicket(): Promise<NextTicketResult> {
    const session = await auth();
    if (!session?.user) return { success: false, message: "UNAUTHORIZED" };

    const activeJornada = await prisma.jornada.findFirst({
        where: { status: "OPEN" },
        select: { id: true }
    });

    if (!activeJornada) {
        return { success: false, message: "NO_OPEN_JORNADA" };
    }

    const openTickets = await prisma.sales.findMany({
        where: {
            jornadaId: activeJornada.id,
            status: "UNPAID",
            source_type: { startsWith: FREE_TICKET_PREFIX }
        },
        distinct: ["source_type"],
        select: { source_type: true }
    });

    const taken = openTickets
        .map((t) => freeTicketNumber(t.source_type ?? ""))
        .filter((n): n is number => n !== null);

    return { success: true, sourceType: freeTicketSource(nextFreeTicketNumber(taken)) };
}

export async function closeAccountAction(sourceType: string, paymentMethod: "CASH" | "TRANSFER" = "CASH") {
    const session = await auth();
    if (!session?.user) return { success: false, message: "UNAUTHORIZED" };

    const input = z.object({
        sourceType: SalesSchema.shape.source_type,
        paymentMethod: PaymentMethodSchema,
    }).safeParse({ sourceType, paymentMethod });
    if (!input.success) return { success: false, message: "INVALID_INPUT" };

    try {
        // Scoped to the open jornada: "MESA_4" names a table, not one
        // account, so without this filter stale unpaid sales from past
        // jornadas would silently flip to PAID with today's payment
        // method, corrupting past closing reports. Leftovers from other
        // jornadas stay visible for an admin to resolve explicitly.
        const activeJornada = await prisma.jornada.findFirst({
            where: { status: "OPEN" },
            select: { id: true }
        });

        if (!activeJornada) {
            return { success: false, message: "NO_OPEN_JORNADA" };
        }

        const { count } = await prisma.sales.updateMany({
            where: {
                source_type: sourceType,
                status: "UNPAID",
                jornadaId: activeJornada.id
            },
            data: {
                status: "PAID",
                payment_method: paymentMethod,
                // A walk-in ticket is a number handed out for the length of one
                // account, not a real origin: once charged the sale goes back to
                // plain VENTA_LIBRE, so history and reports group walk-in sales
                // exactly as before tickets existed and the number is reusable.
                ...(isFreeTicket(sourceType) ? { source_type: FREE_SALE_SOURCE } : {}),
            }
        });

        if (count === 0) {
            const staleSale = await prisma.sales.findFirst({
                where: {
                    source_type: sourceType,
                    status: "UNPAID",
                },
                select: { id: true }
            });
            if (staleSale) {
                return { success: false, message: "DIFFERENT_JORNADA" };
            }
        }

        revalidatePath("/pos");
        return { success: true, count };
    } catch (e) {
        console.error(e);
        return { success: false, message: "Error al cerrar la cuenta" };
    }
}

export async function getSalesHistory() {
    const session = await auth();
    if (!session?.user) return [];

    const sales = await prisma.sales.findMany({
        include: {
            customer: isAdmin(session.user.role) ? true : { select: { id: true, customerName: true, alias: true, lastConsumption: true, registeredDate: true } },
            // Never expose credentials to the client. Only identity/display
            // fields are needed to render who placed a sale.
            users: { select: { id: true, name: true, email: true, username: true, role: true, registeredAt: true, active: true } },
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

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const sales = await prisma.sales.findMany({
        where: {
            createdAt: {
                gte: startOfDay,
                lte: endOfDay,
            },
            // Cancelled sales stay in the DB for auditing but leave the
            // POS "pedidos recientes" list, so deleting a line visibly works.
            status: { not: "CANCELLED" },
        },
        // Only what the POS renders: the full customer/users rows were
        // transferred on every reload and nothing in /pos reads them.
        select: {
            id: true,
            customerID: true,
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

export async function cancelSaleAction(saleId: number) {
    const session = await auth();
    if (!session?.user) return { success: false, error: "UNAUTHORIZED" };

    if (!SalesSchema.shape.id.safeParse(saleId).success) return { success: false, error: "INVALID_INPUT" };

    try {
        return await prisma.$transaction(async (tx) => {
            const sale = await tx.sales.findUnique({
                where: { id: saleId },
                include: {
                    sale_items: { include: { products: { include: { recipes: true } } } },
                    debtors: true,
                }
            });

            if (!sale || sale.status === "CANCELLED") return { error: "INVALID SALE" };

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
            return { success: true };
        });
    } catch (error) {
        return { success: false, error: "INTERNAL ERROR" };
    }
}

export async function updateSaleQuantity(saleId: number, quantity: number, productId: number) {

    const session = await auth();
    if (!session?.user) return { success: false, message: "UNAUTHORIZED" };

    const input = z.object({
        saleId: SalesSchema.shape.id,
        productId: SaleItemsSchema.shape.productID,
        quantity: SaleItemsSchema.shape.quantity,
    }).safeParse({ saleId, productId, quantity });
    if (!input.success) return { success: false, message: "INVALID_INPUT" };

    try {
        return await prisma.$transaction(async (tx) => {
            const sale = await tx.sales.findUnique({
                where: { id: saleId },
                include: { debtors: true }
            });
            if (!sale) return { success: false, message: "NOT FOUND SALE" };
            if (sale.status === "CANCELLED") {
                return { success: false, message: "CANNOT_MODIFY_CANCELLED_SALE" };
            }

            const currentItem = await tx.sale_items.findFirst({
                where: { saleID: saleId, productID: productId },
                include: { products: { include: { recipes: true } } }
            });

            if (!currentItem || !currentItem.products) throw new Error("NOT FOUND ITEM");

            const oldQuantity = currentItem.quantity ? currentItem.quantity : 0;
            const quantityDiff = quantity - oldQuantity;

            for (const recipe of currentItem.products.recipes) {
                if (recipe.quantityUsed) {
                    const totalAdjustment = Number(recipe.quantityUsed) * quantityDiff;
                    await tx.supplies.update({
                        where: { id: recipe.supplyID },
                        data: { currentStock: { decrement: totalAdjustment } }
                    });
                }
            }

            const newSubtotal = currentItem.unitPrice.toNumber() * quantity;
            await tx.sale_items.updateMany({
                where: { saleID: saleId, productID: productId },
                data: {
                    quantity: quantity,
                    subtotal: newSubtotal
                }
            });

            const allItems = await tx.sale_items.findMany({
                where: { saleID: saleId }
            });
            const newTotalSale = allItems.reduce((acc, item) => acc + Number(item.subtotal), 0);

            await tx.sales.update({
                where: { id: saleId },
                data: { total: newTotalSale }
            });

            // Synchronize active debt row and customer balance if the sale is in DEBT
            if (sale?.status === "DEBT" && sale.debtors && sale.debtors.status === "DEBT") {
                const oldTotal = Number(sale.total ?? 0);
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
            return { success: true };
        });
    } catch (e) {
        console.error(e);
        return { success: false, message: "Error al actualizar cantidad" };
    }
}
