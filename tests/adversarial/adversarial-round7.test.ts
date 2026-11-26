import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../helpers/database");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, resetDb, seedBase } from "../helpers/database";

import { createSale, updateSaleQuantity } from "@/lib/actions/sales";
import { saveCustomer, searchCustomers } from "@/lib/actions/customers";
import { SaleStatus } from "@/app/generated/prisma/enums";

describe("Adversarial Round 7 Reproduction Tests (Must Fail Against Current Code)", () => {
    let adminId: number;
    let openJornadaId: number;
    let productId: number;
    let supplyId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        openJornadaId = jornada.id;

        const supply = await prisma.supplies.create({
            data: { name: "Harina Round7", measureUnit: "kg", currentStockMilliunits: 100000, unitCostCents: 1000 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Torta Round7",
                priceCents: 6000,
                recipes: { create: [{ supplyID: supplyId, quantityUsedMilliunits: 1000 }] },
            },
        });
        productId = product.id;

        await prisma.customer.create({
            data: { customerName: "Cliente Base R7", phone: "555-7777", currentBalanceCents: 0 },
        });
    });

    /**
     * FINDING 1: createSale with a negative customerID other than -1 (-2, -99) must return INVALID_INPUT
     */
    it("FINDING 1: createSale with negative customerID other than -1 must return INVALID_INPUT", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            "VENTA_LIBRE",
            -2,
            "CASH"
        );

        // MUST FAIL if it hits Prisma P2003/P2025 and returns INTERNAL ERROR
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });

    /**
     * FINDING 2: saveCustomer without a phone field must preserve the existing phone instead of overwriting it with null
     */
    it("FINDING 2: saveCustomer without phone field should preserve existing phone", async () => {
        loginAs("ADMIN", adminId);

        const testCust = await prisma.customer.create({
            data: { customerName: "Cliente Con Telefono R7", phone: "555-9876", currentBalanceCents: 0 },
        });

        // Update only the name without passing phone
        const updateRes = await saveCustomer({
            id: testCust.id,
            customerName: "Cliente Con Telefono R7 Modificado",
        });
        expect(updateRes.success).toBe(true);

        const afterUpdate = await prisma.customer.findUnique({
            where: { id: testCust.id },
        });

        // MUST FAIL if update: { phone } evaluates phone to null and wipes the phone number
        expect(afterUpdate?.phone).toBe("555-9876");
    });

    /**
     * FINDING 3: searchCustomers(undefined) must not throw an uncaught TypeError
     */
    it("FINDING 3: searchCustomers with non-string/undefined query should return empty array safely", async () => {
        loginAs("ADMIN", adminId);

        // MUST FAIL if query.trim() runs outside try/catch and throws TypeError
        const res = await searchCustomers(undefined as unknown as string);
        expect(res).toEqual([]);
    });

    /**
     * FINDING 4: saveCustomer must validate max phone length (20 characters) and return fieldErrors
     */
    it("FINDING 4: saveCustomer should reject phone numbers longer than 20 characters with fieldErrors", async () => {
        loginAs("ADMIN", adminId);

        const res = await saveCustomer({
            customerName: "Cliente Phone Largo R7",
            phone: "1234567890123456789012345", // 25 chars
        });

        // MUST FAIL if CustomerSchema does not validate phone length and Prisma throws P2000
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.phone).toBeDefined();
    });

    /**
     * FINDING 5: updateSaleQuantity must not modify debtors rows or balance if debtors.status is PAID or CANCELLED
     */
    it("FINDING 5: updateSaleQuantity must not update debtor amount or customerBalance if debtor is already PAID", async () => {
        loginAs("ADMIN", adminId);

        const testCust = await prisma.customer.create({
            data: { customerName: "Cliente Deuda Pagada R7", currentBalanceCents: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                totalCents: 6000,
                status: "DEBT",
                placedBy: adminId,
                customerID: testCust.id,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [{ productID: productId, quantity: 1, unitPriceCents: 6000, subtotalCents: 6000 }],
                },
            },
        });

        await prisma.debtors.create({
            data: {
                saleID: sale.id,
                customerID: testCust.id,
                amountCents: 6000,
                status: SaleStatus.PAID, // Already settled
                createdJornadaId: openJornadaId,
            },
        });

        // A DEBT sale with a PAID debtor is inconsistent legacy data; preserve the special guard.
        expect(await updateSaleQuantity(sale.id, 2, productId)).toMatchObject({ success: false, error: "CANNOT_MODIFY_PAID_DEBT" });

        const debtorRow = await prisma.debtors.findUnique({
            where: { saleID: sale.id },
        });
        const custRow = await prisma.customer.findUnique({
            where: { id: testCust.id },
        });

        // MUST FAIL if updateSaleQuantity updates debtorRow.amount to 120 and increments custRow.currentBalance by 60
        expect(Number(debtorRow?.amountCents)).toBe(6000);
        expect(Number(custRow?.currentBalanceCents)).toBe(0);
    });
});
