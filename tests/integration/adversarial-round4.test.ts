import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getDebtorHistory, getCustomerDebtAccounts, payAccount, toDebt } from "@/lib/actions/debts";
import { updateSaleQuantity, cancelSaleAction } from "@/lib/actions/sales";
import { SaleStatus } from "@/app/generated/prisma/enums";

describe("Adversarial Round 4 Reproduction Tests (Must Fail Against Current Code)", () => {
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
            data: { name: "Maiz Round4", measureUnit: "kg", currentStockMilliunits: 100000, unitCostCents: 1000 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Tlacoyo Round4",
                priceCents: 3000,
                recipes: { create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Round4", phone: "555-4444", currentBalanceCents: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FINDING 1 (Medium): getDebtorHistory must serialize amount (Prisma.Decimal) to Number
     * Avoids Next.js Server Components -> Client Components serialization errors.
     */
    it("FINDING 1: getDebtorHistory should serialize Decimal amount to plain number", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                totalCents: 5000,
                status: "UNPAID",
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });
        await toDebt(customerId, [{ id: sale.id, total: 5000 } as any]);

        const debtor = await prisma.debtors.findUniqueOrThrow({ where: { saleID: sale.id } });

        const res = await getDebtorHistory(debtor.id);
        expect(res).toMatchObject({ success: true });

        // MUST FAIL if res.data.amount is a Prisma.Decimal instance (typeof === 'object')
        expect(typeof (res as any).data?.amount).toBe("number");
    });

    /**
     * FINDING 2 (High): getCustomerDebtAccounts must exclude cancelled sales
     * Prevents debts from cancelled orders (which cannot be inspected or collected) from showing up.
     */
    it("FINDING 2: getCustomerDebtAccounts should not return accounts belonging to CANCELLED sales", async () => {
        loginAs("ADMIN", adminId);

        const cancelCust = await prisma.customer.create({
            data: { customerName: "Cliente Cancel Accounts", currentBalanceCents: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                totalCents: 6000,
                status: "UNPAID",
                placedBy: adminId,
                customerID: cancelCust.id,
                jornadaId: openJornadaId,
            },
        });

        await toDebt(cancelCust.id, [{ id: sale.id, total: 6000 } as any]);
        await cancelSaleAction(sale.id);

        const res = await getCustomerDebtAccounts(cancelCust.id);
        expect(res).toMatchObject({ success: true });

        // MUST FAIL if getCustomerDebtAccounts only filters debtors with status DEBT
        // without checking that the sale is in DEBT (and not CANCELLED), returning the cancelled note
        expect(res.data).toEqual([]);
    });

    /**
     * FINDING 3 (High): updateSaleQuantity must update customer.currentBalance when sale.customerID is null
     * but the sale has an associated debtor with debtors.customerID.
     */
    it("FINDING 3: updateSaleQuantity should update customer balance via debtors.customerID if sale.customerID is null", async () => {
        loginAs("ADMIN", adminId);

        const balanceCust = await prisma.customer.create({
            data: { customerName: "Cliente Sin SaleCustID", currentBalanceCents: 0 },
        });

        // Sale moved to debt for a customer
        const sale = await prisma.sales.create({
            data: {
                totalCents: 3000,
                status: "UNPAID",
                placedBy: adminId,
                customerID: balanceCust.id,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [{ productID: productId, quantity: 1, unitPriceCents: 3000, subtotalCents: 3000 }],
                },
            },
        });

        await toDebt(balanceCust.id, [{ id: sale.id, total: 3000 } as any]);

        // Simulate sale.customerID being null on the sale (anonymous table sent to customer debt)
        await prisma.sales.update({
            where: { id: sale.id },
            data: { customerID: null },
        });

        // Update quantity from 1 to 2 tlacoyos ($60 total, diff +30)
        await updateSaleQuantity(sale.id, 2, productId);

        const updatedCustomer = await prisma.customer.findUniqueOrThrow({
            where: { id: balanceCust.id },
        });

        // MUST FAIL if updateSaleQuantity checks 'if (sale.customerID)' and ignores sale.debtors.customerID,
        // leaving the customer balance at 30 instead of 60
        expect(Number(updatedCustomer.currentBalanceCents)).toBe(6000);
    });

    /**
     * FINDING 4 (Medium): payAccount and toDebt must reject customerID <= 0 with INVALID_INPUT
     */
    it("FINDING 4: payAccount and toDebt should reject customerID <= 0 with INVALID_INPUT", async () => {
        loginAs("ADMIN", adminId);

        // MUST FAIL if CustomerSchema.shape.id only validates int(), accepting -1 and 0
        const payRes1 = await payAccount(0, [], "CASH");
        expect(payRes1).toMatchObject({ success: false, error: "INVALID_INPUT" });

        const toDebtRes = await toDebt(-5, []);
        expect(toDebtRes).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });
});
