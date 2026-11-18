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
     * FALLO 1 (Alta): updateSaleQuantity no debe permitir modificar ventas en estado CANCELLED
     * Las ventas canceladas tienen inventario ya repuesto. Modificar la comanda de una venta CANCELLED
     * descuenta inventario retrospectivamente de una venta muerta.
     */
    it("FALLO 1: updateSaleQuantity should reject modifying sales that are CANCELLED", async () => {
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

        // Intentar alterar la comanda de una venta cancelada
        const result = await updateSaleQuantity(cancelledSale.id, 5, productId);

        // DEBE RECHAZAR: updateSaleQuantity no debe permitir alterar ventas CANCELLED
        expect(result).toMatchObject({ success: false });

        const saleAfter = await prisma.sales.findUniqueOrThrow({ where: { id: cancelledSale.id } });
        expect(Number(saleAfter.total)).toBe(30);
    });

    /**
     * FALLO 2 (Alta): createSale debe rechazar ventas en estado DEBT si customerID no es válido (ej. -1)
     * No se pueden generar deudas anónimas sin cliente que quedan huérfanas en el sistema.
     */
    it("FALLO 2: createSale should reject creating DEBT sales without a valid customer ID", async () => {
        loginAs("ADMIN", adminId);

        // Intentar registrar una venta DEBT sin cliente asignado (customerID = -1)
        const result = await createSale(
            [{ productID: productId, quantity: 2 }],
            "DEBT",
            "VENTA_LIBRE",
            -1
        );

        // DEBE FALLAR: Actualmente createSale crea la venta con status DEBT y customerID null sin crear registro en debtors
        expect(result).toMatchObject({ success: false, error: "INVALID_INPUT" });

        const orphanSale = await prisma.sales.findFirst({
            where: { status: "DEBT", customerID: null },
        });
        expect(orphanSale).toBeNull();
    });

    /**
     * FALLO 3 (Alta): getAllCustomers debe serializar currentBalance a tipo primitivo Number para rol ADMIN
     * Para evitar excepciones de serialización ("Only plain objects can be passed to Client Components") en Next.js RSC.
     */
    it("FALLO 3: getAllCustomers should serialize Decimal currentBalance to number for ADMIN", async () => {
        loginAs("ADMIN", adminId);

        const customers = await getAllCustomers();
        const testCust = customers.find((c) => c.id === customerId);

        expect(testCust).toBeDefined();
        // DEBE FALLAR: Actualmente retorna una instancia de Prisma.Decimal (typeof === 'object'), no un primitivo number
        expect(typeof testCust?.currentBalance).toBe("number");
    });
});
