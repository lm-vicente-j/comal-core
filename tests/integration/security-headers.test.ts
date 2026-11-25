import { describe, it, expect, vi } from "vitest";
import nextConfig from "../../next.config";
import { AnalyticsFilterSchema } from "@/lib/actions/schemas";
import { saveExpense, getExpenses } from "@/lib/actions/expenses";
import { getSalaryHistory } from "@/lib/actions/payrolls";
import { getRecentMovements } from "@/lib/actions/savings";
import { getCustomerPage, searchCustomers } from "@/lib/actions/customers";
import { getStaffPage, searchUsers } from "@/lib/actions/users";
import { getProductPage } from "@/lib/actions/products";
import { calendarRange, timestampRange } from "@/lib/analytics";
import prisma from "@/lib/prisma";
import { loginAs, resetDb } from "./helpers";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("Security headers, error sanitization and query limits (Issue #17)", () => {
    it("configures standard security headers in next.config.ts", async () => {
        expect(nextConfig.headers).toBeDefined();
        const headerConfigs = await nextConfig.headers!();
        expect(headerConfigs.length).toBeGreaterThan(0);

        const globalRule = headerConfigs.find((rule) => rule.source === "/:path*");
        expect(globalRule).toBeDefined();

        const headerMap = new Map(globalRule!.headers.map((h) => [h.key, h.value]));
        expect(headerMap.get("X-Frame-Options")).toBe("DENY");
        expect(headerMap.get("X-Content-Type-Options")).toBe("nosniff");
        expect(headerMap.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
        expect(headerMap.get("Strict-Transport-Security")).toContain("max-age=");
        expect(headerMap.get("Permissions-Policy")).toContain("camera=()");
    });

    it("sanitizes error returns in saveExpense and never exposes raw exception strings", async () => {
        await resetDb();
        const admin = await prisma.users.create({
            data: { name: "Admin Caja", email: "caja@test.local", role: "ADMIN", active: true },
        });
        await prisma.jornada.create({
            data: { openedBy: admin.id, openingAmountCents: 50000, status: "OPEN" },
        });
        loginAs("ADMIN", admin.id);

        const spy = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(
            new Error("FATAL: postgres connection password postgres://user:secret@db:5432 failed")
        );

        const res = await saveExpense({
            amount: 5000,
            category: "Luz",
            description: "Pago de luz",
            date: new Date(),
            payment_method: "CASH",
        });

        expect(res).toEqual({ success: false, error: "INTERNAL ERROR" });
        expect(JSON.stringify(res)).not.toContain("secret");
        expect(JSON.stringify(res)).not.toContain("postgres");
        spy.mockRestore();
    });

    it("caps date ranges in AnalyticsFilterSchema at 366 days", () => {
        // Valid ranges
        expect(AnalyticsFilterSchema.safeParse({ from: "2026-01-01", to: "2026-01-31" }).success).toBe(true);
        expect(AnalyticsFilterSchema.safeParse({ from: "2026-01-01", to: "2026-12-31" }).success).toBe(true);

        // Invalid: exceeds 366 days
        const excess = AnalyticsFilterSchema.safeParse({ from: "2025-01-01", to: "2026-01-03" });
        expect(excess.success).toBe(false);

        // Invalid: from > to
        const reversed = AnalyticsFilterSchema.safeParse({ from: "2026-05-01", to: "2026-04-01" });
        expect(reversed.success).toBe(false);
    });

    it("builds an exclusive upper bound for the last supported calendar day", () => {
        const filter = AnalyticsFilterSchema.parse({ from: "9999-12-31", to: "9999-12-31" });
        expect(calendarRange(filter).lt.toISOString()).toBe("+010000-01-01T00:00:00.000Z");
        const range = timestampRange(filter);
        expect(range.lt.getTime() - range.gte.getTime()).toBe(86_400_000);
    });

    it("clamps limit and offset in list queries to prevent uncapped exposure", async () => {
        await resetDb();
        const admin = await prisma.users.create({
            data: { name: "Admin Test", email: "admin@test.local", role: "ADMIN", active: true },
        });
        loginAs("ADMIN", admin.id);

        // getExpenses with negative or oversized limits
        const expRes = await getExpenses({ page: -10, pageSize: 5000 });
        expect(expRes).toMatchObject({ success: true, data: { page: 1, pageSize: 50 } });

        // getSalaryHistory with negative or oversized limits
        const salRes = await getSalaryHistory({ filters: { userId: admin.id }, page: -5, pageSize: 1000 });
        expect(salRes).toMatchObject({ success: true, data: { page: 1, pageSize: 50 } });

        // getRecentMovements with negative or oversized limits
        const movRes = await getRecentMovements({ page: -5, pageSize: 1000 });
        expect(movRes).toMatchObject({ success: true, data: { page: 1, pageSize: 50 } });

        // searchCustomers with negative or oversized limits
        const custRes = await searchCustomers("test", 1000);
        expect(Array.isArray(custRes)).toBe(true);

        // searchUsers with negative or oversized limits
        const userRes = await searchUsers("test", 1000);
        expect(Array.isArray(userRes)).toBe(true);
    });

    it("returns bounded, sortable and searchable pages for the admin lists", async () => {
        await resetDb();
        const admin = await prisma.users.create({ data: { name: "Admin", role: "ADMIN", active: true } });
        loginAs("ADMIN", admin.id);
        const labels = Array.from({ length: 12 }, (_, index) => `Fila ${String(index + 1).padStart(2, "0")}`);
        await prisma.customer.createMany({ data: labels.map((customerName, currentBalance) => ({ customerName, currentBalanceCents: currentBalance * 100 })) });
        await prisma.products.createMany({ data: labels.map((name) => ({ name, priceCents: 2500 })) });
        await prisma.users.createMany({ data: labels.map((name) => ({ name, role: "STAFF", active: true })) });

        const customers = await getCustomerPage({ page: 2, sort: "currentBalance" });
        expect(customers).toMatchObject({ success: true, data: { page: 2, total: 12 } });
        expect(customers.data!.items.map((customer) => customer.currentBalance)).toEqual([1000, 1100]);
        expect(await getStaffPage({ page: 2 })).toMatchObject({ success: true, data: { page: 2, total: 13 } });
        expect((await getProductPage()).data!.items).toHaveLength(10);
        expect((await getProductPage({ search: "fila 12" })).data!.items.map((product) => product.name)).toEqual(["Fila 12"]);
        expect((await getProductPage({ search: "Fila %" })).data!.items).toHaveLength(0);
        expect(await getProductPage({ pageSize: 1000 })).toMatchObject({ success: true, data: { pageSize: 50, total: 12 } });
        const internationalNames = ["Olga", "Ñora", "N~ora", "Nora", "Àngela", "Zoé", "Søren", "Soren", "Sosa"];
        await prisma.customer.createMany({ data: internationalNames.map((customerName) => ({ customerName, currentBalanceCents: 0 })) });
        const spanishOrder = new Intl.Collator("es", { sensitivity: "base" });
        expect((await getCustomerPage({ search: "ora", sort: "customerName" })).data!.items.map((customer) => customer.customerName))
            .toEqual(["Ñora", "N~ora", "Nora"].sort(spanishOrder.compare));
        const first = await getCustomerPage({ page: 1, sort: "customerName" });
        const second = await getCustomerPage({ page: 2, sort: "customerName" });
        const third = await getCustomerPage({ page: 3, sort: "customerName" });
        expect([...first.data!.items, ...second.data!.items, ...third.data!.items].map((customer) => customer.customerName))
            .toEqual([...labels, ...internationalNames].sort(spanishOrder.compare));
        loginAs("STAFF", admin.id);
        expect(await getCustomerPage()).toMatchObject({ success: false, error: "FORBIDDEN" });
        expect(await getStaffPage()).toMatchObject({ success: false, error: "FORBIDDEN" });
    });
});
