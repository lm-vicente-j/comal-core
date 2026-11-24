"use server"
import { toSafeInteger } from "@/lib/scaled-values";
import z from "zod"
import prisma from "../prisma"
import { lockOpenJornada } from "../ticket-reservations";
import { Sale } from "./sales";
import { revalidatePath } from "next/cache";
import { PaymentMethod, SaleStatus } from "@/app/generated/prisma/enums";
import { auth } from "../auth";
import { actionFail, actionOk, type ActionResult } from "../action-result";
import { businessDate, timestampRange, toBusinessCalendarDate } from "../analytics";
import {
  CustomerSchema,
  DebtorsSchema,
  PaymentMethodSchema,
  SalesSchema,
  DebtorListItemSchema,
  type DebtorListItem,
} from "./schemas";
import { createPaginationSchema, getPaginationMeta, getPaginationOffset, escapeListSearch, type PageResult } from "@/lib/pagination";
import { Prisma } from "@/app/generated/prisma/client";

export type { DebtorListItem };
export type Debtor = DebtorListItem;

const DebtorsPaginationSchema = createPaginationSchema({
  sortFields: ["customerName"], defaultSort: "customerName", defaultOrder: "asc",
  filters: z.object({}).strict(),
});

export async function getAllDebtors(options: unknown = {}): Promise<PageResult<DebtorListItem>> {
  const session = await auth();
  if (!session?.user) return actionFail("UNAUTHENTICATED");
  const parsed = DebtorsPaginationSchema.safeParse(options);
  if (!parsed.success) return actionFail("INVALID_INPUT");
  const { search, order = "asc" } = parsed.data;
  const term = escapeListSearch(search);
  // Materialize distinct customer IDs once. A correlated EXISTS can regress
  // badly when estimates change after bulk imports or deletes.
  const activeDebtors = Prisma.sql`WITH active_debtors AS MATERIALIZED (
    SELECT DISTINCT d."customerID" FROM debtors d
    JOIN sales s ON s.id = d."saleID"
    WHERE d.status = 'DEBT' AND s.status = 'DEBT'
  )`;
  const matchingCustomers = Prisma.sql`FROM customer c JOIN active_debtors a ON a."customerID" = c.id
    ${term ? Prisma.sql`WHERE c."customerName" ILIKE ${`%${term}%`} OR c.alias ILIKE ${`%${term}%`}` : Prisma.empty}`;
  const direction = order === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  try {
    return await prisma.$transaction(async tx => {
      const [count] = await tx.$queryRaw<{ total: bigint }[]>(Prisma.sql`${activeDebtors} SELECT COUNT(*)::bigint AS total ${matchingCustomers}`);
      const total = toSafeInteger(count.total);
      const meta = getPaginationMeta(total, parsed.data);
      if (!total) return actionOk({ ...meta, items: [] });
      const customers = await tx.$queryRaw<{
        id: number; customerName: string | null; alias: string | null;
        lastConsumption: Date | null; registeredDate: Date | null;
      }[]>(Prisma.sql`${activeDebtors}
        SELECT c.id, c."customerName", c.alias, c."lastConsumption", c."registeredDate"
        ${matchingCustomers}
        ORDER BY c."customerName" ${direction}, c.id ${direction}
        LIMIT ${meta.pageSize} OFFSET ${getPaginationOffset(meta)}
      `);
      const debts = await tx.debtors.groupBy({
        by: ["customerID"],
        where: { customerID: { in: customers.map(customer => customer.id) }, status: SaleStatus.DEBT, sales: { status: SaleStatus.DEBT } },
        _sum: { amountCents: true },
      });
      const sums = new Map(debts.map(debt => [debt.customerID, toSafeInteger(debt._sum.amountCents ?? BigInt(0))]));
      return actionOk({ ...meta, items: customers.map(customer => ({
        customerID: customer.id, customerName: customer.customerName, alias: customer.alias,
        lastConsumption: customer.lastConsumption, registeredDate: customer.registeredDate,
        amount: sums.get(customer.id) ?? 0,
      })) });
    }, { isolationLevel: "RepeatableRead" });
  } catch {
    return actionFail("QUERY_FAILED");
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
        _sum: { amountCents: true },
      }),
      prisma.debtors.aggregate({
        where: {
          status: SaleStatus.PAID,
          paidAt: { gte: startOfDay, lt: endOfDay },
          sales: { status: SaleStatus.PAID },
        },
        _sum: { amountCents: true },
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
      totalAmount: toSafeInteger(totalAgg._sum.amountCents ?? 0),
      activeDebtors,
      todayPayments: toSafeInteger(todayAgg._sum.amountCents ?? 0),
    };
  } catch {
    return { totalAmount: 0, activeDebtors: 0, todayPayments: 0 };
  }
}

const INT4_MAX = 2_147_483_647;
const PositiveInt4Schema = z.number().int().positive().max(INT4_MAX);

type CustomerDebtAccount = {
  id: number;
  saleId: number;
  amount: number;
  createdAt: string;
  sourceType: string | null;
};

type SaleOrderItem = {
  id: number;
  quantity: number;
  productName: string;
  unitPrice: number;
  subtotal: number;
};

export async function getCustomerDebtAccounts(
  customerId: unknown
): Promise<ActionResult<CustomerDebtAccount[]>> {
  const session = await auth();
  if (!session?.user) return actionFail("UNAUTHORIZED");

  const parsed = PositiveInt4Schema.safeParse(customerId);
  if (!parsed.success) return actionFail("INVALID_INPUT");

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
        amountCents: true,
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

    return actionOk(
      debts.map((d) => ({
        id: d.id,
        saleId: d.saleID,
        amount: toSafeInteger(d.amountCents),
        createdAt: d.createdAt.toISOString(),
        sourceType: d.sales?.source_type ?? null,
      }))
    );
  } catch {
    return actionFail("DB_ERROR");
  }
}

export async function getSaleOrderItems(
  saleId: unknown
): Promise<ActionResult<SaleOrderItem[]>> {
  const session = await auth();
  if (!session?.user) return actionFail("UNAUTHORIZED");

  const parsed = PositiveInt4Schema.safeParse(saleId);
  if (!parsed.success) return actionFail("INVALID_INPUT");

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
      return actionFail("NOT_FOUND_OR_UNAUTHORIZED");
    }

    const items = await prisma.sale_items.findMany({
      where: { saleID: parsed.data },
      select: {
        id: true,
        quantity: true,
        unitPriceCents: true,
        subtotalCents: true,
        products: {
          select: { name: true },
        },
      },
    });

    return actionOk(
      items.map((i) => ({
        id: i.id,
        quantity: i.quantity,
        productName: i.products?.name ?? "Producto",
        unitPrice: toSafeInteger(i.unitPriceCents),
        subtotal: toSafeInteger(i.subtotalCents),
      }))
    );
  } catch {
    return actionFail("DB_ERROR");
  }
}


export async function getDebtorHistory(id: unknown) {

    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    const parsedId = PositiveInt4Schema.safeParse(id);
    if (!parsedId.success) return actionFail("INVALID_INPUT");

    try {
        const debts = await prisma.debtors.findUnique({
            where: { id: parsedId.data }
        });

        if (!debts) return actionOk(null);

        const { amountCents, ...rest } = debts;
        return actionOk({ ...rest, amount: toSafeInteger(amountCents) });

    } catch (e) {
        return actionFail("ERROR IN DB");
    }


}

export async function toDebt(
    customerId: number,
    sales: (Pick<Sale, "id"> & Partial<Sale>)[],
    expectedTotal?: number
): Promise<ActionResult> {

    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    const input = z.object({
        customerId: PositiveInt4Schema,
        sales: z.array(SalesSchema.pick({ id: true })).min(1),
        expectedTotal: z.number().int().safe().nonnegative().optional(),
    }).safeParse({ customerId, sales, expectedTotal });
    if (!input.success) return actionFail("INVALID_INPUT");

    try {
        const customer = await prisma.customer.findUnique({
            where: { id: customerId },
            select: { id: true },
        });
        if (!customer) return actionFail("INVALID_INPUT");

        const uniqueSaleIds = new Set(sales.map((s) => s.id));
        if (uniqueSaleIds.size !== sales.length) return actionFail("INVALID_INPUT");

        return await prisma.$transaction(async (tx): Promise<ActionResult> => {
            const activeJornada = await lockOpenJornada(tx);
            if (!activeJornada) return actionFail("NO_OPEN_JORNADA");

            // Only open (UNPAID) account lines can go to debt, and the amounts
            // come from the DB — the client only nominates the sale ids. This
            // keeps already-paid sales of the same day out of the conversion.
            const dbSales = await tx.sales.findMany({
                where: { id: { in: Array.from(uniqueSaleIds) }, status: "UNPAID" },
                select: { id: true, totalCents: true, customerID: true, jornada: { select: { status: true } } },
            });

            if (dbSales.length === 0) return actionFail("NO_UNPAID_SALES");
            if (dbSales.length !== sales.length) return actionFail("INVALID_INPUT");
            if (dbSales.some((s) => s.jornada?.status === "CLOSED")) return actionFail("JORNADA_CLOSED");
            if (dbSales.some((s) => s.customerID !== null && s.customerID !== customerId)) return actionFail("INVALID_INPUT");

            if (input.data.expectedTotal !== undefined) {
                const total = dbSales.reduce((sum, sale) => sum + (sale.totalCents ?? BigInt(0)), BigInt(0));
                if (total !== BigInt(input.data.expectedTotal)) return actionFail("SALES_CHANGED");
            }

            const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
            const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
            const isSafeBigInt = (v: bigint) => v >= minSafe && v <= maxSafe;
            const pendingDebtSum = dbSales.reduce((sum, sale) => sum + (sale.totalCents ?? BigInt(0)), BigInt(0));
            const [customerRow, openDebtAgg, jornadaDebtAgg] = await Promise.all([
                tx.customer.findUnique({ where: { id: customerId }, select: { currentBalanceCents: true } }),
                tx.debtors.aggregate({ where: { status: "DEBT" }, _sum: { amountCents: true } }),
                tx.debtors.aggregate({
                    where: { createdJornadaId: activeJornada.id, status: { not: "CANCELLED" } },
                    _sum: { amountCents: true },
                }),
            ]);
            if (
                !isSafeBigInt(pendingDebtSum)
                || !isSafeBigInt((customerRow?.currentBalanceCents ?? BigInt(0)) + pendingDebtSum)
                || !isSafeBigInt((openDebtAgg._sum.amountCents ?? BigInt(0)) + pendingDebtSum)
                || !isSafeBigInt((jornadaDebtAgg._sum.amountCents ?? BigInt(0)) + pendingDebtSum)
            ) {
                return actionFail("INVALID_INPUT");
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
                        amountCents: s.totalCents ?? BigInt(0),
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

            const totalNewDebt = claimed.reduce((sum, s) => sum + (s.totalCents ?? BigInt(0)), BigInt(0));
            await tx.customer.update({
                where: { id: customerId },
                data: {
                    currentBalanceCents: { increment: totalNewDebt },
                    lastConsumption: toBusinessCalendarDate(now),
                },
            });

            revalidatePath("/pos");
            revalidatePath("/debtors");
            return actionOk();
        });


    } catch (e: any) {
        if (e?.message === "CONCURRENT_MODIFICATION") {
            return actionFail("NO_UNPAID_SALES");
        }
        console.error(e);
        return actionFail("INTERNAL ERROR");
    }

}

export async function payAccount(
    customerID: number,
    sales: (Pick<Sale, "id"> & Partial<Sale>)[],
    paymentMethod: PaymentMethod
): Promise<ActionResult> {
    const session = await auth();
    if (!session?.user) return actionFail("UNAUTHORIZED");

    // Attribution comes from the session, never from the client.
    const collectedBy = Number(session.user.id);
    if (!Number.isInteger(collectedBy) || collectedBy <= 0 || collectedBy > INT4_MAX) return actionFail("UNAUTHORIZED");

    const input = z.object({
        customerID: PositiveInt4Schema,
        sales: z.array(SalesSchema.pick({ id: true })).min(1),
        paymentMethod: PaymentMethodSchema,
    }).safeParse({ customerID, sales, paymentMethod });
    if (!input.success) return actionFail("INVALID_INPUT");

    try {
        const now = new Date();

        // The money is received now, so the cash cut of the open jornada must
        // be able to include it.
        const uniqueSaleIds = new Set(sales.map((s) => s.id));
        if (uniqueSaleIds.size !== sales.length) return actionFail("INVALID_INPUT");

        // The whole read-claim-write sequence runs inside one interactive
        // transaction. Two concurrent payments can both read the sale as DEBT,
        // but only the one whose conditional update actually flips DEBT->PAID
        // is allowed to decrement the customer balance. This removes the
        // double-decrement race that left balances negative.
        return await prisma.$transaction(async (tx): Promise<ActionResult> => {
            const activeJornada = await lockOpenJornada(tx);
            if (!activeJornada) return actionFail("NO_OPEN_JORNADA");

            const dbSales = await tx.sales.findMany({
                where: { id: { in: Array.from(uniqueSaleIds) }, status: "DEBT" },
                select: {
                    id: true,
                    totalCents: true,
                    customerID: true,
                    jornadaId: true,
                    placedBy: true,
                    debtors: { select: { customerID: true, status: true, amountCents: true } },
                },
            });

            if (dbSales.length === 0) return actionFail("NO_DEBT_SALES");
            if (dbSales.length !== sales.length) return actionFail("INVALID_INPUT");
            if (
                dbSales.some(
                    (s) =>
                        !s.debtors ||
                        s.customerID !== customerID ||
                        s.debtors.customerID !== customerID ||
                        s.debtors.status !== SaleStatus.DEBT
                )
            ) {
                return actionFail("INVALID_INPUT");
            }

            const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
            const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
            const isSafeBigInt = (v: bigint) => v >= minSafe && v <= maxSafe;
            const totalToCollect = dbSales.reduce((sum, s) => sum + (s.debtors?.amountCents ?? s.totalCents ?? BigInt(0)), BigInt(0));
            const today = businessDate(now);
            const todayRange = timestampRange({ from: today, to: today });

            const empDeltasByJornada = new Map<string, { jornadaId: number; placedBy: number; delta: bigint }>();
            for (const s of dbSales) {
                if (s.jornadaId == null) continue;
                const key = `${s.jornadaId}:${s.placedBy}`;
                const existing = empDeltasByJornada.get(key) ?? { jornadaId: s.jornadaId, placedBy: s.placedBy, delta: BigInt(0) };
                existing.delta += s.totalCents ?? BigInt(0);
                empDeltasByJornada.set(key, existing);
            }
            const affectedJornadaIds = Array.from(new Set(Array.from(empDeltasByJornada.values()).map((e) => e.jornadaId)));
            const affectedEmpIds = Array.from(new Set(Array.from(empDeltasByJornada.values()).map((e) => e.placedBy)));

            const [
                jornadaRow,
                methodSalesAgg,
                methodDebtAgg,
                methodBillsAgg,
                methodSalariesAgg,
                depositsAgg,
                todayPaymentsAgg,
                customerRow,
                existingEmpPaid,
            ] = await Promise.all([
                tx.jornada.findUnique({ where: { id: activeJornada.id }, select: { openingAmountCents: true } }),
                tx.sales.aggregate({
                    where: { jornadaId: activeJornada.id, status: "PAID", debtors: { is: null }, payment_method: paymentMethod },
                    _sum: { totalCents: true },
                }),
                tx.debtors.aggregate({
                    where: { paidJornadaId: activeJornada.id, status: "PAID", sales: { status: "PAID", payment_method: paymentMethod } },
                    _sum: { amountCents: true },
                }),
                tx.bill.aggregate({ where: { jornadaId: activeJornada.id, payment_method: paymentMethod }, _sum: { amountCents: true } }),
                tx.salary.aggregate({ where: { jornadaId: activeJornada.id, payment_method: paymentMethod }, _sum: { amountCents: true } }),
                paymentMethod === "CASH"
                    ? tx.savings_movement.aggregate({ where: { jornadaId: activeJornada.id, type: "DEPOSIT" }, _sum: { amountCents: true } })
                    : Promise.resolve({ _sum: { amountCents: null } }),
                tx.debtors.aggregate({
                    where: { status: SaleStatus.PAID, paidAt: todayRange },
                    _sum: { amountCents: true },
                }),
                tx.customer.findUnique({ where: { id: customerID }, select: { currentBalanceCents: true } }),
                affectedJornadaIds.length > 0
                    ? tx.sales.groupBy({
                        by: ["jornadaId", "placedBy"],
                        where: {
                            jornadaId: { in: affectedJornadaIds },
                            placedBy: { in: affectedEmpIds },
                            status: "PAID",
                        },
                        _sum: { totalCents: true },
                    })
                    : Promise.resolve([]),
            ]);

            const existingEmpMap = new Map(
                existingEmpPaid.map((row) => [`${row.jornadaId}:${row.placedBy}`, row._sum.totalCents ?? BigInt(0)])
            );
            for (const [key, { delta }] of empDeltasByJornada) {
                if (!isSafeBigInt((existingEmpMap.get(key) ?? BigInt(0)) + delta)) {
                    return actionFail("INVALID_INPUT");
                }
            }

            const nextMethodDebt = (methodDebtAgg._sum.amountCents ?? BigInt(0)) + totalToCollect;
            const nextExpected = (paymentMethod === "CASH" ? (jornadaRow?.openingAmountCents ?? BigInt(0)) : BigInt(0))
                + (methodSalesAgg._sum.totalCents ?? BigInt(0))
                + nextMethodDebt
                - (methodBillsAgg._sum.amountCents ?? BigInt(0))
                - (methodSalariesAgg._sum.amountCents ?? BigInt(0))
                - (depositsAgg._sum.amountCents ?? BigInt(0));
            const nextTodayPayments = (todayPaymentsAgg._sum.amountCents ?? BigInt(0)) + totalToCollect;
            const nextCustomerBalance = (customerRow?.currentBalanceCents ?? BigInt(0)) - totalToCollect;

            if (
                !isSafeBigInt(totalToCollect)
                || !isSafeBigInt(nextMethodDebt)
                || !isSafeBigInt(nextExpected)
                || !isSafeBigInt(nextTodayPayments)
                || !isSafeBigInt(nextCustomerBalance)
            ) {
                return actionFail("INVALID_INPUT");
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

            const totalNewDebt = claimed.reduce((sum, s) => sum + (s.debtors?.amountCents ?? s.totalCents ?? BigInt(0)), BigInt(0));
            await tx.customer.update({
                where: { id: customerID },
                data: { currentBalanceCents: { decrement: totalNewDebt } },
            });

            revalidatePath("/pos");
            revalidatePath("/debtors");
            return actionOk();
        });

    } catch (e: any) {
        if (e?.message === "CONCURRENT_MODIFICATION") {
            return actionFail("NO_DEBT_SALES");
        }
        console.error(e);
        return actionFail("INTERNAL ERROR");
    }
}
