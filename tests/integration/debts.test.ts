import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getAllDebtors, getDebtorHistory, getDebtsSummary, payAccount, toDebt } from "@/lib/actions/debts";
import type { Sale } from "@/lib/actions/sales";

describe("debts actions", () => {
    let adminId: number;
    let customerId: number;
    let sales: Sale[];
    let jornadaId: number;

    // Runs fn with every jornada closed, then reopens them.
    async function withoutOpenJornada(fn: () => Promise<void>) {
        await prisma.jornada.updateMany({ where: { status: "OPEN" }, data: { status: "CLOSED" } });
        try {
            await fn();
        } finally {
            await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "OPEN" } });
        }
    }

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Deudor Uno", phone: "555", currentBalance: 0 },
        });
        customerId = customer.id;

        const s1 = await prisma.sales.create({
            data: { total: 40, status: "UNPAID", source_type: "CL- Deudor Uno", placedBy: adminId, jornadaId: jornada.id },
        });
        const s2 = await prisma.sales.create({
            data: { total: 60, status: "UNPAID", source_type: "CL- Deudor Uno", placedBy: adminId, jornadaId: jornada.id },
        });
        sales = [s1, s2].map((s) => ({ id: s.id, total: Number(s.total) })) as unknown as Sale[];
    });

    it("rejects toDebt without a session", async () => {
        logout();
        expect(await toDebt(customerId, sales)).toMatchObject({ msg: "UNAUTHORIZED" });
        expect(await prisma.debtors.count()).toBe(0);
    });

    it("toDebt needs an open jornada to record where the debt was granted", async () => {
        loginAs("ADMIN", adminId);
        await withoutOpenJornada(async () => {
            expect(await toDebt(customerId, sales)).toMatchObject({ msg: "NO_OPEN_JORNADA" });
        });
        expect(await prisma.debtors.count()).toBe(0);
    });

    it("toDebt moves the sales to debt and raises the customer balance", async () => {
        loginAs("ADMIN", adminId);
        const res = await toDebt(customerId, sales);
        expect(res).toMatchObject({ msg: "SUCCESS" });

        const debtors = await prisma.debtors.findMany();
        expect(debtors).toHaveLength(2);
        expect(debtors.every((d) => d.status === "DEBT" && d.customerID === customerId)).toBe(true);
        // History: where and when the debt was granted, nothing collected yet.
        expect(debtors.every((d) => d.createdJornadaId === jornadaId && d.createdAt !== null)).toBe(true);
        expect(debtors.every((d) => d.paidAt === null && d.paidJornadaId === null && d.collectedBy === null)).toBe(true);

        const dbSales = await prisma.sales.findMany({ where: { id: { in: sales.map((s) => s.id) } } });
        expect(dbSales.every((s) => s.status === "DEBT" && s.customerID === customerId)).toBe(true);

        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(Number(customer.currentBalance)).toBe(100);
    });

    it("summary and grouped debtors reflect the new debt", async () => {
        loginAs("ADMIN", adminId);
        const summary = await getDebtsSummary();
        expect(summary.totalAmount).toBe(100);
        expect(summary.activeDebtors).toBe(1);

        const grouped = await getAllDebtors();
        expect(grouped).toHaveLength(1);
        expect(grouped[0].amount).toBe(100);
    });

    it("payAccount refuses to collect without an open jornada", async () => {
        loginAs("ADMIN", adminId);
        await withoutOpenJornada(async () => {
            expect(await payAccount(customerId, sales, "CASH")).toMatchObject({ msg: "NO_OPEN_JORNADA" });
        });

        const debtors = await prisma.debtors.findMany();
        expect(debtors.every((d) => d.status === "DEBT")).toBe(true);
        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(Number(customer.currentBalance)).toBe(100);
    });

    it("payAccount marks debts paid and lowers the balance", async () => {
        loginAs("ADMIN", adminId);
        const res = await payAccount(customerId, sales, "CASH");
        expect(res).toMatchObject({ msg: "SUCCESS" });

        const debtors = await prisma.debtors.findMany();
        expect(debtors.every((d) => d.status === "PAID" && d.paidAt !== null)).toBe(true);
        // The collection is attributed to the jornada and employee that received it.
        expect(debtors.every((d) => d.paidJornadaId === jornadaId && d.collectedBy === adminId)).toBe(true);

        const dbSales = await prisma.sales.findMany({ where: { id: { in: sales.map((s) => s.id) } } });
        expect(dbSales.every((s) => s.status === "PAID" && s.payment_method === "CASH")).toBe(true);

        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(Number(customer.currentBalance)).toBe(0);
    });

    it("toDebt and payAccount ignore sales in the wrong state", async () => {
        loginAs("ADMIN", adminId);
        const paidSale = await prisma.sales.create({
            data: { total: 500, status: "PAID", payment_method: "CASH", source_type: "CL- Deudor Uno", placedBy: adminId },
        });
        const fake = [{ id: paidSale.id, total: 500 }] as unknown as Sale[];

        // An already-paid sale can neither be converted to debt...
        expect(await toDebt(customerId, fake)).toMatchObject({ msg: "NO_UNPAID_SALES" });
        // ...nor collected again as one.
        expect(await payAccount(customerId, fake, "CASH")).toMatchObject({ msg: "NO_DEBT_SALES" });

        const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
        expect(Number(customer.currentBalance)).toBe(0);
    });

    it("debtor queries are empty without a session", async () => {
        logout();
        expect(await getAllDebtors()).toEqual([]);
        expect(await getDebtsSummary()).toEqual({ totalAmount: 0, activeDebtors: 0, todayPayments: 0 });
    });

    it("rejects malformed input before touching the database", async () => {
        loginAs("ADMIN", adminId);
        expect(await payAccount(customerId, sales, "CHEQUE" as never)).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await payAccount(1.5, sales, "CASH")).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await toDebt(customerId, [{ id: "x" }] as never)).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await toDebt(1.5, [])).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await getDebtorHistory("1" as never)).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });
});
