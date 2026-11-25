import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { actionData, loginAs, logout, resetDb, seedBase } from "./helpers";
import { toDebt, payAccount, getDebtsSummary, getAllDebtors } from "@/lib/actions/debts";
import { getSalesHistory, updateSaleQuantity, cancelSaleAction } from "@/lib/actions/sales";
import { SaleStatus } from "@/app/generated/prisma/enums";

describe("Adversarial Round 2 Reproduction Tests (Must Fail Against Current Code)", () => {
    let adminId: number;
    let customerId: number;
    let openJornadaId: number;
    let productId: number;
    let supplyId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        openJornadaId = jornada.id;

        const supply = await prisma.supplies.create({
            data: { name: "Masa Round2", measureUnit: "kg", currentStockMilliunits: 100000, unitCostCents: 1000 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Gordita Round2",
                priceCents: 2500,
                recipes: { create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Round2", phone: "555-9999", currentBalanceCents: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FINDING 1 (Critical): Race condition with double balance increment in toDebt
     * Two concurrent calls to toDebt on the same sale must not duplicate
     * the increment to customer.currentBalance.
     */
    it("FINDING 1: toDebt should prevent race condition and double increment on concurrent calls", async () => {
        loginAs("ADMIN", adminId);

        const testCustomer = await prisma.customer.create({
            data: { customerName: "Cliente Carrera toDebt", currentBalanceCents: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                totalCents: 10000,
                status: "UNPAID",
                placedBy: adminId,
                customerID: testCustomer.id,
                jornadaId: openJornadaId,
            },
        });

        // Simulate concurrency on findMany reading UNPAID sales
        const originalFindMany = prisma.sales.findMany;
        vi.spyOn(prisma.sales, "findMany").mockImplementation((async (args: any) => {
            const res = await originalFindMany.call(prisma.sales, args);
            if (args?.where?.status === "UNPAID") {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return res;
        }) as unknown as typeof originalFindMany);

        try {
            const [res1, res2] = await Promise.all([
                toDebt(testCustomer.id, [{ id: sale.id, total: 10000 } as any]),
                toDebt(testCustomer.id, [{ id: sale.id, total: 10000 } as any]),
            ]);
            console.log("toDebt results:", { res1, res2 });

            const customerAfter = await prisma.customer.findUniqueOrThrow({
                where: { id: testCustomer.id },
            });

            // MUST FAIL if both requests read UNPAID and each increments by 100, leaving balance at 200 instead of 100
            expect(Number(customerAfter.currentBalanceCents)).toBe(10000);
        } finally {
            vi.restoreAllMocks();
        }
    });

    /**
     * FINDING 2 (High): getSalesHistory must serialize unitPrice, subtotal, and customer.currentBalance to primitive Number
     * Avoids Next.js Server Components -> Client Components errors ("Only plain objects can be passed").
     */
    it("FINDING 2: getSalesHistory should serialize Decimal fields (unitPrice, subtotal, currentBalance) to plain numbers", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                totalCents: 5000,
                status: "PAID",
                payment_method: "CASH",
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [
                        { productID: productId, quantity: 2, unitPriceCents: 2500, subtotalCents: 5000 },
                    ],
                },
            },
        });

        const history = await getSalesHistory();
        const found = history.find((s) => s.id === sale.id);
        expect(found).toBeDefined();

        const item = found?.sale_items[0];
        // MUST FAIL if unitPrice and subtotal are Prisma.Decimal instances (typeof === 'object') rather than primitive numbers
        expect(typeof item?.unitPrice).toBe("number");
        expect(typeof item?.subtotal).toBe("number");
        expect(typeof (found?.customer as any)?.currentBalance).toBe("number");
    });

    /**
     * FINDING 3 (High): updateSaleQuantity must not desync debtors.amount or customer.currentBalance on DEBT sales
     * Modifying an order item on a DEBT sale must update both the associated debt and the customer balance.
     */
    it("FINDING 3: updateSaleQuantity should synchronize debtors.amount and customer balance when sale is in DEBT", async () => {
        loginAs("ADMIN", adminId);

        const debtCustomer = await prisma.customer.create({
            data: { customerName: "Cliente UpdateQty DEBT", currentBalanceCents: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                totalCents: 2500,
                status: "UNPAID",
                placedBy: adminId,
                customerID: debtCustomer.id,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [{ productID: productId, quantity: 1, unitPriceCents: 2500, subtotalCents: 2500 }],
                },
            },
        });

        // Convert to DEBT: now debtors.amount = 25 and customer.currentBalance = 25
        await toDebt(debtCustomer.id, [{ id: sale.id, total: 2500 } as any]);

        // Staff updates the quantity from 1 to 3 gorditas ($75 total)
        await updateSaleQuantity(sale.id, 3, productId);

        const updatedDebtor = await prisma.debtors.findUniqueOrThrow({
            where: { saleID: sale.id },
        });
        const updatedCustomer = await prisma.customer.findUniqueOrThrow({
            where: { id: debtCustomer.id },
        });

        // MUST FAIL if updateSaleQuantity only updates sales.total to 75,
        // leaving debtors.amount at 25 and customer.currentBalance at 25 (critical desync)
        expect(Number(updatedDebtor.amountCents)).toBe(7500);
        expect(Number(updatedCustomer.currentBalanceCents)).toBe(7500);
    });

    /**
     * FINDING 4 (High): getDebtsSummary must not sum collections from cancelled sales into todayPayments
     * If a paid debt belongs to a sale that is later cancelled, it must not count toward today's collections.
     */
    it("FINDING 4: getDebtsSummary should exclude collections from CANCELLED sales in todayPayments", async () => {
        loginAs("ADMIN", adminId);

        const cancelCustomer = await prisma.customer.create({
            data: { customerName: "Cliente Cancel Debt", currentBalanceCents: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                totalCents: 20000,
                status: "UNPAID",
                placedBy: adminId,
                customerID: cancelCustomer.id,
                jornadaId: openJornadaId,
            },
        });

        await toDebt(cancelCustomer.id, [{ id: sale.id, total: 20000 } as any]);
        await payAccount(cancelCustomer.id, [{ id: sale.id } as any], "CASH");
        // cancelSaleAction now rejects cancelling an already-PAID debt; simulate a legacy cancelled sale row directly
        expect(await cancelSaleAction(sale.id)).toMatchObject({ success: false, error: "CANNOT_CANCEL_PAID_SALE" });
        await prisma.sales.update({ where: { id: sale.id }, data: { status: "CANCELLED" } });

        const summary = await getDebtsSummary();
        // MUST FAIL if getDebtsSummary aggregates debtors with status: PAID without requiring sales: { status: 'PAID' },
        // causing todayPayments to still include the 200 from the cancelled sale
        expect(summary.todayPayments).toBe(0);
    });

    /**
     * FINDING 5 (Medium): getAllDebtors must not return an arbitrary page number when there are no records (total === 0)
     * When page: 5 is requested on an empty search result, page must clamp to 1 or totalPages (0/1) instead of returning page: 5.
     */
    it("FINDING 5: getAllDebtors should normalize page when total matches is 0", async () => {
        loginAs("ADMIN", adminId);

        const result = actionData(await getAllDebtors({ page: 5, search: "NonExistentCustomerNameXYZ" }));

        // MUST FAIL if it returns { total: 0, totalPages: 0, page: 5 } leaving the client on page = 5
        expect(result.total).toBe(0);
        expect(result.page).toBeLessThanOrEqual(1);
    });
});
