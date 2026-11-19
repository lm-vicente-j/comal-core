import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { PaymentMethod, SaleStatus } from "@/app/generated/prisma/enums";
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

describe("Issue #32 — Debtors pagination and large dataset regression", { timeout: 60_000 }, () => {
    let adminId: number;
    let jornadaId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;

        // 1,000 active customers (3 debts each: $10, $20, $30 -> $60 per customer)
        const activeCustomerCount = 1000;
        const historicalCustomerCount = 200;

        const customersData: any[] = [];
        const salesData: any[] = [];
        const debtorsData: any[] = [];

        let saleIdCounter = 1;
        let customerIdCounter = 10;
        const pastDate = new Date("2026-11-17T10:00:00Z");

        for (let i = 1; i <= activeCustomerCount; i++) {
            const cId = customerIdCounter++;
            let name = `Cliente Deudor ${String(i).padStart(4, "0")}`;
            let alias = `Alias${i}`;

            // Deterministic ordering tie-break verification with duplicate names
            if (i === 999 || i === 1000) {
                name = "Cliente ZZZ Gemelo";
            }
            if (i === 42) {
                alias = "ElCompa";
            }
            if (i === 100) {
                name = "Cliente Con Mayusculas";
                alias = "Especial";
            }

            customersData.push({
                id: cId,
                customerName: name,
                phone: `555000${String(i).padStart(4, "0")}`,
                alias: alias,
                currentBalance: 60,
                registeredDate: new Date("2026-01-01"),
                lastConsumption: new Date("2026-11-01"),
            });

            const amounts = [10, 20, 30];
            for (const amt of amounts) {
                const sId = saleIdCounter++;
                salesData.push({
                    id: sId,
                    total: amt,
                    status: SaleStatus.DEBT,
                    source_type: `CL- ${name}`,
                    customerID: cId,
                    placedBy: adminId,
                    jornadaId: jornadaId,
                    createdAt: pastDate,
                });
                debtorsData.push({
                    saleID: sId,
                    customerID: cId,
                    amount: amt,
                    status: SaleStatus.DEBT,
                    createdJornadaId: jornadaId,
                    createdAt: pastDate,
                    paidAt: null,
                    paidJornadaId: null,
                    collectedBy: null,
                });
            }
        }

        // 200 historical paid customers
        for (let i = 1; i <= historicalCustomerCount; i++) {
            const cId = customerIdCounter++;
            const name = `Cliente Historico ${String(i).padStart(4, "0")}`;
            customersData.push({
                id: cId,
                customerName: name,
                phone: `555999${String(i).padStart(4, "0")}`,
                alias: `Historico${i}`,
                currentBalance: 0,
                registeredDate: new Date("2026-01-01"),
                lastConsumption: pastDate,
            });

            const sId = saleIdCounter++;
            salesData.push({
                id: sId,
                total: 50,
                status: SaleStatus.PAID,
                payment_method: PaymentMethod.CASH,
                source_type: `CL- ${name}`,
                customerID: cId,
                placedBy: adminId,
                jornadaId: jornadaId,
                createdAt: pastDate,
            });
            debtorsData.push({
                saleID: sId,
                customerID: cId,
                amount: 50,
                status: SaleStatus.PAID,
                createdJornadaId: jornadaId,
                paidJornadaId: jornadaId,
                paidAt: pastDate,
                collectedBy: adminId,
                createdAt: pastDate,
            });
        }

        // Batch inserts in chunks
        for (let i = 0; i < customersData.length; i += 1000) {
            await prisma.customer.createMany({ data: customersData.slice(i, i + 1000) });
        }
        for (let i = 0; i < salesData.length; i += 1000) {
            await prisma.sales.createMany({ data: salesData.slice(i, i + 1000) });
        }
        for (let i = 0; i < debtorsData.length; i += 1000) {
            await prisma.debtors.createMany({ data: debtorsData.slice(i, i + 1000) });
        }

        // Synchronize sequence counters in PostgreSQL
        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('customer', 'id'), (SELECT COALESCE(MAX(id), 1) FROM customer))`);
        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('sales', 'id'), (SELECT COALESCE(MAX(id), 1) FROM sales))`);
        await prisma.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('debtors', 'id'), (SELECT COALESCE(MAX(id), 1) FROM debtors))`);
    }, 60_000);

    it("Test 1 — server-side pagination with exact sizes, total and deterministic ordering", async () => {
        loginAs("ADMIN", adminId);

        // Page 1
        const p1 = await getAllDebtors({ page: 1, pageSize: 10 });
        expect(p1.items).toHaveLength(10);
        expect(p1.total).toBe(1000);
        expect(p1.totalPages).toBe(100);
        expect(p1.page).toBe(1);
        expect(p1.pageSize).toBe(10);
        for (const item of p1.items) {
            expect(item.amount).toBe(60);
        }

        // Page 2
        const p2 = await getAllDebtors({ page: 2, pageSize: 10 });
        expect(p2.items).toHaveLength(10);
        expect(p2.page).toBe(2);
        expect(p2.pageSize).toBe(10);

        // Disjoint customers between page 1 and page 2
        const p1Ids = new Set(p1.items.map((i) => i.customerID));
        for (const item of p2.items) {
            expect(p1Ids.has(item.customerID)).toBe(false);
        }

        // Page 100
        const p100 = await getAllDebtors({ page: 100, pageSize: 10 });
        expect(p100.items).toHaveLength(10);
        expect(p100.page).toBe(100);
        expect(p100.totalPages).toBe(100);

        // Deterministic order: customerName asc, id asc
        for (let i = 0; i < p1.items.length - 1; i++) {
            const a = p1.items[i];
            const b = p1.items[i + 1];
            const cmp = (a.customerName ?? "").localeCompare(b.customerName ?? "");
            expect(cmp <= 0).toBe(true);
            if (cmp === 0) {
                expect(a.customerID).toBeLessThan(b.customerID);
            }
        }
    });

    it("Test 2 — page limits, clamping and safe defaults for invalid inputs", async () => {
        loginAs("ADMIN", adminId);

        // Page sizes 10, 20, 50
        const res10 = await getAllDebtors({ page: 1, pageSize: 10 });
        expect(res10.totalPages).toBe(100);

        const res20 = await getAllDebtors({ page: 1, pageSize: 20 });
        expect(res20.totalPages).toBe(50);
        expect(res20.items).toHaveLength(20);

        const res50 = await getAllDebtors({ page: 1, pageSize: 50 });
        expect(res50.totalPages).toBe(20);
        expect(res50.items).toHaveLength(50);

        // PageSize=100 clamped/defaulted to safe limit (<= 50)
        const clamped100 = await getAllDebtors({ pageSize: 100 });
        expect(clamped100.pageSize).toBeLessThanOrEqual(50);
        expect(clamped100.items.length).toBeLessThanOrEqual(50);

        // PageSize=0 or invalid types fall back to safe defaults
        const invalidZero = await getAllDebtors({ pageSize: 0 });
        expect(invalidZero.pageSize).toBe(10);

        const invalidNegative = await getAllDebtors({ pageSize: -5 });
        expect(invalidNegative.pageSize).toBe(10);

        // Page beyond totalPages returns the last real page
        const beyondLast = await getAllDebtors({ page: 9999, pageSize: 10 });
        expect(beyondLast.page).toBe(100);
        expect(beyondLast.totalPages).toBe(100);
        expect(beyondLast.total).toBe(1000);
        expect(beyondLast.items).toHaveLength(10);
    });

    it("Test 3 — paginated search by name, alias, case insensitivity and empty results", async () => {
        loginAs("ADMIN", adminId);

        // Search by name
        const searchName = await getAllDebtors({ search: "Cliente Deudor 001", pageSize: 10 });
        expect(searchName.total).toBeGreaterThan(0);
        expect(searchName.totalPages).toBe(Math.ceil(searchName.total / 10));
        expect(searchName.items.length).toBeLessThanOrEqual(10);
        for (const item of searchName.items) {
            expect(item.customerName?.toLowerCase()).toContain("cliente deudor 001");
        }

        // Search by alias
        const searchAlias = await getAllDebtors({ search: "ElCompa" });
        expect(searchAlias.total).toBe(1);
        expect(searchAlias.items).toHaveLength(1);
        expect(searchAlias.items[0].alias).toBe("ElCompa");

        // Case-insensitivity
        const lowerSearch = await getAllDebtors({ search: "cliente con mayusculas" });
        const upperSearch = await getAllDebtors({ search: "CLIENTE CON MAYUSCULAS" });
        expect(lowerSearch.total).toBe(1);
        expect(upperSearch.total).toBe(1);
        expect(lowerSearch.items[0].customerID).toBe(upperSearch.items[0].customerID);

        // Search without matches
        const noMatch = await getAllDebtors({ search: "TextoCompletamenteInexistenteXYZ123" });
        expect(noMatch.items).toEqual([]);
        expect(noMatch.total).toBe(0);
        expect(noMatch.totalPages).toBe(0);

        // Historical paid customers never appear
        const histSearch = await getAllDebtors({ search: "Historico" });
        expect(histSearch.total).toBe(0);
        expect(histSearch.items).toEqual([]);
    });

    it("Test 4 — ADMIN and STAFF roles parity and privacy protection", async () => {
        loginAs("ADMIN", adminId);
        const adminRes = await getAllDebtors({ page: 1, pageSize: 10 });

        loginAs("STAFF", 999);
        const staffRes = await getAllDebtors({ page: 1, pageSize: 10 });

        expect(staffRes.total).toBe(adminRes.total);
        expect(staffRes.totalPages).toBe(adminRes.totalPages);
        expect(staffRes.items).toHaveLength(adminRes.items.length);

        for (let i = 0; i < staffRes.items.length; i++) {
            expect(staffRes.items[i].customerID).toBe(adminRes.items[i].customerID);
            expect(staffRes.items[i].customerName).toBe(adminRes.items[i].customerName);
            expect(staffRes.items[i].amount).toBe(adminRes.items[i].amount);
            expect(staffRes.items[i].amount).toBe(60);

            // Privacy: phone and currentBalance are not exposed in DebtorListItem DTO
            expect((staffRes.items[i] as any).phone).toBeUndefined();
            expect((staffRes.items[i] as any).currentBalance).toBeUndefined();
        }
    });

    it("Test 5 — global summary independence and financial consistency across pagination, filters and payments", async () => {
        loginAs("ADMIN", adminId);

        // Financial oracle initial validation
        const summaryInitial = await getDebtsSummary();
        expect(summaryInitial.activeDebtors).toBe(1000);
        expect(summaryInitial.totalAmount).toBe(60000);
        expect(summaryInitial.todayPayments).toBe(0);

        // Global summary stays constant across pagination and searches
        await getAllDebtors({ page: 50, pageSize: 20 });
        await getAllDebtors({ search: "Inexistente999" });

        const summaryAfterNav = await getDebtsSummary();
        expect(summaryAfterNav.activeDebtors).toBe(1000);
        expect(summaryAfterNav.totalAmount).toBe(60000);
        expect(summaryAfterNav.todayPayments).toBe(0);

        // Payment extension: settle all debts for one customer
        const targetCustomer = (await getAllDebtors({ page: 1, pageSize: 1 })).items[0];
        const customerSales = await prisma.sales.findMany({
            where: { customerID: targetCustomer.customerID, status: "DEBT" },
            select: { id: true, total: true },
        });
        expect(customerSales).toHaveLength(3);

        const payResult = await payAccount(
            targetCustomer.customerID,
            customerSales as any,
            PaymentMethod.CASH
        );
        expect(payResult).toMatchObject({ msg: "SUCCESS" });

        // Financial update assertions
        const summaryAfterPay = await getDebtsSummary();
        expect(summaryAfterPay.activeDebtors).toBe(999);
        expect(summaryAfterPay.totalAmount).toBe(59940); // 60,000 - 60
        expect(summaryAfterPay.todayPayments).toBe(60);

        // Verification in paginated list: customer is removed from active list
        const listAfterPay = await getAllDebtors({ search: targetCustomer.customerName ?? "" });
        expect(listAfterPay.total).toBe(0);
        expect(listAfterPay.items).toHaveLength(0);
    });

    it("Test 6 — latency regression controlled benchmark on active dataset", async () => {
        loginAs("ADMIN", adminId);

        // 5 warm-up queries
        for (let i = 0; i < 5; i++) {
            await getAllDebtors({ page: (i % 10) + 1, pageSize: 10 });
        }

        // 30 measured queries alternating first page, middle page, last page and selective search
        const latencies: number[] = [];
        const pages = [1, 50, 100];

        for (let i = 0; i < 30; i++) {
            const page = pages[i % pages.length];
            const isSearch = i % 4 === 0;
            const start = performance.now();
            const res = isSearch
                ? await getAllDebtors({ search: "Cliente Deudor 00", pageSize: 10 })
                : await getAllDebtors({ page, pageSize: 10 });
            const duration = performance.now() - start;
            latencies.push(duration);

            expect(res.items.length).toBeLessThanOrEqual(10);
            expect(res.total).toBeGreaterThan(0);
            expect(res.totalPages).toBeGreaterThan(0);
        }

        expect(latencies).toHaveLength(30);
    });
});
