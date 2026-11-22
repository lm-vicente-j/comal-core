import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { deleteSupply, getSuppliesData, saveSupply } from "@/lib/actions/inventory";

describe("inventory actions", () => {
    beforeAll(async () => {
        await resetDb();
        await seedBase();
    });

    const supply = { name: "Maíz", measureUnit: "kg", currentStock: 50000, unitCost: 1200 };

    it("rejects saveSupply for non-admin sessions", async () => {
        logout();
        expect(await saveSupply(supply)).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        loginAs("STAFF");
        expect(await saveSupply(supply)).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        expect(await prisma.supplies.count()).toBe(0);
    });

    it("creates a supply", async () => {
        loginAs("ADMIN");
        expect(await saveSupply(supply)).toMatchObject({ success: true });

        const row = await prisma.supplies.findFirstOrThrow({ where: { name: "Maíz" } });
        expect(row.measureUnit).toBe("kg");
        expect(Number(row.currentStockMilliunits)).toBe(50000);
        expect(Number(row.unitCostCents)).toBe(1200);
        expect(row.active).toBe(true);
    });

    it("updates a supply by id", async () => {
        loginAs("ADMIN");
        const existing = await prisma.supplies.findFirstOrThrow();

        const res = await saveSupply({ ...supply, id: existing.id, name: "Maíz Azul", currentStock: 80000 });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.supplies.findUniqueOrThrow({ where: { id: existing.id } });
        expect(row.name).toBe("Maíz Azul");
        expect(Number(row.currentStockMilliunits)).toBe(80000);
        expect(await prisma.supplies.count()).toBe(1);
    });

    it("rejects invalid data with field errors", async () => {
        loginAs("ADMIN");
        const res = await saveSupply({ ...supply, unitCost: 0 });
        expect(res.success).toBe(false);
        expect(res.fieldErrors).toBeDefined();
    });

    it("deleteSupply soft-deletes (active=false) and hides it from the list", async () => {
        loginAs("ADMIN");
        const existing = await prisma.supplies.findFirstOrThrow();

        expect(await deleteSupply(existing.id)).toMatchObject({ success: true });

        const row = await prisma.supplies.findUniqueOrThrow({ where: { id: existing.id } });
        expect(row.active).toBe(false);

        expect(await getSuppliesData()).toEqual([]);
    });

    it("getSuppliesData is empty without a session", async () => {
        logout();
        expect(await getSuppliesData()).toEqual([]);
    });

    it("deleteSupply rejects a malformed id", async () => {
        loginAs("ADMIN");
        expect(await deleteSupply("7" as never)).toMatchObject({ success: false, error: "INVALID_INPUT" });
    });
});
