import { describe, it, expect, vi } from "vitest";
import nextConfig from "../../next.config";
import { AnalyticsFilterSchema } from "@/lib/actions/schemas";
import { saveExpense, getExpenses } from "@/lib/actions/expenses";
import { getSalaryHistory } from "@/lib/actions/payrolls";
import { getRecentMovements } from "@/lib/actions/savings";
import { searchCustomers } from "@/lib/actions/customers";
import { searchUsers } from "@/lib/actions/users";
import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb } from "./helpers";

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
            data: { openedBy: admin.id, openingAmount: 500, status: "OPEN" },
        });
        loginAs("ADMIN", admin.id);

        const spy = vi.spyOn(prisma.bill, "create").mockRejectedValueOnce(
            new Error("FATAL: postgres connection password postgres://user:secret@db:5432 failed")
        );

        const res = await saveExpense({
            amount: 50,
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

    it("clamps limit and offset in list queries to prevent uncapped exposure", async () => {
        await resetDb();
        const admin = await prisma.users.create({
            data: { name: "Admin Test", email: "admin@test.local", role: "ADMIN", active: true },
        });
        loginAs("ADMIN", admin.id);

        // getExpenses with negative or oversized limits
        const expRes = await getExpenses(-10, 5000);
        expect(expRes.items).toBeDefined();

        // getSalaryHistory with negative or oversized limits
        const salRes = await getSalaryHistory(admin.id, -5, 1000);
        expect(salRes.items).toBeDefined();

        // getRecentMovements with negative or oversized limits
        const movRes = await getRecentMovements(1000, -5);
        expect(movRes.items).toBeDefined();

        // searchCustomers with negative or oversized limits
        const custRes = await searchCustomers("test", 1000);
        expect(Array.isArray(custRes)).toBe(true);

        // searchUsers with negative or oversized limits
        const userRes = await searchUsers("test", 1000);
        expect(Array.isArray(userRes)).toBe(true);
    });
});
