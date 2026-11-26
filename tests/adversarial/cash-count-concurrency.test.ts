import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../helpers/database");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { closeJornada, openJornada, recordCashCount } from "@/lib/actions/jornada";
import { saveExpense } from "@/lib/actions/expenses";
import { createSale } from "@/lib/actions/sales";
import { orderedJornadaActions } from "../helpers/concurrency";
import { makeCashCountInput, loginAs, resetDb } from "../helpers/database";

describe("cash count concurrency", () => {
    let adminId: number;
    let jornadaId: number;

    beforeEach(async () => {
        await resetDb();
        const admin = await prisma.users.create({ data: { name: "Concurrency Admin", email: "cash-race@test.local", role: "ADMIN", active: true } });
        adminId = admin.id;
        loginAs("ADMIN", adminId);
        const opened = await openJornada(makeCashCountInput(50000));
        if (!opened.success) throw new Error(opened.error);
        jornadaId = opened.data.jornadaId;
    });

    it("orders a count and cash expense by their shared jornada lock, freezing the count cutoff", async () => {
        const [countResult, expenseResult] = await orderedJornadaActions(jornadaId, [
            () => recordCashCount(jornadaId, makeCashCountInput(50000)),
            () => saveExpense({ amount: 25, category: "Race", description: "Raced after count", date: new Date(), payment_method: "CASH" }),
        ]);
        expect(countResult).toMatchObject({ success: true, data: { expectedAmount: 50000, difference: 0 } });
        expect(expenseResult).toMatchObject({ success: true });
        const row = await prisma.cash_count.findFirstOrThrow({ where: { jornadaId, type: "INTERIM" } });
        expect(Number(row.expectedAmountCents)).toBe(50000);
    });

    it("serializes two closures so exactly one closing count is committed", async () => {
        const results = await orderedJornadaActions(jornadaId, [
            () => closeJornada(jornadaId, makeCashCountInput(50000)),
            () => closeJornada(jornadaId, makeCashCountInput(50000)),
        ]);
        expect(results.filter(result => (result as { success: boolean }).success)).toHaveLength(1);
        expect(await prisma.cash_count.count({ where: { jornadaId, type: "CLOSING" } })).toBe(1);
        expect((await prisma.jornada.findUniqueOrThrow({ where: { id: jornadaId } })).status).toBe("CLOSED");
    });

    it("does not strand a sale when closure wins the jornada lock", async () => {
        const product = await prisma.products.create({ data: { name: "Race taco", priceCents: 5000 } });
        const [closeResult, saleResult] = await orderedJornadaActions(jornadaId, [
            () => closeJornada(jornadaId, makeCashCountInput(50000)),
            () => createSale([{ productID: product.id, quantity: 1 }], "UNPAID", "MESA_3", -1),
        ]);
        expect(closeResult).toMatchObject({ success: true });
        expect(saleResult).toMatchObject({ success: false });
        expect(await prisma.sales.count({ where: { jornadaId, status: "UNPAID" } })).toBe(0);
        expect((await prisma.jornada.findUniqueOrThrow({ where: { id: jornadaId } })).status).toBe("CLOSED");
    });
});
