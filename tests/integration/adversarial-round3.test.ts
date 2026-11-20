import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { createSale, updateSaleQuantity } from "@/lib/actions/sales";
import { getAllCustomers } from "@/lib/actions/customers";

describe("Adversarial Round 3 Reproduction Tests (Must Fail Against Current Code)", () => {
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
            data: { name: "Harina Round3", measureUnit: "kg", currentStock: 50, unitCost: 15 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Tamal Round3",
                price: 30,
                recipes: { create: [{ supplyID: supplyId, quantityUsed: 1 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Round3", phone: "555-1111", currentBalance: 150 },
        });
        customerId = customer.id;
    });

    /**
     * FINDING 1 (High): updateSaleQuantity must not allow modifying CANCELLED sales
     * Cancelled sales already had their inventory restored. Modifying a CANCELLED sale's items
     * retroactively deducts inventory from a dead sale.
     */
    it("FINDING 1: updateSaleQuantity should reject modifying sales that are CANCELLED", async () => {
        loginAs("ADMIN", adminId);

        const cancelledSale = await prisma.sales.create({
            data: {
                total: 30,
                status: "CANCELLED",
                payment_method: "CASH",
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [{ productID: productId, quantity: 1, unitPrice: 30, subtotal: 30 }],
                },
            },
        });

        // Attempt to alter the items of a cancelled sale
        const result = await updateSaleQuantity(cancelledSale.id, 5, productId);

        // MUST REJECT: updateSaleQuantity must not allow altering CANCELLED sales
        expect(result).toMatchObject({ success: false });

        const saleAfter = await prisma.sales.findUniqueOrThrow({ where: { id: cancelledSale.id } });
        expect(Number(saleAfter.total)).toBe(30);
    });

    /**
     * FINDING 2 (High): createSale must reject DEBT sales when customerID is invalid (e.g. -1)
     * Anonymous debts without a customer cannot be created, as they become orphaned in the system.
     */
    it("FINDING 2: createSale should reject creating DEBT sales without a valid customer ID", async () => {
        loginAs("ADMIN", adminId);

        // Attempt to record a DEBT sale without an assigned customer (customerID = -1)
        const result = await createSale(
            [{ productID: productId, quantity: 2 }],
            "DEBT",
            "VENTA_LIBRE",
            -1
        );

        // MUST FAIL if createSale creates a DEBT sale with customerID null and no debtors row
        expect(result).toMatchObject({ success: false, error: "INVALID_INPUT" });

        const orphanSale = await prisma.sales.findFirst({
            where: { status: "DEBT", customerID: null },
        });
        expect(orphanSale).toBeNull();
    });

    /**
     * FINDING 3 (High): getAllCustomers must serialize currentBalance to primitive Number for ADMIN role
     * Avoids serialization exceptions ("Only plain objects can be passed to Client Components") in Next.js RSC.
     */
    it("FINDING 3: getAllCustomers should serialize Decimal currentBalance to number for ADMIN", async () => {
        loginAs("ADMIN", adminId);

        const customers = await getAllCustomers();
        const testCust = customers.find((c) => c.id === customerId);

        expect(testCust).toBeDefined();
        // MUST FAIL if it returns a Prisma.Decimal instance (typeof === 'object') instead of a primitive number
        expect(typeof testCust?.currentBalance).toBe("number");
    });
});
