import type { Prisma } from "../app/generated/prisma/client";
import prisma from "./prisma";
import { toSafeInteger } from "./scaled-values";

/**
 * Cash cut of one jornada. Single source of truth for the expected cash: the
 * live summary and the close action both call it, so they cannot drift apart.
 *
 * Every PAID sale, bill and salary carries a payment method, so each amount
 * lands in exactly one of the cash and transfer sides.
 * Debts are attributed to the jornada where the money was received
 * (debtors.paidJornadaId), never to the jornada of the original sale.
 */
export type JornadaCashSummary = {
  // Cash side: what should be physically in the drawer.
  cashSales: number;
  debtCollectedCash: number;
  cashBills: number;
  cashSalaries: number;
  // Savings deposits move cash from the drawer to the pool.
  savingsOut: number;
  expectedCash: number;
  // Transfer side: same structure as the cash side, but with no opening
  // amount (each jornada starts at zero) and no physical count yet.
  transferSales: number;
  debtCollectedTransfer: number;
  transferBills: number;
  transferSalaries: number;
  expectedTransfer: number;
  // Debt overview: granted in this jornada, and still unpaid overall.
  debtCreated: number;
  debtPending: number;
};

/** New sales use the jornada where payment was received; null falls back to
 * sale creation jornada for legacy rows without fabricated collection data. */
export function paidSalesForJornadaWhere(
  jornadaId: number,
): Prisma.salesWhereInput {
  return {
    OR: [{ paidJornadaId: jornadaId }, { paidJornadaId: null, jornadaId }],
  };
}

export async function getJornadaCashSummary(
  jornadaId: number,
  openingAmount: number,
  db: Prisma.TransactionClient = prisma,
): Promise<JornadaCashSummary> {
  const [
    cashSales,
    transferSales,
    debtCash,
    debtTransfer,
    cashBills,
    transferBills,
    cashSalaries,
    transferSalaries,
    deposits,
    debtCreated,
    debtPending,
  ] = await Promise.all([
    // Sales with a debt record are excluded: they are counted once, as
    // debt collections, in the jornada where they were actually paid.
    db.sales.aggregate({
      where: {
        ...paidSalesForJornadaWhere(jornadaId),
        status: "PAID",
        debtors: { is: null },
        payment_method: "CASH",
      },
      _sum: { totalCents: true },
    }),
    db.sales.aggregate({
      where: {
        ...paidSalesForJornadaWhere(jornadaId),
        status: "PAID",
        debtors: { is: null },
        payment_method: "TRANSFER",
      },
      _sum: { totalCents: true },
    }),
    // The sale must still be PAID so a sale cancelled after collection
    // does not count as money received.
    db.debtors.aggregate({
      where: {
        paidJornadaId: jornadaId,
        status: "PAID",
        sales: { status: "PAID", payment_method: "CASH" },
      },
      _sum: { amountCents: true },
    }),
    db.debtors.aggregate({
      where: {
        paidJornadaId: jornadaId,
        status: "PAID",
        sales: { status: "PAID", payment_method: "TRANSFER" },
      },
      _sum: { amountCents: true },
    }),
    db.bill.aggregate({
      where: { jornadaId, payment_method: "CASH" },
      _sum: { amountCents: true },
    }),
    db.bill.aggregate({
      where: { jornadaId, payment_method: "TRANSFER" },
      _sum: { amountCents: true },
    }),
    db.salary.aggregate({
      where: { jornadaId, payment_method: "CASH" },
      _sum: { amountCents: true },
    }),
    db.salary.aggregate({
      where: { jornadaId, payment_method: "TRANSFER" },
      _sum: { amountCents: true },
    }),
    db.savings_movement.aggregate({
      where: { jornadaId, type: "DEPOSIT" },
      _sum: { amountCents: true },
    }),
    db.debtors.aggregate({
      where: { createdJornadaId: jornadaId, status: { not: "CANCELLED" } },
      _sum: { amountCents: true },
    }),
    db.debtors.aggregate({
      where: { status: "DEBT" },
      _sum: { amountCents: true },
    }),
  ]);

  const n = (value: bigint | number | null | undefined) =>
    toSafeInteger(value ?? 0);

  const summary = {
    cashSales: n(cashSales._sum.totalCents),
    debtCollectedCash: n(debtCash._sum.amountCents),
    cashBills: n(cashBills._sum.amountCents),
    cashSalaries: n(cashSalaries._sum.amountCents),
    savingsOut: n(deposits._sum.amountCents),
    transferSales: n(transferSales._sum.totalCents),
    debtCollectedTransfer: n(debtTransfer._sum.amountCents),
    transferBills: n(transferBills._sum.amountCents),
    transferSalaries: n(transferSalaries._sum.amountCents),
    debtCreated: n(debtCreated._sum.amountCents),
    debtPending: n(debtPending._sum.amountCents),
  };

  return {
    ...summary,
    expectedCash: toSafeInteger(
      BigInt(openingAmount) +
        BigInt(summary.cashSales) +
        BigInt(summary.debtCollectedCash) -
        BigInt(summary.cashBills) -
        BigInt(summary.cashSalaries) -
        BigInt(summary.savingsOut),
    ),
    expectedTransfer: toSafeInteger(
      BigInt(summary.transferSales) +
        BigInt(summary.debtCollectedTransfer) -
        BigInt(summary.transferBills) -
        BigInt(summary.transferSalaries),
    ),
  };
}
