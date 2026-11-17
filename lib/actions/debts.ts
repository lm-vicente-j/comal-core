"use server"
import z from "zod"
import prisma from "../prisma"
import { Sale } from "./sales";
import { revalidatePath } from "next/cache";
import { PaymentMethod, SaleStatus } from "@/app/generated/prisma/enums";
import { auth } from "../auth";
import { CustomerSchema, DebtorsSchema, PaymentMethodSchema, SalesSchema } from "./schemas";

const DebtorSchema = z.object({
    id: z.number(),
    saleID: z.number().nullable(),
    customerID: z.number().nullable(),
    amount: z.number(),
    status: z.enum(["UNPAID", "PAID", "DEBT", "CANCELLED"]),


    customer: z.object({
        id: z.number(),
        customerName: z.string().nullable(),
        phone: z.string().nullable().optional(),
        alias: z.string().nullable(),
        lastConsumption: z.date().nullable(),
        currentBalance: z.number().optional(),
        registeredDate: z.date().nullable(),
    }).nullable(),

    sales: z.array(z.object({
        id: z.number(),
        total: z.number().nullable(),
        status: z.enum(["UNPAID", "PAID", "DEBT", "CANCELLED"]),
        source_type: z.string().nullable(),
        customerID: z.number().nullable(),
        placedBy: z.number().nullable(),
        createdAt: z.date().nullable(),
        sale_items: z.array(z.object({
            quantity: z.number(),
            products: z.object({
                name: z.string().nullable()
            }).nullable()
        })).optional()
    })).optional(),
});

export type Debtor = z.infer<typeof DebtorSchema>

export async function getAllDebtors() {
    const session = await auth();
    if (!session?.user) return [];

    try {
        const rawDebts = await prisma.debtors.findMany({
            where: {
                status: SaleStatus.DEBT
            },
            include: {
                customer: session.user.role === "ADMIN" ? true : { select: { id: true, customerName: true, alias: true, lastConsumption: true, registeredDate: true } },
                sales: {
                    include: {
                        sale_items: {
                            include: {
                                products: true
                            }
                        }
                    }
                }
            },
            orderBy: {
                amount: 'desc'
            }
        });

        const groupedDebtorsMap = new Map();

        rawDebts.forEach((debt) => {
            const customerId = debt.customerID;

            if (!groupedDebtorsMap.has(customerId)) {
                groupedDebtorsMap.set(customerId, {
                    id: debt.id,
                    customerID: customerId,
                    amount: Number(debt.amount),
                    status: debt.status,
                    customer: debt.customer,
                    sales: debt.sales ? [debt.sales] : []
                });
            } else {

                const existing = groupedDebtorsMap.get(customerId);
                existing.amount += Number(debt.amount);
                if (debt.sales) {
                    existing.sales.push(debt.sales);
                }
            }
        });


        return Array.from(groupedDebtorsMap.values());

    } catch (e) {
        console.error(e);
        return [];
    }
}

export async function getDebtsSummary() {
    const session = await auth();
    if (!session?.user) return { totalAmount: 0, activeDebtors: 0, todayPayments: 0 };

    try {

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);
        
        const allDebts = await prisma.debtors.findMany({
            where: { status: "DEBT" }
        });

        const todayCollections = await prisma.debtors.findMany({
            where: {
                status: "PAID",
                paidAt: {
                    gte: startOfDay,
                    lte: endOfDay
                }
            }
        });

        const totalAmount = allDebts.reduce((acc, curr) => acc + curr.amount.toNumber(), 0);
        const activeDebtors = new Set(allDebts.map(d => d.customerID)).size;
        const todayPaymentsSum = todayCollections.reduce((acc, curr) => acc + Number(curr.amount), 0);

        return {
            totalAmount,
            activeDebtors,
            todayPayments: todayPaymentsSum
        };
    } catch (e) {
        return { totalAmount: 0, activeDebtors: 0, todayPayments: 0 };
    }
}


export async function getDebtorHistory(id: unknown) {

    const session = await auth();
    if (!session?.user) return { success: false, error: "UNAUTHORIZED" };

    const parsedId = DebtorsSchema.shape.id.safeParse(id);
    if (!parsedId.success) return { success: false, error: "INVALID_INPUT" };

    try {
        const debts = await prisma.debtors.findUnique({
            where: { id: parsedId.data }
        });

        return debts

    } catch (e) {
        return { success: false, error: "ERROR IN DB" }
    }


}

export async function toDebt(customerId: number, sales: Sale[]) {

    const session = await auth();
    if (!session?.user) return { msg: "UNAUTHORIZED" };

    const input = z.object({
        customerId: CustomerSchema.shape.id,
        sales: z.array(SalesSchema.pick({ id: true })),
    }).safeParse({ customerId, sales });
    if (!input.success) return { msg: "INVALID_INPUT" };

    try {

        // The debt is recorded against the jornada where it is granted.
        const activeJornada = await prisma.jornada.findFirst({
            where: { status: "OPEN" },
            select: { id: true },
        });
        if (!activeJornada) return { msg: "NO_OPEN_JORNADA" };

        // Only open (UNPAID) account lines can go to debt, and the amounts
        // come from the DB — the client only nominates the sale ids. This
        // keeps already-paid sales of the same day out of the conversion.
        const dbSales = await prisma.sales.findMany({
            where: { id: { in: sales.map((s) => s.id) }, status: "UNPAID" },
            select: { id: true, total: true, customerID: true },
        });

        if (dbSales.length === 0) return { msg: "NO_UNPAID_SALES" };
        if (dbSales.some((s) => s.customerID !== null && s.customerID !== customerId)) return { msg: "INVALID_INPUT" };

        const totalNewDebt = dbSales.reduce((sum, s) => sum + Number(s.total), 0);

        const now = new Date();
        const operations: any[] = [];

        dbSales.forEach((s) => {
            // The collection fields are reset in case the sale already had a
            // debtor row (upsert keeps the one-row-per-sale rule).
            const debtorData = {
                saleID: s.id,
                customerID: customerId,
                amount: s.total ?? 0,
                status: SaleStatus.DEBT,
                createdAt: now,
                createdJornadaId: activeJornada.id,
                paidAt: null,
                paidJornadaId: null,
                collectedBy: null,
            };

            operations.push(
                prisma.debtors.upsert({
                    where: { saleID: s.id },
                    update: debtorData,
                    create: debtorData,
                })
            );

            operations.push(
                prisma.sales.update({
                    where: { id: s.id },
                    data: {
                        status: "DEBT",
                        customerID: customerId
                    }
                })
            );

        })
        operations.push(
            prisma.customer.update({
                where: { id: customerId },
                data: {
                    currentBalance: { increment: totalNewDebt }
                }
            })
        );
        await prisma.$transaction(operations)
        revalidatePath("/pos")
        revalidatePath("/debtors")
        return { msg: "SUCCESS" }


    } catch (e) {
        console.error(e);
        return { msg: "INTERNAL ERROR", error: e };
    }

}

export async function payAccount(customerID: number, sales: Sale[], paymentMethod: PaymentMethod) {
    const session = await auth();
    if (!session?.user) return { msg: "UNAUTHORIZED" };

    // Attribution comes from the session, never from the client.
    const collectedBy = Number(session.user.id);
    if (!Number.isInteger(collectedBy)) return { msg: "UNAUTHORIZED" };

    const input = z.object({
        customerID: CustomerSchema.shape.id,
        sales: z.array(SalesSchema.pick({ id: true })),
        paymentMethod: PaymentMethodSchema,
    }).safeParse({ customerID, sales, paymentMethod });
    if (!input.success) return { msg: "INVALID_INPUT" };

    try {
        const now = new Date();

        // The money is received now, so the cash cut of the open jornada must
        // be able to include it.
        const activeJornada = await prisma.jornada.findFirst({
            where: { status: "OPEN" },
            select: { id: true },
        });
        if (!activeJornada) return { msg: "NO_OPEN_JORNADA" };

        // Mirror of toDebt: only sales actually in DEBT are collectable and
        // the settled amounts come from the DB, not from the client payload.
        const dbSales = await prisma.sales.findMany({
            where: { id: { in: sales.map((s) => s.id) }, status: "DEBT" },
            select: { id: true, total: true, customerID: true, debtors: { select: { customerID: true } } },
        });

        if (dbSales.length === 0) return { msg: "NO_DEBT_SALES" };
        if (dbSales.some((s) => s.customerID !== customerID || (s.debtors !== null && s.debtors.customerID !== customerID))) return { msg: "INVALID_INPUT" };

        const operations: any[] = []

        dbSales.forEach((s) => {
            const debtorData = {
                status: SaleStatus.PAID,
                paidAt: now,
                paidJornadaId: activeJornada.id,
                collectedBy,
            }

            operations.push(
                prisma.debtors.update({
                    where: { saleID: s.id },
                    data: debtorData
                })


            );

            operations.push(
                prisma.sales.update({
                    where: { id: s.id },
                    data: { status: SaleStatus.PAID, payment_method: paymentMethod }
                })
            )


        })
        const totalNewDebt = dbSales.reduce((sum, s) => sum + Number(s.total), 0);

        operations.push(
            prisma.customer.update({
                where: { id: customerID },
                data: {
                    currentBalance: { decrement: totalNewDebt }
                }
            })
        );



        await prisma.$transaction(operations)

        revalidatePath("/pos")
        revalidatePath("/debtors")
        return { msg: "SUCCESS" }

    } catch (e) {
        console.error(e);
        return { msg: "INTERNAL ERROR", error: e }
    }
}
