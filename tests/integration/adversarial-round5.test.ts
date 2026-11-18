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
     * FALLO 1 (Alta): getAllDebtors y getDebtsSummary deben excluir ventas canceladas
     * de los montos y conteos de deudores activos.
     */
    it("FALLO 1: getAllDebtors and getDebtsSummary should exclude CANCELLED sales from active debt sums", async () => {
        loginAs("ADMIN", adminId);

        const cancelCust = await prisma.customer.create({
            data: { customerName: "Cliente Con Venta Cancelada R5", currentBalance: 100 },
        });

        // Crear venta CANCELLED que aún tiene fila en debtors como DEBT
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

        // DEBE FALLAR: Actualmente getAllDebtors suma el debtors.status = DEBT sin verificar que la venta esté CANCELLED
        expect(debtorItem?.amount ?? 0).toBe(0);
    });

    /**
     * FALLO 2 (Alta): toDebt debe rechazar customerId inexistente con INVALID_INPUT
     * en lugar de fallar con INTERNAL ERROR / Prisma P2025.
     */
    it("FALLO 2: toDebt should reject non-existent customerId with INVALID_INPUT", async () => {
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

        // DEBE FALLAR: Actualmente arroja P2025 y devuelve { msg: "INTERNAL ERROR", error: ... }
        expect(res).toMatchObject({ msg: "INVALID_INPUT" });
    });

    /**
     * FALLO 3 (Media): toDebt debe rechazar conversiones parciales cuando alguna venta no existe o no es UNPAID
     */
    it("FALLO 3: toDebt should reject when not all requested sales are eligible (no partial silent conversion)", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                total: 45,
                status: "UNPAID",
                placedBy: adminId,
                jornadaId: openJornadaId,
            },
        });

        // Venta válida 1 + Venta inexistente 99999
        const res = await toDebt(customerId, [{ id: sale.id }, { id: 99999 }]);

        // DEBE FALLAR: Actualmente procesa la venta válida silenciosamente y devuelve { msg: "SUCCESS" }
        expect(res).toMatchObject({ msg: "INVALID_INPUT" });
    });

    /**
     * FALLO 4 (Alta): payAccount debe rechazar ventas en deuda que no tengan registro asociado en debtors
     */
    it("FALLO 4: payAccount should reject debt sales that have no debtor row", async () => {
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

        // DEBE FALLAR: Actualmente acepta s.debtors === null y descuenta del saldo del cliente
        expect(res).toMatchObject({ msg: "INVALID_INPUT" });
    });

    /**
     * FALLO 5 (Media): createSale debe rechazar órdenes con sale_items vacío ([])
     */
    it("FALLO 5: createSale should reject empty sale_items array", async () => {
        loginAs("ADMIN", adminId);

        const res = await createSale([], "PAID", "VENTA_LIBRE", -1, "CASH");

        // DEBE FALLAR: Actualmente createSale permite crear ventas vacías con total $0
        expect(res).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });
});
