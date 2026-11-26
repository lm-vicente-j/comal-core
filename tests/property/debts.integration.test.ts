import { expect, it, vi } from "vitest";
import fc from "fast-check";

vi.mock("@/lib/auth", async () => ({ auth: (await import("../helpers/database")).authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { createSale } from "@/lib/actions/sales";
import { toDebt, payAccount } from "@/lib/actions/debts";
import { closeJornada, openJornada } from "@/lib/actions/jornada";
import { getJornadaCashSummary } from "@/lib/jornada-cash";
import { loginAs, resetDb, seedBase, makeCashCountInput } from "../helpers/database";
import { checkGenerated, paymentMethod } from "../helpers/generators";

it("customer-balance-and-cross-jornada-collections", async () => {
    const order = fc.record({ quantity: fc.integer({ min: 1, max: 12 }), collect: fc.boolean(), method: paymentMethod });
    await checkGenerated("customer-balance-and-cross-jornada-collections", fc.asyncProperty(fc.array(order, { minLength: 1, maxLength: 6 }), fc.integer({ min: 1, max: 1000 }), async (orders, recipeQuantity) => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        loginAs("ADMIN", admin.id);
        const customer = await prisma.customer.create({ data: { customerName: "Property customer", currentBalanceCents: 0 } });
        const supply = await prisma.supplies.create({ data: { name: "Property supply", measureUnit: "kg", currentStockMilliunits: 100000, unitCostCents: 50 } });
        const product = await prisma.products.create({ data: { name: "Property recipe", priceCents: 2500, recipes: { create: { supplyID: supply.id, quantityUsedMilliunits: recipeQuantity } } } });
        const sales: number[] = [];
        let balance = BigInt(0);
        for (const order of orders) {
            const sale = await createSale([{ productID: product.id, quantity: order.quantity }], "UNPAID", `CL- ${customer.id}`, customer.id);
            expect(sale.success).toBe(true);
            if (!sale.success) throw new Error(sale.error);
            sales.push(sale.data.saleId);
            expect(await toDebt(customer.id, [{ id: sale.data.saleId }], order.quantity * 2500)).toMatchObject({ success: true });
            balance += BigInt(order.quantity) * BigInt(2500);
            expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).currentBalanceCents).toBe(balance);
        }
        expect((await prisma.supplies.findUniqueOrThrow({ where: { id: supply.id } })).currentStockMilliunits)
            .toBe(BigInt(100000) - orders.reduce((sum, order) => sum + BigInt(order.quantity) * BigInt(recipeQuantity), BigInt(0)));
        expect(await closeJornada(jornada.id, makeCashCountInput(50000))).toMatchObject({ success: true });
        const closed = await prisma.cash_count.findFirstOrThrow({ where: { jornadaId: jornada.id, type: "CLOSING" } });
        const opened = await openJornada(makeCashCountInput(50000));
        expect(opened.success).toBe(true);
        if (!opened.success) throw new Error(opened.error);
        let cash = BigInt(0);
        let transfer = BigInt(0);
        for (let i = 0; i < orders.length; i++) {
            const order = orders[i];
            if (!order.collect) continue;
            expect(await payAccount(customer.id, [{ id: sales[i] }], order.method)).toMatchObject({ success: true });
            expect(await payAccount(customer.id, [{ id: sales[i] }], order.method)).toMatchObject({ success: false });
            const amount = BigInt(order.quantity) * BigInt(2500);
            balance -= amount;
            if (order.method === "CASH") cash += amount; else transfer += amount;
            expect((await prisma.debtors.findUniqueOrThrow({ where: { saleID: sales[i] } }))).toMatchObject({ createdJornadaId: jornada.id, paidJornadaId: opened.data.jornadaId, collectedBy: admin.id, status: "PAID" });
            const pending = await prisma.debtors.aggregate({ where: { customerID: customer.id, status: "DEBT" }, _sum: { amountCents: true } });
            expect(pending._sum.amountCents ?? BigInt(0)).toBe(balance);
            expect((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).currentBalanceCents).toBe(balance);
        }
        const summary = await getJornadaCashSummary(opened.data.jornadaId, 50000);
        expect(BigInt(summary.expectedCash)).toBe(BigInt(50000) + cash);
        expect(BigInt(summary.expectedTransfer)).toBe(transfer);
        expect(await prisma.cash_count.findUniqueOrThrow({ where: { id: closed.id } })).toEqual(closed);
        const old = await getJornadaCashSummary(jornada.id, 50000);
        expect(old.expectedCash).toBe(50000);
        expect(old.debtCollectedCash).toBe(0);
    }), true);
}, 600_000);
