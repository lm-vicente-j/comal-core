import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getAllDebtors, getDebtorHistory, getDebtsSummary, payAccount, toDebt, getCustomerDebtAccounts, getSaleOrderItems } from "@/lib/actions/debts";
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

        const res = await getAllDebtors();
        expect(res.items).toHaveLength(1);
        expect(res.items[0].amount).toBe(100);
        expect(res.total).toBe(1);
        expect(res.totalPages).toBe(1);
        // DTO mínimo común: no debe exponer phone ni currentBalance
        expect((res.items[0] as any).phone).toBeUndefined();
        expect((res.items[0] as any).currentBalance).toBeUndefined();
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
        expect(await getAllDebtors()).toEqual({ items: [], total: 0, page: 1, pageSize: 10, totalPages: 0 });
        expect(await getDebtsSummary()).toEqual({ totalAmount: 0, activeDebtors: 0, todayPayments: 0 });
    });

    it("rejects malformed input before touching the database", async () => {
        loginAs("ADMIN", adminId);
        expect(await payAccount(customerId, sales, "CHEQUE" as never)).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await payAccount(1.5, sales, "CASH")).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await toDebt(customerId, [{ id: "x" }] as never)).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await toDebt(1.5, [])).toMatchObject({ msg: "INVALID_INPUT" });
        expect(await getDebtorHistory("1" as never)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await getCustomerDebtAccounts(-1)).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(await getSaleOrderItems(0)).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });

    it("pagination limits pageSize and handles empty searches gracefully", async () => {
        loginAs("ADMIN", adminId);
        // Out of range pageSize is safely clamped/defaulted instead of crashing
        const clamped = await getAllDebtors({ pageSize: 100 });
        expect(clamped.pageSize).toBeLessThanOrEqual(50);

        // Search with no matches
        const empty = await getAllDebtors({ search: "Inexistente999" });
        expect(empty.total).toBe(0);
        expect(empty.totalPages).toBe(0);
        expect(empty.items).toEqual([]);
    });

    it("getCustomerDebtAccounts and getSaleOrderItems work on demand and protect non-debt sales", async () => {
        loginAs("ADMIN", adminId);

        // Create a new customer and open debt for testing
        const c2 = await prisma.customer.create({
            data: { customerName: "Cliente Detallado", currentBalance: 50 },
        });
        const product = await prisma.products.create({
            data: { name: "Tacos Test", price: 25 },
        });
        const sale = await prisma.sales.create({
            data: {
                total: 50,
                status: "DEBT",
                customerID: c2.id,
                placedBy: adminId,
                jornadaId,
                sale_items: {
                    create: {
                        productID: product.id,
                        quantity: 2,
                        unitPrice: 25,
                        subtotal: 50,
                    },
                },
            },
        });
        await prisma.debtors.create({
            data: {
                saleID: sale.id,
                customerID: c2.id,
                amount: 50,
                status: "DEBT",
                createdJornadaId: jornadaId,
            },
        });

        // 1. getCustomerDebtAccounts
        const accountsRes = await getCustomerDebtAccounts(c2.id);
        expect(accountsRes.success).toBe(true);
        expect((accountsRes as any).data).toHaveLength(1);
        expect((accountsRes as any).data[0].saleId).toBe(sale.id);
        expect((accountsRes as any).data[0].amount).toBe(50);

        // 2. getSaleOrderItems for active debt sale
        const itemsRes = await getSaleOrderItems(sale.id);
        expect(itemsRes.success).toBe(true);
        expect((itemsRes as any).data).toHaveLength(1);
        expect((itemsRes as any).data[0].quantity).toBe(2);
        expect((itemsRes as any).data[0].productName).toBe(product.name);

        // 3. Security: getSaleOrderItems rejects paid or arbitrary non-debt sales
        const paidSale = await prisma.sales.create({
            data: { total: 30, status: "PAID", payment_method: "CASH", placedBy: adminId },
        });
        const unauthorizedRes = await getSaleOrderItems(paidSale.id);
        expect(unauthorizedRes).toMatchObject({ success: false, error: "NOT_FOUND_OR_UNAUTHORIZED" });
    });

    it("getAllDebtors protects STAFF privacy and orders deterministically", async () => {
        loginAs("STAFF", 999);
        const res = await getAllDebtors({ page: 1, pageSize: 10 });
        expect(res.total).toBeGreaterThanOrEqual(1);
        for (const item of res.items) {
            // STAFF no debe recibir phone ni currentBalance
            expect((item as any).phone).toBeUndefined();
            expect((item as any).currentBalance).toBeUndefined();
            expect(item.amount).toBeGreaterThan(0);
        }

        // Test deterministic ordering (customerName asc, id asc)
        for (let i = 0; i < res.items.length - 1; i++) {
            const a = res.items[i].customerName ?? "";
            const b = res.items[i + 1].customerName ?? "";
            expect(a.localeCompare(b)).toBeLessThanOrEqual(0);
        }
    });

    it("excludes historical debtors with zero active debt", async () => {
        loginAs("ADMIN", adminId);
        // Create a customer whose debts are all PAID
        const historicalCustomer = await prisma.customer.create({
            data: { customerName: "Historico Pagado", currentBalance: 0 },
        });
        const histSale = await prisma.sales.create({
            data: { total: 100, status: "PAID", customerID: historicalCustomer.id, placedBy: adminId, payment_method: "CASH" },
        });
        await prisma.debtors.create({
            data: {
                saleID: histSale.id,
                customerID: historicalCustomer.id,
                amount: 100,
                status: "PAID",
                createdJornadaId: jornadaId,
                paidJornadaId: jornadaId,
                paidAt: new Date(),
            },
        });

        const res = await getAllDebtors({ search: "Historico Pagado" });
        expect(res.total).toBe(0);
        expect(res.items).toHaveLength(0);
    });
});
