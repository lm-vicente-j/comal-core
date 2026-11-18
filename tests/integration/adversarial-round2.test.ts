import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
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
            data: { name: "Masa Round2", measureUnit: "kg", currentStock: 100, unitCost: 10 },
        });
        supplyId = supply.id;

        const product = await prisma.products.create({
            data: {
                name: "Gordita Round2",
                price: 25,
                recipes: { create: [{ supplyID: supplyId, quantityUsed: 1 }] },
            },
        });
        productId = product.id;

        const customer = await prisma.customer.create({
            data: { customerName: "Cliente Round2", phone: "555-9999", currentBalance: 0 },
        });
        customerId = customer.id;
    });

    /**
     * FALLO 1 (Crítico): Condición de carrera con doble incremento de saldo en toDebt
     * Dos llamadas concurrentes a toDebt sobre la misma venta no deben duplicar
     * el incremento de saldo en customer.currentBalance.
     */
    it("FALLO 1: toDebt should prevent race condition and double increment on concurrent calls", async () => {
        loginAs("ADMIN", adminId);

        const testCustomer = await prisma.customer.create({
            data: { customerName: "Cliente Carrera toDebt", currentBalance: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                total: 100,
                status: "UNPAID",
                placedBy: adminId,
                customerID: testCustomer.id,
                jornadaId: openJornadaId,
            },
        });

        // Simular concurrencia en la lectura de findMany de ventas UNPAID
        const originalFindMany = prisma.sales.findMany;
        vi.spyOn(prisma.sales, "findMany").mockImplementation(async (args: any) => {
            const res = await originalFindMany.call(prisma.sales, args);
            if (args?.where?.status === "UNPAID") {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return res;
        });

        try {
            const [res1, res2] = await Promise.all([
                toDebt(testCustomer.id, [{ id: sale.id, total: 100 } as any]),
                toDebt(testCustomer.id, [{ id: sale.id, total: 100 } as any]),
            ]);
            console.log("toDebt results:", { res1, res2 });

            const customerAfter = await prisma.customer.findUniqueOrThrow({
                where: { id: testCustomer.id },
            });

            // DEBE FALLAR: Ambas peticiones leen UNPAID e incrementan 100 cada una, dejando el saldo en 200 en lugar de 100
            expect(Number(customerAfter.currentBalance)).toBe(100);
        } finally {
            vi.restoreAllMocks();
        }
    });

    /**
     * FALLO 2 (Alta): getSalesHistory debe serializar unitPrice, subtotal y customer.currentBalance a tipos primitivos Number
     * Para evitar errores en Next.js Server Components -> Client Components ("Only plain objects can be passed").
     */
    it("FALLO 2: getSalesHistory should serialize Decimal fields (unitPrice, subtotal, currentBalance) to plain numbers", async () => {
        loginAs("ADMIN", adminId);

        const sale = await prisma.sales.create({
            data: {
                total: 50,
                status: "PAID",
                payment_method: "CASH",
                placedBy: adminId,
                customerID: customerId,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [
                        { productID: productId, quantity: 2, unitPrice: 25, subtotal: 50 },
                    ],
                },
            },
        });

        const history = await getSalesHistory();
        const found = history.find((s) => s.id === sale.id);
        expect(found).toBeDefined();

        const item = found?.sale_items[0];
        // DEBE FALLAR: Actualmente unitPrice y subtotal son instancias de Prisma.Decimal (typeof === 'object'), no primitivos number
        expect(typeof item?.unitPrice).toBe("number");
        expect(typeof item?.subtotal).toBe("number");
        expect(typeof (found?.customer as any)?.currentBalance).toBe("number");
    });

    /**
     * FALLO 3 (Alta): updateSaleQuantity no debe desincronizar debtors.amount ni customer.currentBalance en ventas DEBT
     * Si se modifica la comanda de una venta en DEBT, la deuda asociada y el balance del cliente deben actualizarse.
     */
    it("FALLO 3: updateSaleQuantity should synchronize debtors.amount and customer balance when sale is in DEBT", async () => {
        loginAs("ADMIN", adminId);

        const debtCustomer = await prisma.customer.create({
            data: { customerName: "Cliente UpdateQty DEBT", currentBalance: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                total: 25,
                status: "UNPAID",
                placedBy: adminId,
                customerID: debtCustomer.id,
                jornadaId: openJornadaId,
                sale_items: {
                    create: [{ productID: productId, quantity: 1, unitPrice: 25, subtotal: 25 }],
                },
            },
        });

        // Convertir a DEBT: ahora debtors.amount = 25 y customer.currentBalance = 25
        await toDebt(debtCustomer.id, [{ id: sale.id, total: 25 } as any]);

        // El mesero o cajero actualiza la cantidad de 1 a 3 gorditas ($75 total)
        await updateSaleQuantity(sale.id, 3, productId);

        const updatedDebtor = await prisma.debtors.findUniqueOrThrow({
            where: { saleID: sale.id },
        });
        const updatedCustomer = await prisma.customer.findUniqueOrThrow({
            where: { id: debtCustomer.id },
        });

        // DEBE FALLAR: updateSaleQuantity solo actualiza sales.total a 75,
        // dejando debtors.amount en 25 y customer.currentBalance en 25 (desincronización crítica)
        expect(Number(updatedDebtor.amount)).toBe(75);
        expect(Number(updatedCustomer.currentBalance)).toBe(75);
    });

    /**
     * FALLO 4 (Alta): getDebtsSummary no debe sumar cobros de ventas canceladas en todayPayments
     * Si una deuda pagada pertenece a una venta que posteriormente se cancela, no debe computar como cobranza real del día.
     */
    it("FALLO 4: getDebtsSummary should exclude collections from CANCELLED sales in todayPayments", async () => {
        loginAs("ADMIN", adminId);

        const cancelCustomer = await prisma.customer.create({
            data: { customerName: "Cliente Cancel Debt", currentBalance: 0 },
        });

        const sale = await prisma.sales.create({
            data: {
                total: 200,
                status: "UNPAID",
                placedBy: adminId,
                customerID: cancelCustomer.id,
                jornadaId: openJornadaId,
            },
        });

        await toDebt(cancelCustomer.id, [{ id: sale.id, total: 200 } as any]);
        await payAccount(cancelCustomer.id, [{ id: sale.id } as any], "CASH");
        await cancelSaleAction(sale.id);

        const summary = await getDebtsSummary();
        // DEBE FALLAR: getDebtsSummary hace aggregate en debtors con status: PAID sin validar sales: { status: 'PAID' },
        // por lo que todayPayments sigue incluyendo los 200 de la venta cancelada
        expect(summary.todayPayments).toBe(0);
    });

    /**
     * FALLO 5 (Media): getAllDebtors no debe retornar un número de página arbitrario cuando no hay registros (total === 0)
     * Si se solicita page: 5 con una búsqueda vacía, page debe ajustarse a 1 o totalPages (0/1) en lugar de retornar page: 5.
     */
    it("FALLO 5: getAllDebtors should normalize page when total matches is 0", async () => {
        loginAs("ADMIN", adminId);

        const result = await getAllDebtors({ page: 5, search: "NonExistentCustomerNameXYZ" });

        // DEBE FALLAR: Actualmente retorna { total: 0, totalPages: 0, page: 5 } dejando al cliente con page = 5
        expect(result.total).toBe(0);
        expect(result.page).toBeLessThanOrEqual(1);
    });
});
