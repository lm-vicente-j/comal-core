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
            data: { name: "Harina Round6", measureUnit: "kg", currentStock: 100, unitCost: 10 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Torta Round6",
                price: 50,
                recipes: { create: [{ supplyID: supplyId, quantityUsed: 1 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Round6", phone: "555-6666", currentBalance: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FALLO 1: toDebt concurrente no debe duplicar el saldo incrementado en customer.currentBalance
     */
    it("FALLO 1: concurrent toDebt calls on the same UNPAID sale must not double-increment currentBalance", async () => {
        loginAs("ADMIN", adminId);

        const testCust = await prisma.customer.create({
            data: { customerName: "Cliente Carrera toDebt R6", currentBalance: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                total: 100,
                status: "UNPAID",
                placedBy: adminId,
                jornadaId: openJornadaId,
            },
        });

        // Ejecutar dos toDebt concurrentes
        await Promise.all([
            toDebt(testCust.id, [{ id: sale.id }]),
            toDebt(testCust.id, [{ id: sale.id }]),
        ]);

        const updatedCust = await prisma.customer.findUnique({
            where: { id: testCust.id },
        });

        // DEBE FALLAR: Actualmente ambas operaciones se ejecutan y el saldo queda en 200 en lugar de 100
        expect(Number(updatedCust?.currentBalance)).toBe(100);
    });

    /**
     * FALLO 2: payAccount debe rechazar peticiones con IDs de ventas no válidas o inexistentes (no silent partial payment)
     */
    it("FALLO 2: payAccount should reject when any requested sale is non-existent or ineligible", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                total: 50,
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
                amount: 50,
                status: SaleStatus.DEBT,
                createdJornadaId: openJornadaId,
            },
        });

        const res = await payAccount(customerId, [{ id: sale.id }, { id: 999999 }], "CASH");

        // DEBE FALLAR: Actualmente payAccount descarta 999999 silenciosamente y responde { msg: "SUCCESS" }
        expect(res).toMatchObject({ msg: "INVALID_INPUT" });
    });

    /**
     * FALLO 3: payAccount debe rechazar ventas cuya fila en debtors está en CANCELLED o PAID
     */
    it("FALLO 3: payAccount should reject sales where debtor row is not in DEBT status", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                total: 50,
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
                amount: 50,
                status: SaleStatus.CANCELLED, // deudor cancelado
                createdJornadaId: openJornadaId,
            },
        });

        const res = await payAccount(customerId, [{ id: sale.id }], "CASH");

        // DEBE FALLAR: Actualmente payAccount acepta la venta y decrementa el saldo
        expect(res).toMatchObject({ msg: "INVALID_INPUT" });
    });

    /**
     * FALLO 4: createSale con customerID inexistente debe retornar { success: false, error: "INVALID_INPUT" }
     */
    it("FALLO 4: createSale with non-existent customerID should return INVALID_INPUT instead of Prisma P2003/P2025 error", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale(
            [{ productID: productId, quantity: 1 }],
            "DEBT",
            "VENTA_LIBRE",
            999999,
            "CASH"
        );

        // DEBE FALLAR: Actualmente arroja P2003 / P2025 y devuelve INTERNAL ERROR
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });

    /**
     * FALLO 5: getCustomerDebtAccounts y getAllDebtors no deben listar ventas en estado PAID aunque debtors esté en DEBT
     */
    it("FALLO 5: getCustomerDebtAccounts should only include sales with status DEBT, not PAID", async () => {
        loginAs("ADMIN", adminId);

        const paidSaleCust = await prisma.customer.create({
            data: { customerName: "Cliente Con Venta Paid R6", currentBalance: 50 },
        });

        const sale = await prisma.sales.create({
            data: {
                total: 50,
                status: "PAID", // La venta está en PAID
                placedBy: adminId,
                customerID: paidSaleCust.id,
                jornadaId: openJornadaId,
            },
        });
        await prisma.debtors.create({
            data: {
                saleID: sale.id,
                customerID: paidSaleCust.id,
                amount: 50,
                status: SaleStatus.DEBT, // Pero el deudor quedó en DEBT
                createdJornadaId: openJornadaId,
            },
        });

        const accounts = await getCustomerDebtAccounts(paidSaleCust.id);

        // DEBE FALLAR: Actualmente el filtro es status: { not: "CANCELLED" }, por lo que incluye la venta PAID
        expect(accounts).toEqual({ success: true, data: [] });
    });

    /**
     * FALLO 6: CustomerSchema debe aceptar clientes con campos redactados retornados por getAllCustomers para STAFF
     */
    it("FALLO 6: CustomerSchema must parse redacted customer records returned for STAFF without error", async () => {
        loginAs("STAFF", staffId);

        const customers = await getAllCustomers();
        expect(customers.length).toBeGreaterThan(0);

        // Validar el primer cliente devuelto contra CustomerSchema
        const parseRes = CustomerSchema.safeParse(customers[0]);

        // DEBE FALLAR: CustomerSchema exige currentBalance: z.number(), que viene como undefined para STAFF
        expect(parseRes.success).toBe(true);
    });

    /**
     * FALLO 7: toDebt y payAccount deben rechazar arreglos vacíos sales: [] con INVALID_INPUT
     */
    it("FALLO 7: toDebt and payAccount must reject empty sales array with INVALID_INPUT", async () => {
        loginAs("ADMIN", adminId);

        const resToDebt = await toDebt(customerId, []);
        const resPay = await payAccount(customerId, [], "CASH");

        // DEBE FALLAR: Actualmente responden NO_UNPAID_SALES y NO_DEBT_SALES
        expect(resToDebt).toMatchObject({ msg: "INVALID_INPUT" });
        expect(resPay).toMatchObject({ msg: "INVALID_INPUT" });
    });
});
