import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getAllDebtors, toDebt, payAccount } from "@/lib/actions/debts";
import { createSale, updateSaleQuantity } from "@/lib/actions/sales";
import { saveCustomer, searchCustomers } from "@/lib/actions/customers";
import { SaleStatus } from "@/app/generated/prisma/enums";

describe("Adversarial Round 7 Reproduction Tests (Must Fail Against Current Code)", () => {
    let adminId: number;
    let openJornadaId: number;
    let productId: number;
    let supplyId: number;
    let customerId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        openJornadaId = jornada.id;

        const supply = await prisma.supplies.create({
            data: { name: "Harina Round7", measureUnit: "kg", currentStock: 100, unitCost: 10 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Torta Round7",
                price: 60,
                recipes: { create: [{ supplyID: supplyId, quantityUsed: 1 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Base R7", phone: "555-7777", currentBalance: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FALLO 1: createSale con customerID negativo distinto de -1 (-2, -99) debe retornar INVALID_INPUT
     */
    it("FALLO 1: createSale with negative customerID other than -1 must return INVALID_INPUT", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "PAID",
            "VENTA_LIBRE",
            -2,
            "CASH"
        );

        // DEBE FALLAR: Actualmente cae en Prisma P2003/P2025 y retorna INTERNAL ERROR
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });

    /**
     * FALLO 2: saveCustomer sin campo phone debe preservar el teléfono existente en lugar de sobreescribirlo con null
     */
    it("FALLO 2: saveCustomer without phone field should preserve existing phone", async () => {
        loginAs("ADMIN", adminId);

        const testCust = await prisma.customer.create({
            data: { customerName: "Cliente Con Telefono R7", phone: "555-9876", currentBalance: 0 },
        });

        // Actualizar solo el nombre, sin pasar phone
        const updateRes = await saveCustomer({
            id: testCust.id,
            customerName: "Cliente Con Telefono R7 Modificado",
        });
        expect(updateRes.success).toBe(true);

        const afterUpdate = await prisma.customer.findUnique({
            where: { id: testCust.id },
        });

        // DEBE FALLAR: Actualmente update: { phone } evalúa phone a null y borra el teléfono
        expect(afterUpdate?.phone).toBe("555-9876");
    });

    /**
     * FALLO 3: searchCustomers(undefined) no debe arrojar TypeError no capturado
     */
    it("FALLO 3: searchCustomers with non-string/undefined query should return empty array safely", async () => {
        loginAs("ADMIN", adminId);

        // DEBE FALLAR: query.trim() se ejecuta fuera del try/catch y lanza TypeError
        const res = await searchCustomers(undefined as any);
        expect(res).toEqual([]);
    });

    /**
     * FALLO 4: saveCustomer debe validar longitud máxima de phone (20 caracteres) retornando fieldErrors
     */
    it("FALLO 4: saveCustomer should reject phone numbers longer than 20 characters with fieldErrors", async () => {
        loginAs("ADMIN", adminId);

        const res = await saveCustomer({
            customerName: "Cliente Phone Largo R7",
            phone: "1234567890123456789012345", // 25 chars
        });

        // DEBE FALLAR: CustomerSchema no valida longitud de phone y Prisma arroja P2000
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.phone).toBeDefined();
    });

    /**
     * FALLO 5: updateSaleQuantity no debe modificar filas en debtors ni balance si debtors.status es PAID o CANCELLED
     */
    it("FALLO 5: updateSaleQuantity must not update debtor amount or customerBalance if debtor is already PAID", async () => {
        loginAs("ADMIN", adminId);

        const testCust = await prisma.customer.create({
            data: { customerName: "Cliente Deuda Pagada R7", currentBalance: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                total: 60,
                status: "DEBT",
                placedBy: adminId,
                customerID: testCust.id,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [{ productID: productId, quantity: 1, unitPrice: 60, subtotal: 60 }],
                },
            },
        });

        await prisma.debtors.create({
            data: {
                saleID: sale.id,
                customerID: testCust.id,
                amount: 60,
                status: SaleStatus.PAID, // Ya fue saldado
                createdJornadaId: openJornadaId,
            },
        });

        // Cambiar cantidad de 1 a 2
        await updateSaleQuantity(sale.id, 2, productId);

        const debtorRow = await prisma.debtors.findUnique({
            where: { saleID: sale.id },
        });
        const custRow = await prisma.customer.findUnique({
            where: { id: testCust.id },
        });

        // DEBE FALLAR: Actualmente updateSaleQuantity actualiza debtorRow.amount a 120 e incrementa custRow.currentBalance en 60
        expect(Number(debtorRow?.amount)).toBe(60);
        expect(Number(custRow?.currentBalance)).toBe(0);
    });
});
