import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../helpers/database");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, resetDb, makeCashCountInput} from "../helpers/database";
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
        customerId = (await prisma.customer.create({ data: { customerName: "Fiado Uno", currentBalanceCents: 0 } })).id;
        loginAs("ADMIN", adminId);
    });

    it("J1: cash, transfers, expenses, salaries and savings by method", async () => {
        expect(await openJornada(makeCashCountInput(50000))).toMatchObject({ success: true });
        j1 = (await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } })).id;

        const sale = ({ total, ...data }: { total: number; status: "PAID" | "UNPAID"; payment_method?: "CASH" | "TRANSFER" }) =>
            prisma.sales.create({
                data: { source_type: "CL- Fiado Uno", placedBy: adminId, jornadaId: j1, totalCents: total, ...data },
            });

        await sale({ total: 20000, status: "PAID", payment_method: "CASH" });
        await sale({ total: 15000, status: "PAID", payment_method: "TRANSFER" });
        await sale({ total: 1000, status: "PAID", payment_method: "CASH" });
        // A PAID sale without a method is counted on neither side.
        await sale({ total: 700, status: "PAID" });

        // Three sales turned into debt through the real action.
        for (const [key, total] of [["A", 30000], ["B", 5000], ["C", 4000]] as const) {
            debt[key] = (await sale({ total, status: "UNPAID" })).id;
        }
        expect(await toDebt(customerId, asSales(Object.values(debt)))).toMatchObject({ success: true });

        // Debt C is collected in cash inside the same jornada.
        expect(await payAccount(customerId, asSales([debt.C]), "CASH")).toMatchObject({ success: true });

        const bill = (amount: number, payment_method: "CASH" | "TRANSFER") =>
            prisma.bill.create({ data: { amountCents: amount * 100, category: "Otros", description: "x", date: new Date(), registered_by: adminId, jornadaId: j1, payment_method } });
        await bill(30, "CASH");
        await bill(20, "TRANSFER");

        const salary = (amount: number, payment_method: "CASH" | "TRANSFER") =>
            prisma.salary.create({ data: { userID: adminId, amountCents: amount * 100, period: "SUELDO: x", payDate: new Date(), jornadaId: j1, payment_method } });
        await salary(60, "CASH");
        await salary(80, "TRANSFER");

        // The deposit moves cash out of the drawer. The withdrawal comes from savings.
        await prisma.savings_movement.create({ data: { amountCents: 3000, type: "DEPOSIT", registered_by: adminId, jornadaId: j1 } });
        await prisma.savings_movement.create({ data: { amountCents: 1000, type: "WITHDRAW", registered_by: adminId, jornadaId: j1 } });

        const cash = await getJornadaCashSummary(j1, 50000);
        // 500 + sales (200 + 10) + debt C collected 40 - bill 30 - salary 60 - savings deposit 30
        expect(cash.expectedCash).toBe(63000);
        expect(cash.cashSales).toBe(21000);
        expect(cash.debtCollectedCash).toBe(4000);
        // The same-jornada debt is counted once, as a collection, not as a sale.
        expect(cash.transferSales).toBe(15000);
        // 150 sales - bill 20 - salary 80, no opening amount
        expect(cash.expectedTransfer).toBe(5000);
        // Debt overview: A + B + C granted here, A + B still unpaid.
        expect(cash.debtCreated).toBe(39000);
        expect(cash.debtPending).toBe(35000);
    });

    it("closing J1 stores the cash and transfer snapshots", async () => {
        expect(await closeJornada(j1, makeCashCountInput(62000, "integration count"))).toMatchObject({ success: true });
        const closed = await prisma.jornada.findUniqueOrThrow({ where: { id: j1 } });
        expect(Number(closed.expectedClosingAmountCents)).toBe(63000);
        expect(Number(closed.expectedTransferAmountCents)).toBe(5000);
    });

    it("J2: debts granted in J1 count in the jornada where they are collected", async () => {
        expect(await openJornada(makeCashCountInput(10000))).toMatchObject({ success: true });
        j2 = (await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } })).id;

        // A in cash, B by transfer, both from J1.
        expect(await payAccount(customerId, asSales([debt.A]), "CASH")).toMatchObject({ success: true });
        expect(await payAccount(customerId, asSales([debt.B]), "TRANSFER")).toMatchObject({ success: true });

        const paid = await prisma.debtors.findUniqueOrThrow({ where: { saleID: debt.A } });
        expect(paid.createdJornadaId).toBe(j1);
        expect(paid.paidJornadaId).toBe(j2);
        expect(paid.collectedBy).toBe(adminId);

        const cash = await getJornadaCashSummary(j2, 10000);
        expect(cash.expectedCash).toBe(40000);
        expect(cash.debtCollectedCash).toBe(30000);
        expect(cash.cashSales).toBe(0);
        expect(cash.debtCollectedTransfer).toBe(5000);
        expect(cash.expectedTransfer).toBe(5000);
        expect(cash.debtCreated).toBe(0);
        expect(cash.debtPending).toBe(0);
    });

    it("collecting later does not rewrite the closed jornada", async () => {
        const cash = await getJornadaCashSummary(j1, 50000);
        expect(cash.expectedCash).toBe(63000);
        expect(cash.expectedTransfer).toBe(5000);
        expect(cash.debtCreated).toBe(39000);
    });

    it("a sale cancelled after its collection no longer counts as money received", async () => {
        await prisma.sales.update({ where: { id: debt.A }, data: { status: "CANCELLED" } });
        const cash = await getJornadaCashSummary(j2, 10000);
        expect(cash.debtCollectedCash).toBe(0);
        expect(cash.expectedCash).toBe(10000);
    });
});
