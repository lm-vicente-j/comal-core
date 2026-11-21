import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getAllDebtors, getDebtsSummary, toDebt, payAccount, getSaleOrderItems, getCustomerDebtAccounts } from "@/lib/actions/debts";
import { createSale } from "@/lib/actions/sales";
import { SaleStatus } from "@/app/generated/prisma/enums";

describe("Adversarial Round 5 Reproduction Tests (Must Fail Against Current Code)", () => {
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
            data: { name: "Harina Round5", measureUnit: "kg", currentStock: 100, unitCost: 10 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Torta Round5",
                price: 45,
                recipes: { create: [{ supplyID: supplyId, quantityUsed: 1 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Round5", phone: "555-5555", currentBalance: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FINDING 1 (High): getAllDebtors and getDebtsSummary must exclude cancelled sales
     * from active debtor totals and counts.
     */
    it("FINDING 1: getAllDebtors and getDebtsSummary should exclude CANCELLED sales from active debt sums", async () => {
        loginAs("ADMIN", adminId);

        const cancelCust = await prisma.customer.create({
            data: { customerName: "Cliente Con Venta Cancelada R5", currentBalance: 100 },
        });

        // Create a CANCELLED sale that still has a debtors row in DEBT status
        const sale = await prisma.sales.create({
            data: {
                total: 100,
                status: "CANCELLED",
                placedBy: adminId,
                customerID: cancelCust.id,
                jornadaId: openJornadaId,
            },
        });

        await prisma.debtors.create({
            data: {
                saleID: sale.id,
                customerID: cancelCust.id,
                amount: 100,
                status: SaleStatus.DEBT,
                createdJornadaId: openJornadaId,
            },
        });

        const debtorsRes = await getAllDebtors({ search: "Cliente Con Venta Cancelada R5" });
        const debtorItem = debtorsRes.items.find((i) => i.customerID === cancelCust.id);

        // MUST FAIL if getAllDebtors sums debtors.status = DEBT without checking that the sale is not CANCELLED
        expect(debtorItem?.amount ?? 0).toBe(0);
    });

    /**
     * FINDING 2 (High): toDebt must reject non-existent customerId with INVALID_INPUT
     * instead of failing with INTERNAL ERROR / Prisma P2025.
     */
    it("FINDING 2: toDebt should reject non-existent customerId with INVALID_INPUT", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                total: 45,
                status: "UNPAID",
                placedBy: adminId,
                jornadaId: openJornadaId,
            },
        });

        const res = await toDebt(999999, [{ id: sale.id }]);

        // MUST FAIL if it throws P2025 and returns { msg: "INTERNAL ERROR", error: ... }
        expect(res).toMatchObject({ msg: "INVALID_INPUT" });
    });

    /**
     * FINDING 3 (Medium): toDebt must reject partial conversions when any sale does not exist or is not UNPAID
     */
    it("FINDING 3: toDebt should reject when not all requested sales are eligible (no partial silent conversion)", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                total: 45,
                status: "UNPAID",
                placedBy: adminId,
                jornadaId: openJornadaId,
            },
        });

        // 1 valid sale + 1 non-existent sale (99999)
        const res = await toDebt(customerId, [{ id: sale.id }, { id: 99999 }]);

        // MUST FAIL if it silently processes the valid sale and returns { msg: "SUCCESS" }
        expect(res).toMatchObject({ msg: "INVALID_INPUT" });
    });

    /**
     * FINDING 4 (High): payAccount must reject debt sales that have no associated debtors row
     */
    it("FINDING 4: payAccount should reject debt sales that have no debtor row", async () => {
        loginAs("ADMIN", adminId);

        const orphanSale = await prisma.sales.create({
            data: {
                total: 45,
                status: "DEBT",
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });

        const res = await payAccount(customerId, [{ id: orphanSale.id }], "CASH");

        // MUST FAIL if it accepts s.debtors === null and decrements customer balance
        expect(res).toMatchObject({ msg: "INVALID_INPUT" });
    });

    /**
     * FINDING 5 (Medium): createSale must reject orders with an empty sale_items array ([])
     */
    it("FINDING 5: createSale should reject empty sale_items array", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale([], "PAID", "VENTA_LIBRE", -1, "CASH");

        // MUST FAIL if createSale allows creating empty sales with total $0
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });
});
