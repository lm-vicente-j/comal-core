import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getSalesHistory } from "@/lib/actions/sales";
import { getAllDebtors, payAccount, getDebtorHistory, toDebt } from "@/lib/actions/debts";
import { SaleStatus } from "@/app/generated/prisma/enums";

describe("Adversarial Findings Reproduction Tests (Must Fail Against Current Code)", () => {
    let adminId: number;
    let staffId: number;
    let customerId: number;
    let productId: number;
    let openJornadaId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        openJornadaId = jornada.id;

        const staff = await prisma.users.create({
            data: {
                name: "Staff User",
                email: "staff@test.local",
                role: "STAFF",
                active: true,
                password: "hashed_staff_password_123",
                pin: "5678",
            },
        });
        staffId = staff.id;

        // Give admin sensitive credentials to test leak
        await prisma.users.update({
            where: { id: adminId },
            data: {
                password: "$2a$12$e8YkYx4w...super_secret_admin_hash",
                pin: "9999",
            },
        });

        const product = await prisma.products.create({
            data: { name: "Tacos Adversarial", priceCents: 5000 },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Adversarial", phone: "555-0000", currentBalanceCents: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FINDING 1 (Critical): Credential leak (password / pin) in getSalesHistory
     * When a STAFF user queries sales history, the user object associated
     * with the sale MUST NOT expose confidential fields (password hash, pin).
     */
    it("FINDING 1: getSalesHistory should redact password and pin hashes for STAFF users", async () => {
        // Create a sale placed by admin
        const sale = await prisma.sales.create({
            data: {
                status: "PAID",
                payment_method: "CASH",
                totalCents: 5000,
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });

        loginAs("STAFF", staffId);
        const history = await getSalesHistory();

        expect(history.length).toBeGreaterThan(0);
        const foundSale = history.find((s) => s.id === sale.id);
        expect(foundSale).toBeDefined();

        // MUST FAIL if users: true exposes password and pin to STAFF clients
        expect((foundSale?.users as any)?.password).toBeUndefined();
        expect((foundSale?.users as any)?.pin).toBeUndefined();
    });

    /**
     * FINDING 2 (High): Uncaught exception in getAllDebtors on out-of-range inputs
     * Invalid parameters such as page: 0 or excessive search length must be handled defensively
     * without throwing an uncaught ZodError (HTTP 500 / rejection).
     */
    it("FINDING 2: getAllDebtors should safely handle out-of-range pagination options without throwing unhandled ZodError", async () => {
        loginAs("ADMIN", adminId);

        // MUST FAIL if PaginationOptionsSchema.parse(options) throws ZodError instead of handling safely
        await expect(getAllDebtors({ page: 0 } as any)).resolves.not.toThrow();
        await expect(getAllDebtors({ pageSize: 100 } as any)).resolves.not.toThrow();
        await expect(getAllDebtors({ search: "x".repeat(105) } as any)).resolves.not.toThrow();
    });

    /**
     * FINDING 3 (Medium): Out-of-range pagination / empty pages in getAllDebtors
     * When requesting a page beyond total available pages (e.g. page 2 of 1),
     * the backend should clamp page to totalPages and return existing records instead of empty items.
     */
    it("FINDING 3: getAllDebtors should clamp page to totalPages when page exceeds available range", async () => {
        loginAs("ADMIN", adminId);

        // Create an active debt for the customer using toDebt
        const sale = await prisma.sales.create({
            data: {
                status: "UNPAID",
                payment_method: "CASH",
                totalCents: 10000,
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });
        await toDebt(customerId, [{ id: sale.id, total: 10000 } as any]);

        // Only 1 active debtor exists, so totalPages = 1
        const result = await getAllDebtors({ page: 2, pageSize: 10 });

        // MUST FAIL if it returns page: 2 and items: [] leaving the user stranded on an empty page
        expect(result.page).toBeLessThanOrEqual(result.totalPages);
        expect(result.items.length).toBeGreaterThan(0);
    });

    /**
     * FINDING 4 (High): Race condition on concurrent payments in payAccount
     * If two requests read DEBT sales concurrently before the transaction updates
     * status to PAID, both run decrement without atomic validation or locking,
     * driving the customer's balance negative.
     */
    it("FINDING 4: payAccount should prevent race condition and double decrement on concurrent payments", async () => {
        loginAs("ADMIN", adminId);

        // Create customer with an exact debt of 200
        const testCustomer = await prisma.customer.create({
            data: {
                customerName: "Cliente Concurrente",
                phone: "111-222",
                currentBalanceCents: 0,
            },
        });

        const debtSale = await prisma.sales.create({
            data: {
                status: "UNPAID",
                payment_method: "CASH",
                totalCents: 20000,
                placedBy: adminId,
                customerID: testCustomer.id,
                jornadaId: openJornadaId,
            },
        });
        await toDebt(testCustomer.id, [{ id: debtSale.id, total: 20000 } as any]);

        // Simulate concurrency by temporarily intercepting findMany so both requests
        // read the DEBT state before the first transaction completes
        const originalFindMany = prisma.sales.findMany;
        let readCount = 0;
        vi.spyOn(prisma.sales, "findMany").mockImplementation((async (args: any) => {
            const res = await originalFindMany.call(prisma.sales, args);
            // Simulate a small 50ms concurrent network delay while reading sales
            if (args?.where?.status === "DEBT") {
                readCount++;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return res;
        }) as unknown as typeof originalFindMany);

        try {
            await Promise.all([
                payAccount(testCustomer.id, [{ id: debtSale.id } as any], "CASH"),
                payAccount(testCustomer.id, [{ id: debtSale.id } as any], "CASH"),
            ]);

            const customerAfter = await prisma.customer.findUniqueOrThrow({
                where: { id: testCustomer.id },
            });

            // MUST FAIL if both transactions read DEBT in parallel and each decrements 200,
            // leaving balance at -200 (financial integrity violation)
            expect(Number(customerAfter.currentBalanceCents)).toBeGreaterThanOrEqual(0);
            expect(Number(customerAfter.currentBalanceCents)).toBe(0);
        } finally {
            vi.restoreAllMocks();
        }
    });

    /**
     * FINDING 5 (Low/Medium): Return signature inconsistency in getDebtorHistory
     * getDebtorHistory must follow the standard { success: true, data: ... }
     * or { success: false, error: ... } envelope used by other server actions.
     */
    it("FINDING 5: getDebtorHistory should return a standard response envelope with success and data", async () => {
        loginAs("ADMIN", adminId);

        const result = await getDebtorHistory(99999);

        // MUST FAIL if it returns null or the raw Prisma model instead of { success: true, data: ... }
        expect(result).toHaveProperty("success");
    });
});
