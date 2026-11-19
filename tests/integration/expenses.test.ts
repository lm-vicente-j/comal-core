import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb } from "./helpers";
import { getExpenses, saveExpense } from "@/lib/actions/expenses";

describe("expenses actions", () => {
    let adminId: number;

    beforeAll(async () => {
        await resetDb();
        const admin = await prisma.users.create({
            data: { name: "Admin Test", email: "admin@test.local", role: "ADMIN", active: true },
        });
        adminId = admin.id;
    });

    // registered_by is no longer part of the payload: the action derives it
    // from the authenticated session.
    const validExpense = () => ({
        amount: 120.5,
        category: "Insumos",
        description: "Compra de tortillas",
        date: new Date(),
        payment_method: "CASH" as const,
    });

    it("rejects saveExpense without a session", async () => {
        logout();
        expect(await saveExpense(validExpense())).toMatchObject({ success: false, error: "UNAUTHORIZED" });
        expect(await prisma.bill.count()).toBe(0);
    });

    it("fails with NO_OPEN_JORNADA when no jornada is open", async () => {
        loginAs("ADMIN", adminId);
        expect(await saveExpense(validExpense())).toMatchObject({ success: false, error: "NO_OPEN_JORNADA" });
        expect(await prisma.bill.count()).toBe(0);
    });

    it("creates the bill linked to the open jornada", async () => {
        loginAs("ADMIN", adminId);
        const jornada = await prisma.jornada.create({
            data: { openedBy: adminId, openingAmount: 500, status: "OPEN" },
        });

        const res = await saveExpense(validExpense());
        expect(res).toMatchObject({ success: true });

        const bill = await prisma.bill.findFirstOrThrow();
        expect(Number(bill.amount)).toBe(120.5);
        expect(bill.category).toBe("Insumos");
        expect(bill.description).toBe("Compra de tortillas");
        expect(bill.registered_by).toBe(adminId);
        expect(bill.jornadaId).toBe(jornada.id);
        expect(bill.payment_method).toBe("CASH");
    });

    it("stores a transfer expense with its method", async () => {
        loginAs("ADMIN", adminId);
        const res = await saveExpense({ ...validExpense(), description: "Pago de luz", payment_method: "TRANSFER" });
        expect(res).toMatchObject({ success: true });

        const bill = await prisma.bill.findFirstOrThrow({ where: { description: "Pago de luz" } });
        expect(bill.payment_method).toBe("TRANSFER");
        await prisma.bill.delete({ where: { id: bill.id } });
    });

    it("requires a payment method instead of defaulting to cash", async () => {
        loginAs("ADMIN", adminId);
        const res = await saveExpense({ ...validExpense(), payment_method: undefined as never });
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.payment_method).toBeDefined();
        expect(await prisma.bill.count()).toBe(1);
    });

    it("rejects invalid data with field errors", async () => {
        loginAs("ADMIN", adminId);
        const res = await saveExpense({ ...validExpense(), amount: 0 });
        expect(res.success).toBe(false);
        expect(res.fieldErrors).toBeDefined();
        expect(await prisma.bill.count()).toBe(1);
    });

    it("paginates the history and aggregates the all-time total", async () => {
        loginAs("ADMIN", adminId);
        const jornada = await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } });
        await prisma.bill.createMany({
            data: Array.from({ length: 34 }, (_, i) => ({
                amount: 10,
                category: "Otros",
                description: `Gasto ${i}`,
                date: new Date(),
                registered_by: adminId,
                jornadaId: jornada.id,
                payment_method: "CASH" as const,
            })),
        });

        const page1 = await getExpenses(0, 30);
        expect(page1.items.length).toBe(30);
        expect(page1.hasMore).toBe(true);
        expect(page1.total).toBeCloseTo(120.5 + 34 * 10);

        const page2 = await getExpenses(30, 30);
        expect(page2.items.length).toBe(5);
        expect(page2.hasMore).toBe(false);
    });

    it("returns null or empty descriptions for legacy bills without error", async () => {
        loginAs("ADMIN", adminId);
        const jornada = await prisma.jornada.findFirstOrThrow({ where: { status: "OPEN" } });
        const legacyNullBill = await prisma.bill.create({
            data: {
                amount: 50,
                category: "Otros",
                description: null,
                date: new Date(),
                registered_by: adminId,
                jornadaId: jornada.id,
                payment_method: "CASH",
            },
        });
        const legacyEmptyBill = await prisma.bill.create({
            data: {
                amount: 60,
                category: "Otros",
                description: "",
                date: new Date(),
                registered_by: adminId,
                jornadaId: jornada.id,
                payment_method: "CASH",
            },
        });
        const legacyWhitespaceBill = await prisma.bill.create({
            data: {
                amount: 70,
                category: "Otros",
                description: "   ",
                date: new Date(),
                registered_by: adminId,
                jornadaId: jornada.id,
                payment_method: "CASH",
            },
        });

        try {
            const res = await getExpenses(0, 10);
            const nullItem = res.items.find((b) => b.id === legacyNullBill.id);
            expect(nullItem).toBeDefined();
            expect(nullItem?.description).toBeNull();

            const emptyItem = res.items.find((b) => b.id === legacyEmptyBill.id);
            expect(emptyItem).toBeDefined();
            expect(emptyItem?.description).toBe("");

            const whitespaceItem = res.items.find((b) => b.id === legacyWhitespaceBill.id);
            expect(whitespaceItem).toBeDefined();
            expect(whitespaceItem?.description).toBe("   ");
        } finally {
            await prisma.bill.deleteMany({
                where: { id: { in: [legacyNullBill.id, legacyEmptyBill.id, legacyWhitespaceBill.id] } },
            });
        }
    });

    it("returns an empty page without a session", async () => {
        logout();
        expect(await getExpenses()).toEqual({ items: [], total: 0, hasMore: false });
    });
});
