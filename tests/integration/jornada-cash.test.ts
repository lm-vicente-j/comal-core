import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, resetDb } from "./helpers";
import { closeJornada, openJornada } from "@/lib/actions/jornada";
import { payAccount, toDebt } from "@/lib/actions/debts";
import { getJornadaCashSummary } from "@/lib/jornada-cash";
import type { Sale } from "@/lib/actions/sales";

/**
 * Cash cut across two jornadas. Debts are granted in J1 and collected either
 * in J1 or in J2: the money must be attributed to the jornada that received it.
 */
describe("jornada cash cut", () => {
    let adminId: number;
    let customerId: number;
    let j1: number;
    let j2: number;
    const debt: Record<"A" | "B" | "C", number> = { A: 0, B: 0, C: 0 };

    const asSales = (ids: number[]) => ids.map((id) => ({ id })) as unknown as Sale[];

    beforeAll(async () => {
        await resetDb();
        const admin = await prisma.users.create({
            data: { name: "Admin Corte", email: "corte@test.local", role: "ADMIN", active: true },
        });
        adminId = admin.id;
        customerId = (await prisma.customer.create({ data: { customerName: "Fiado Uno", currentBalance: 0 } })).id;
        loginAs("ADMIN", adminId);
    });

    it("J1: cash, transfers, expenses, salaries and savings by method", async () => {
        expect(await openJornada(500)).toMatchObject({ success: true });
        j1 = (await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } })).id;

        const sale = (data: { total: number; status: "PAID" | "UNPAID"; payment_method?: "CASH" | "TRANSFER" }) =>
            prisma.sales.create({
                data: { source_type: "CL- Fiado Uno", placedBy: adminId, jornadaId: j1, ...data },
            });

        await sale({ total: 200, status: "PAID", payment_method: "CASH" });
        await sale({ total: 150, status: "PAID", payment_method: "TRANSFER" });
        await sale({ total: 10, status: "PAID", payment_method: "CASH" });
        // A PAID sale without a method is counted on neither side.
        await sale({ total: 7, status: "PAID" });

        // Three sales turned into debt through the real action.
        for (const [key, total] of [["A", 300], ["B", 50], ["C", 40]] as const) {
            debt[key] = (await sale({ total, status: "UNPAID" })).id;
        }
        expect(await toDebt(customerId, asSales(Object.values(debt)))).toMatchObject({ msg: "SUCCESS" });

        // Debt C is collected in cash inside the same jornada.
        expect(await payAccount(customerId, asSales([debt.C]), "CASH")).toMatchObject({ msg: "SUCCESS" });

        const bill = (amount: number, payment_method: "CASH" | "TRANSFER") =>
            prisma.bill.create({ data: { amount, category: "Otros", description: "x", date: new Date(), registered_by: adminId, jornadaId: j1, payment_method } });
        await bill(30, "CASH");
        await bill(20, "TRANSFER");

        const salary = (amount: number, payment_method: "CASH" | "TRANSFER") =>
            prisma.salary.create({ data: { userID: adminId, amount, period: "SUELDO: x", payDate: new Date(), jornadaId: j1, payment_method } });
        await salary(60, "CASH");
        await salary(80, "TRANSFER");

        // Both savings movements take cash out of the drawer.
        await prisma.savings_movement.create({ data: { amount: 30, type: "DEPOSIT", registered_by: adminId, jornadaId: j1 } });
        await prisma.savings_movement.create({ data: { amount: 10, type: "WITHDRAW", registered_by: adminId, jornadaId: j1 } });

        const cash = await getJornadaCashSummary(j1, 500);
        // 500 + sales (200 + 10) + debt C collected 40 - bill 30 - salary 60 - savings (30 + 10)
        expect(cash.expectedCash).toBe(620);
        expect(cash.cashSales).toBe(210);
        expect(cash.debtCollectedCash).toBe(40);
        // The same-jornada debt is counted once, as a collection, not as a sale.
        expect(cash.transferSales).toBe(150);
        // 150 sales - bill 20 - salary 80, no opening amount
        expect(cash.expectedTransfer).toBe(50);
        // Debt overview: A + B + C granted here, A + B still unpaid.
        expect(cash.debtCreated).toBe(390);
        expect(cash.debtPending).toBe(350);
    });

    it("closing J1 stores the cash and transfer snapshots", async () => {
        expect(await closeJornada(j1, 620)).toMatchObject({ success: true });
        const closed = await prisma.jornada.findUniqueOrThrow({ where: { id: j1 } });
        expect(Number(closed.expectedClosingAmount)).toBe(620);
        expect(Number(closed.expectedTransferAmount)).toBe(50);
    });

    it("J2: debts granted in J1 count in the jornada where they are collected", async () => {
        expect(await openJornada(100)).toMatchObject({ success: true });
        j2 = (await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } })).id;

        // A in cash, B by transfer, both from J1.
        expect(await payAccount(customerId, asSales([debt.A]), "CASH")).toMatchObject({ msg: "SUCCESS" });
        expect(await payAccount(customerId, asSales([debt.B]), "TRANSFER")).toMatchObject({ msg: "SUCCESS" });

        const paid = await prisma.debtors.findUniqueOrThrow({ where: { saleID: debt.A } });
        expect(paid.createdJornadaId).toBe(j1);
        expect(paid.paidJornadaId).toBe(j2);
        expect(paid.collectedBy).toBe(adminId);

        const cash = await getJornadaCashSummary(j2, 100);
        expect(cash.expectedCash).toBe(400);
        expect(cash.debtCollectedCash).toBe(300);
        expect(cash.cashSales).toBe(0);
        expect(cash.debtCollectedTransfer).toBe(50);
        expect(cash.expectedTransfer).toBe(50);
        expect(cash.debtCreated).toBe(0);
        expect(cash.debtPending).toBe(0);
    });

    it("collecting later does not rewrite the closed jornada", async () => {
        const cash = await getJornadaCashSummary(j1, 500);
        expect(cash.expectedCash).toBe(620);
        expect(cash.expectedTransfer).toBe(50);
        expect(cash.debtCreated).toBe(390);
    });

    it("a sale cancelled after its collection no longer counts as money received", async () => {
        await prisma.sales.update({ where: { id: debt.A }, data: { status: "CANCELLED" } });
        const cash = await getJornadaCashSummary(j2, 100);
        expect(cash.debtCollectedCash).toBe(0);
        expect(cash.expectedCash).toBe(100);
    });
});
