import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getAllDebtors, getDebtsSummary, toDebt, payAccount, getCustomerDebtAccounts } from "@/lib/actions/debts";
import { createSale } from "@/lib/actions/sales";
import { getAllCustomers } from "@/lib/actions/customers";
import { CustomerSchema } from "@/lib/actions/schemas";
import { SaleStatus } from "@/app/generated/prisma/enums";

describe("Adversarial Round 6 Reproduction Tests (Must Fail Against Current Code)", () => {
    let adminId: number;
    let staffId: number;
    let customerId: number;
    let openJornadaId: number;
    let productId: number;
    let supplyId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        openJornadaId = jornada.id;

        const staff = await prisma.users.create({
            data: { name: "Staff Test", email: "staff@test.local", role: "STAFF", active: true },
        });
        staffId = staff.id;

        const supply = await prisma.supplies.create({
            data: { name: "Harina Round6", measureUnit: "kg", currentStockMilliunits: 100000, unitCostCents: 1000 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Torta Round6",
                priceCents: 5000,
                recipes: { create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Round6", phone: "555-6666", currentBalanceCents: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FINDING 1: Concurrent toDebt must not double-increment customer.currentBalance
     */
    it("FINDING 1: concurrent toDebt calls on the same UNPAID sale must not double-increment currentBalance", async () => {
        loginAs("ADMIN", adminId);

        const testCust = await prisma.customer.create({
            data: { customerName: "Cliente Carrera toDebt R6", currentBalanceCents: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                totalCents: 10000,
                status: "UNPAID",
                placedBy: adminId,
                jornadaId: openJornadaId,
            },
        });

        // Execute two concurrent toDebt calls
        await Promise.all([
            toDebt(testCust.id, [{ id: sale.id }]),
            toDebt(testCust.id, [{ id: sale.id }]),
        ]);

        const updatedCust = await prisma.customer.findUnique({
            where: { id: testCust.id },
        });

        // MUST FAIL if both operations run and the balance ends up at 200 instead of 100
        expect(Number(updatedCust?.currentBalanceCents)).toBe(10000);
    });

    /**
     * FINDING 2: payAccount must reject requests with invalid or non-existent sale IDs (no silent partial payment)
     */
    it("FINDING 2: payAccount should reject when any requested sale is non-existent or ineligible", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                totalCents: 5000,
                status: "DEBT",
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });
        await prisma.debtors.create({
            data: {
                saleID: sale.id,
                customerID: customerId,
                amountCents: 5000,
                status: SaleStatus.DEBT,
                createdJornadaId: openJornadaId,
            },
        });

        const res = await payAccount(customerId, [{ id: sale.id }, { id: 999999 }], "CASH");

        // MUST FAIL if payAccount silently drops 999999 and responds success: true
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });

    /**
     * FINDING 3: payAccount must reject sales whose debtors row is CANCELLED or PAID
     */
    it("FINDING 3: payAccount should reject sales where debtor row is not in DEBT status", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                totalCents: 5000,
                status: "DEBT",
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });
        await prisma.debtors.create({
            data: {
                saleID: sale.id,
                customerID: customerId,
                amountCents: 5000,
                status: SaleStatus.CANCELLED, // cancelled debtor row
                createdJornadaId: openJornadaId,
            },
        });

        const res = await payAccount(customerId, [{ id: sale.id }], "CASH");

        // MUST FAIL if payAccount accepts the sale and decrements the balance
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });

    /**
     * FINDING 4: createSale with a non-existent customerID must return { success: false, error: "INVALID_INPUT" }
     */
    it("FINDING 4: createSale with non-existent customerID should return INVALID_INPUT instead of Prisma P2003/P2025 error", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "DEBT",
            "VENTA_LIBRE",
            999999,
            "CASH"
        );

        // MUST FAIL if it throws P2003 / P2025 and returns INTERNAL ERROR
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });

    /**
     * FINDING 5: getCustomerDebtAccounts and getAllDebtors must not list PAID sales even if debtors is DEBT
     */
    it("FINDING 5: getCustomerDebtAccounts should only include sales with status DEBT, not PAID", async () => {
        loginAs("ADMIN", adminId);

        const paidSaleCust = await prisma.customer.create({
            data: { customerName: "Cliente Con Venta Paid R6", currentBalanceCents: 5000 },
        });

        const sale = await prisma.sales.create({
            data: {
                totalCents: 5000,
                status: "PAID", // Sale is PAID
                placedBy: adminId,
                customerID: paidSaleCust.id,
                jornadaId: openJornadaId,
            },
        });
        await prisma.debtors.create({
            data: {
                saleID: sale.id,
                customerID: paidSaleCust.id,
                amountCents: 5000,
                status: SaleStatus.DEBT, // Debtor row was left in DEBT
                createdJornadaId: openJornadaId,
            },
        });

        const accounts = await getCustomerDebtAccounts(paidSaleCust.id);

        // MUST FAIL if the filter is status: { not: "CANCELLED" }, which includes the PAID sale
        expect(accounts).toEqual({ success: true, data: [] });
    });

    /**
     * FINDING 6: CustomerSchema must accept customers with redacted fields returned by getAllCustomers for STAFF
     */
    it("FINDING 6: CustomerSchema must parse redacted customer records returned for STAFF without error", async () => {
        loginAs("STAFF", staffId);

        const customers = await getAllCustomers();
        expect(customers.length).toBeGreaterThan(0);

        // Validate the first returned customer against CustomerSchema
        const parseRes = CustomerSchema.safeParse(customers[0]);

        // MUST FAIL if CustomerSchema requires currentBalance: z.number(), which is undefined for STAFF
        expect(parseRes.success).toBe(true);
    });

    /**
     * FINDING 7: toDebt and payAccount must reject empty arrays sales: [] with INVALID_INPUT
     */
    it("FINDING 7: toDebt and payAccount must reject empty sales array with INVALID_INPUT", async () => {
        loginAs("ADMIN", adminId);

        const resToDebt = await toDebt(customerId, []);
        const resPay = await payAccount(customerId, [], "CASH");

        // MUST FAIL if they return NO_UNPAID_SALES and NO_DEBT_SALES instead
        expect(resToDebt).toMatchObject({ success: false, error: "INVALID_INPUT" });
        expect(resPay).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });
});
