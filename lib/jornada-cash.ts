import prisma from "./prisma";

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
    // Savings deposits + withdrawals: both move cash out of the drawer.
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

export async function getJornadaCashSummary(
    jornadaId: number,
    openingAmount: number
): Promise<JornadaCashSummary> {
    const [
        cashSales, transferSales,
        debtCash, debtTransfer,
        cashBills, transferBills,
        cashSalaries, transferSalaries,
        deposits, withdraws,
        debtCreated, debtPending,
    ] = await Promise.all([
        // Sales with a debt record are excluded: they are counted once, as
        // debt collections, in the jornada where they were actually paid.
        prisma.sales.aggregate({
            where: { jornadaId, status: "PAID", debtors: { is: null }, payment_method: "CASH" },
            _sum: { total: true },
        }),
        prisma.sales.aggregate({
            where: { jornadaId, status: "PAID", debtors: { is: null }, payment_method: "TRANSFER" },
            _sum: { total: true },
        }),
        // The sale must still be PAID so a sale cancelled after collection
        // does not count as money received.
        prisma.debtors.aggregate({
            where: { paidJornadaId: jornadaId, status: "PAID", sales: { status: "PAID", payment_method: "CASH" } },
            _sum: { amount: true },
        }),
        prisma.debtors.aggregate({
            where: { paidJornadaId: jornadaId, status: "PAID", sales: { status: "PAID", payment_method: "TRANSFER" } },
            _sum: { amount: true },
        }),
        prisma.bill.aggregate({ where: { jornadaId, payment_method: "CASH" }, _sum: { amount: true } }),
        prisma.bill.aggregate({ where: { jornadaId, payment_method: "TRANSFER" }, _sum: { amount: true } }),
        prisma.salary.aggregate({ where: { jornadaId, payment_method: "CASH" }, _sum: { amount: true } }),
        prisma.salary.aggregate({ where: { jornadaId, payment_method: "TRANSFER" }, _sum: { amount: true } }),
        prisma.savings_movement.aggregate({ where: { jornadaId, type: "DEPOSIT" }, _sum: { amount: true } }),
        prisma.savings_movement.aggregate({ where: { jornadaId, type: "WITHDRAW" }, _sum: { amount: true } }),
        prisma.debtors.aggregate({
            where: { createdJornadaId: jornadaId, status: { not: "CANCELLED" } },
            _sum: { amount: true },
        }),
        prisma.debtors.aggregate({ where: { status: "DEBT" }, _sum: { amount: true } }),
    ]);

    const n = (value: { toString(): string } | null | undefined) => Number(value ?? 0);

    const summary = {
        cashSales: n(cashSales._sum.total),
        debtCollectedCash: n(debtCash._sum.amount),
        cashBills: n(cashBills._sum.amount),
        cashSalaries: n(cashSalaries._sum.amount),
        savingsOut: n(deposits._sum.amount) + n(withdraws._sum.amount),
        transferSales: n(transferSales._sum.total),
        debtCollectedTransfer: n(debtTransfer._sum.amount),
        transferBills: n(transferBills._sum.amount),
        transferSalaries: n(transferSalaries._sum.amount),
        debtCreated: n(debtCreated._sum.amount),
        debtPending: n(debtPending._sum.amount),
    };

    return {
        ...summary,
        expectedCash:
            openingAmount
            + summary.cashSales
            + summary.debtCollectedCash
            - summary.cashBills
            - summary.cashSalaries
            - summary.savingsOut,
        expectedTransfer:
            summary.transferSales
            + summary.debtCollectedTransfer
            - summary.transferBills
            - summary.transferSalaries,
    };
}
