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
            data: { name: "Maiz Round4", measureUnit: "kg", currentStock: 100, unitCost: 10 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Tlacoyo Round4",
                price: 30,
                recipes: { create: [{ supplyID: supplyId, quantityUsed: 1 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Round4", phone: "555-4444", currentBalance: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FALLO 1 (Media): getDebtorHistory debe serializar amount (Prisma.Decimal) a tipo Number
     * Para evitar errores en Next.js Server Components -> Client Components.
     */
    it("FALLO 1: getDebtorHistory should serialize Decimal amount to plain number", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                total: 50,
                status: "UNPAID",
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
            },
        });
        await toDebt(customerId, [{ id: sale.id, total: 50 } as any]);

        const debtor = await prisma.debtors.findUniqueOrThrow({ where: { saleID: sale.id } });

        const res = await getDebtorHistory(debtor.id);
        expect(res).toMatchObject({ success: true });

        // DEBE FALLAR: Actualmente res.data.amount es una instancia de Prisma.Decimal (typeof === 'object')
        expect(typeof (res as any).data?.amount).toBe("number");
    });

    /**
     * FALLO 2 (Alta): getCustomerDebtAccounts debe excluir notas de ventas canceladas
     * Evita que aparezcan deudas de comandas canceladas que no se pueden consultar ni cobrar.
     */
    it("FALLO 2: getCustomerDebtAccounts should not return accounts belonging to CANCELLED sales", async () => {
        loginAs("ADMIN", adminId);

        const cancelCust = await prisma.customer.create({
            data: { customerName: "Cliente Cancel Accounts", currentBalance: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                total: 60,
                status: "UNPAID",
                placedBy: adminId,
                customerID: cancelCust.id,
                jornadaId: openJornadaId,
            },
        });

        await toDebt(cancelCust.id, [{ id: sale.id, total: 60 } as any]);
        await cancelSaleAction(sale.id);

        const res = await getCustomerDebtAccounts(cancelCust.id);
        expect(res).toMatchObject({ success: true });

        // DEBE FALLAR: Actualmente getCustomerDebtAccounts solo filtra debtors con status DEBT
        // sin comprobar que la venta esté en DEBT (y no CANCELLED), retornando la nota cancelada
        expect(res.data).toEqual([]);
    });

    /**
     * FALLO 3 (Alta): updateSaleQuantity debe actualizar customer.currentBalance cuando sale.customerID es null
     * pero la venta tiene un deudor asociado con debtors.customerID.
     */
    it("FALLO 3: updateSaleQuantity should update customer balance via debtors.customerID if sale.customerID is null", async () => {
        loginAs("ADMIN", adminId);

        const balanceCust = await prisma.customer.create({
            data: { customerName: "Cliente Sin SaleCustID", currentBalance: 0 },
        });

        // Venta enviada a deuda para un cliente
        const sale = await prisma.sales.create({
            data: {
                total: 30,
                status: "UNPAID",
                placedBy: adminId,
                customerID: balanceCust.id,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [{ productID: productId, quantity: 1, unitPrice: 30, subtotal: 30 }],
                },
            },
        });

        await toDebt(balanceCust.id, [{ id: sale.id, total: 30 } as any]);

        // Simular que sale.customerID es null en la venta (mesa anónima enviada a deuda de cliente)
        await prisma.sales.update({
            where: { id: sale.id },
            data: { customerID: null },
        });

        // Actualizar la cantidad de 1 a 2 tlacoyos ($60 total, diff +30)
        await updateSaleQuantity(sale.id, 2, productId);

        const updatedCustomer = await prisma.customer.findUniqueOrThrow({
            where: { id: balanceCust.id },
        });

        // DEBE FALLAR: En updateSaleQuantity comprueba 'if (sale.customerID)', ignorando sale.debtors.customerID
        // dejando el saldo del cliente en 30 en lugar de 60
        expect(Number(updatedCustomer.currentBalance)).toBe(60);
    });

    /**
     * FALLO 4 (Media): payAccount y toDebt deben rechazar customerID <= 0 con INVALID_INPUT
     */
    it("FALLO 4: payAccount and toDebt should reject customerID <= 0 with INVALID_INPUT", async () => {
        loginAs("ADMIN", adminId);

        // DEBE FALLAR: CustomerSchema.shape.id solo valida int(), aceptando -1 y 0
        const payRes1 = await payAccount(0, [], "CASH");
        expect(payRes1).toMatchObject({ msg: "INVALID_INPUT" });

        const toDebtRes = await toDebt(-5, []);
        expect(toDebtRes).toMatchObject({ msg: "INVALID_INPUT" });
    });
});
