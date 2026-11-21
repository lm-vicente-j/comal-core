"use server"
import z from "zod"
import prisma from "../prisma"
import { lockOpenJornada } from "../ticket-reservations";
import { Sale } from "./sales";
import { revalidatePath } from "next/cache";
import { PaymentMethod, SaleStatus } from "@/app/generated/prisma/enums";
import { auth } from "../auth";
import { businessDate, timestampRange, toBusinessCalendarDate } from "../analytics";
import {
  CustomerSchema,
  DebtorsSchema,
  PaymentMethodSchema,
  SalesSchema,
  DebtorListItemSchema,
  type DebtorListItem,
} from "./schemas";
import {
  PaginationOptions,
  PaginatedResult,
  PaginationOptionsSchema,
} from "@/components/pagination";

export type { DebtorListItem };
export type Debtor = DebtorListItem;

export async function getAllDebtors(
  options?: PaginationOptions
): Promise<PaginatedResult<DebtorListItem>> {
  const session = await auth();
  if (!session?.user) return { items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 };

  // Server actions receive untrusted input. Validate each option on its own
  // and fall back to a safe default instead of letting an out-of-range value
  // throw an unhandled ZodError (which would surface as a 500).
  const raw = (options ?? {}) as Record<string, unknown>;
  const fields = PaginationOptionsSchema.shape;
  const parsedPage = fields.page.safeParse(raw.page);
  const parsedPageSize = fields.pageSize.safeParse(raw.pageSize);
  const parsedSearch = fields.search.safeParse(raw.search);

  let page = parsedPage.success ? parsedPage.data : 1;
  const pageSize = parsedPageSize.success ? parsedPageSize.data : 10;
  const search = parsedSearch.success ? parsedSearch.data : "";

  try {
    const where: any = {
    debtors: {
      some: {
        status: SaleStatus.DEBT,
        sales: { status: SaleStatus.DEBT },
      },
    },
    ...(search
      ? {
          OR: [
            { customerName: { contains: search, mode: "insensitive" } },
            { alias: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const total = await prisma.customer.count({ where });
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  if (total === 0) {
    return { items: [], total: 0, page: 1, pageSize, totalPages: 0 };
  }

  // A page beyond the end has no rows; clamp it to the last real page so the
  // caller gets the existing records instead of an empty result set.
  if (page > totalPages) page = totalPages;

  const customers = await prisma.customer.findMany({
    where,
    select: {
      id: true,
      customerName: true,
      alias: true,
      lastConsumption: true,
      registeredDate: true,
    },
    orderBy: [
      { customerName: "asc" },
      { id: "asc" },
    ],
    skip: (page - 1) * pageSize,
    take: pageSize,
  });

  const customerIds = customers.map((c) => c.id);
  const debtRows = customerIds.length > 0 ? await prisma.debtors.findMany({
    where: {
      customerID: { in: customerIds },
      status: SaleStatus.DEBT,
      sales: { status: SaleStatus.DEBT },
    },
    select: {
      customerID: true,
      amount: true,
    },
  }) : [];

  const debtSumMap = new Map<number, number>();
  for (const row of debtRows) {
    const prev = debtSumMap.get(row.customerID) ?? 0;
    debtSumMap.set(row.customerID, prev + Number(row.amount));
  }

  const items: DebtorListItem[] = customers.map((c) => ({
    customerID: c.id,
    customerName: c.customerName,
    alias: c.alias,
    lastConsumption: c.lastConsumption,
    registeredDate: c.registeredDate,
    amount: debtSumMap.get(c.id) ?? 0,
  }));

    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
    };
  } catch {
    return { items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 };
  }
}

export async function getDebtsSummary() {
  const session = await auth();
  if (!session?.user) return { totalAmount: 0, activeDebtors: 0, todayPayments: 0 };

  try {
    const today = businessDate();
    const { gte: startOfDay, lt: endOfDay } = timestampRange({ from: today, to: today });

    const [totalAgg, todayAgg, activeDebtors] = await Promise.all([
      prisma.debtors.aggregate({
        where: {
          status: SaleStatus.DEBT,
          sales: { status: SaleStatus.DEBT },
        },
        _sum: { amount: true },
      }),
      prisma.debtors.aggregate({
        where: {
          status: SaleStatus.PAID,
          paidAt: { gte: startOfDay, lt: endOfDay },
          sales: { status: SaleStatus.PAID },
        },
        _sum: { amount: true },
      }),
      prisma.customer.count({
        where: {
          debtors: {
            some: {
              status: SaleStatus.DEBT,
              sales: { status: SaleStatus.DEBT },
            },
          },
        },
      }),
    ]);

    return {
      totalAmount: Number(totalAgg._sum.amount ?? 0),
      activeDebtors,
      todayPayments: Number(todayAgg._sum.amount ?? 0),
    };
  } catch {
    return { totalAmount: 0, activeDebtors: 0, todayPayments: 0 };
  }
}

const INT4_MAX = 2_147_483_647;
const PositiveInt4Schema = z.number().int().positive().max(INT4_MAX);

export async function getCustomerDebtAccounts(customerId: unknown) {
  const session = await auth();
  if (!session?.user) return { success: false, error: "UNAUTHORIZED" };

  const parsed = PositiveInt4Schema.safeParse(customerId);
  if (!parsed.success) return { success: false, error: "INVALID_INPUT" };

  try {
    const debts = await prisma.debtors.findMany({
      where: {
        customerID: parsed.data,
        status: SaleStatus.DEBT,
        sales: { status: SaleStatus.DEBT },
      },
      select: {
        id: true,
        saleID: true,
        amount: true,
        createdAt: true,
        sales: {
          select: {
            id: true,
            source_type: true,
            createdAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return {
      success: true,
      data: debts.map((d) => ({
        id: d.id,
        saleId: d.saleID,
        amount: Number(d.amount),
        createdAt: d.createdAt.toISOString(),
        sourceType: d.sales?.source_type ?? null,
      })),
    };
  } catch {
    return { success: false, error: "DB_ERROR" };
  }
}

export async function getSaleOrderItems(saleId: unknown) {
  const session = await auth();
  if (!session?.user) return { success: false, error: "UNAUTHORIZED" };

  const parsed = PositiveInt4Schema.safeParse(saleId);
  if (!parsed.success) return { success: false, error: "INVALID_INPUT" };

  try {
    const sale = await prisma.sales.findFirst({
      where: {
        id: parsed.data,
        status: SaleStatus.DEBT,
        debtors: { status: SaleStatus.DEBT },
      },
      select: { id: true },
    });

    if (!sale) {
      return { success: false, error: "NOT_FOUND_OR_UNAUTHORIZED" };
    }

    const items = await prisma.sale_items.findMany({
      where: { saleID: parsed.data },
      select: {
        id: true,
        quantity: true,
        unitPrice: true,
        subtotal: true,
        products: {
          select: { name: true },
        },
      },
    });

    return {
      success: true,
      data: items.map((i) => ({
        id: i.id,
        quantity: i.quantity,
        productName: i.products?.name ?? "Producto",
        unitPrice: Number(i.unitPrice),
        subtotal: Number(i.subtotal),
      })),
    };
  } catch {
    return { success: false, error: "DB_ERROR" };
  }
}


export async function getDebtorHistory(id: unknown) {

    const session = await auth();
    if (!session?.user) return { success: false, error: "UNAUTHORIZED" };

    const parsedId = PositiveInt4Schema.safeParse(id);
    if (!parsedId.success) return { success: false, error: "INVALID_INPUT" };

    try {
        const debts = await prisma.debtors.findUnique({
            where: { id: parsedId.data }
        });

        if (!debts) return { success: true, data: null };

        return {
            success: true,
            data: {
                ...debts,
                amount: Number(debts.amount),
            }
        };

    } catch (e) {
        return { success: false, error: "ERROR IN DB" }
    }


}

export async function toDebt(customerId: number, sales: (Pick<Sale, "id"> & Partial<Sale>)[], expectedTotal?: number) {

    const session = await auth();
    if (!session?.user) return { msg: "UNAUTHORIZED" };

    const input = z.object({
        customerId: PositiveInt4Schema,
        sales: z.array(SalesSchema.pick({ id: true })).min(1),
        expectedTotal: z.number().nonnegative().optional(),
    }).safeParse({ customerId, sales, expectedTotal });
    if (!input.success) return { msg: "INVALID_INPUT" };

    try {
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { id: true },
        });
        if (!customer) return { msg: "INVALID_INPUT" };

        const uniqueSaleIds = new Set(sales.map((s) => s.id));
        if (uniqueSaleIds.size !== sales.length) return { msg: "INVALID_INPUT" };

        return await prisma.$transaction(async (tx) => {
            const activeJornada = await lockOpenJornada(tx);
            if (!activeJornada) return { msg: "NO_OPEN_JORNADA" };

            // Only open (UNPAID) account lines can go to debt, and the amounts
            // come from the DB — the client only nominates the sale ids. This
            // keeps already-paid sales of the same day out of the conversion.
            const dbSales = await tx.sales.findMany({
                where: { id: { in: Array.from(uniqueSaleIds) }, status: "UNPAID" },
                select: { id: true, total: true, customerID: true, jornada: { select: { status: true } } },
            });

            if (dbSales.length === 0) return { msg: "NO_UNPAID_SALES" };
            if (dbSales.length !== sales.length) return { msg: "INVALID_INPUT" };
            if (dbSales.some((s) => s.jornada?.status === "CLOSED")) return { msg: "JORNADA_CLOSED" };
            if (dbSales.some((s) => s.customerID !== null && s.customerID !== customerId)) return { msg: "INVALID_INPUT" };

            if (input.data.expectedTotal !== undefined) {
                const totalsById = new Map(dbSales.map((sale) => [sale.id, Number(sale.total)]));
                const total = sales.reduce((sum, sale) => sum + (totalsById.get(sale.id) ?? 0), 0);
                if (total !== input.data.expectedTotal) return { msg: "SALES_CHANGED" };
            }

            const now = new Date();
            const claimed: typeof dbSales = [];

            for (const s of dbSales) {
                // Atomic claim: only one concurrent caller can flip UNPAID->DEBT
                const { count } = await tx.sales.updateMany({
                    where: { id: s.id, status: "UNPAID" },
                    data: {
                        status: "DEBT",
                        customerID: customerId,
                    },
                });

                if (count === 1) {
                    claimed.push(s);
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

                    await tx.debtors.upsert({
                        where: { saleID: s.id },
                        update: debtorData,
                        create: debtorData,
                    });
                }
            }

            if (claimed.length !== sales.length) {
                throw new Error("CONCURRENT_MODIFICATION");
            }

            const totalNewDebt = claimed.reduce((sum, s) => sum + Number(s.total), 0);
            await tx.customer.update({
                where: { id: customerId },
                data: {
                    currentBalance: { increment: totalNewDebt },
                    lastConsumption: toBusinessCalendarDate(now),
                },
            });

            revalidatePath("/pos");
            revalidatePath("/debtors");
            return { msg: "SUCCESS" };
        });


    } catch (e: any) {
        if (e?.message === "CONCURRENT_MODIFICATION") {
            return { msg: "NO_UNPAID_SALES" };
        }
        console.error(e);
        return { msg: "INTERNAL ERROR" };
    }

}

export async function payAccount(customerID: number, sales: (Pick<Sale, "id"> & Partial<Sale>)[], paymentMethod: PaymentMethod) {
    const session = await auth();
    if (!session?.user) return { msg: "UNAUTHORIZED" };

    // Attribution comes from the session, never from the client.
    const collectedBy = Number(session.user.id);
    if (!Number.isInteger(collectedBy) || collectedBy <= 0 || collectedBy > INT4_MAX) return { msg: "UNAUTHORIZED" };

    const input = z.object({
        customerID: PositiveInt4Schema,
        sales: z.array(SalesSchema.pick({ id: true })).min(1),
        paymentMethod: PaymentMethodSchema,
    }).safeParse({ customerID, sales, paymentMethod });
    if (!input.success) return { msg: "INVALID_INPUT" };

    try {
        const now = new Date();

        // The money is received now, so the cash cut of the open jornada must
        // be able to include it.
        const uniqueSaleIds = new Set(sales.map((s) => s.id));
        if (uniqueSaleIds.size !== sales.length) return { msg: "INVALID_INPUT" };

        // The whole read-claim-write sequence runs inside one interactive
        // transaction. Two concurrent payments can both read the sale as DEBT,
        // but only the one whose conditional update actually flips DEBT->PAID
        // is allowed to decrement the customer balance. This removes the
        // double-decrement race that left balances negative.
        return await prisma.$transaction(async (tx) => {
            const activeJornada = await lockOpenJornada(tx);
            if (!activeJornada) return { msg: "NO_OPEN_JORNADA" };

            const dbSales = await tx.sales.findMany({
                where: { id: { in: Array.from(uniqueSaleIds) }, status: "DEBT" },
                select: {
                    id: true,
                    total: true,
                    customerID: true,
                    debtors: { select: { customerID: true, status: true, amount: true } },
                },
            });

            if (dbSales.length === 0) return { msg: "NO_DEBT_SALES" };
            if (dbSales.length !== sales.length) return { msg: "INVALID_INPUT" };
            if (
                dbSales.some(
                    (s) =>
                        !s.debtors ||
                        s.customerID !== customerID ||
                        s.debtors.customerID !== customerID ||
                        s.debtors.status !== SaleStatus.DEBT
                )
            ) {
                return { msg: "INVALID_INPUT" };
            }

            const claimed: typeof dbSales = [];
            for (const s of dbSales) {
                // Atomic claim: the WHERE status guard means only one
                // concurrent transaction can succeed for a given sale.
                const { count } = await tx.sales.updateMany({
                    where: { id: s.id, status: "DEBT" },
                    data: { status: SaleStatus.PAID, payment_method: paymentMethod },
                });
                if (count === 1) claimed.push(s);
            }

            if (claimed.length !== sales.length) {
                throw new Error("CONCURRENT_MODIFICATION");
            }

            for (const s of claimed) {
                await tx.debtors.updateMany({
                    where: { saleID: s.id, status: SaleStatus.DEBT },
                    data: {
                        status: SaleStatus.PAID,
                        paidAt: now,
                        paidJornadaId: activeJornada.id,
                        collectedBy,
                    },
                });
            }

            const totalNewDebt = claimed.reduce((sum, s) => sum + Number(s.debtors?.amount ?? s.total ?? 0), 0);
            await tx.customer.update({
                where: { id: customerID },
                data: { currentBalance: { decrement: totalNewDebt } },
            });

            revalidatePath("/pos")
            revalidatePath("/debtors")
            return { msg: "SUCCESS" }
        });

    } catch (e: any) {
        if (e?.message === "CONCURRENT_MODIFICATION") {
            return { msg: "NO_DEBT_SALES" };
        }
        console.error(e);
        return { msg: "INTERNAL ERROR" };
    }
}
