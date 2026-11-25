import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { Client } from "pg";
import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { getProductPage, getProductsData, saveProduct, setProductActive } from "@/lib/actions/products";
import { getSupplyPage, setSupplyActive } from "@/lib/actions/inventory";
import { cancelSaleAction, closeAccountAction, createSale, getSalesHistory, updateSaleQuantity } from "@/lib/actions/sales";

describe("catalog availability", () => {
    let adminId: number;
    let supplyId: number;
    let productId: number;
    let otherProductId: number;

    beforeEach(async () => {
        await resetDb();
        const { admin } = await seedBase();
        adminId = admin.id;
        loginAs("ADMIN", adminId);
        const supply = await prisma.supplies.create({ data: {
            name: "Masa activa", measureUnit: "kg", currentStockMilliunits: 100_000, unitCostCents: 100,
        } });
        supplyId = supply.id;
        const product = await prisma.products.create({ data: {
            name: "Taco activo", priceCents: 5000,
            recipes: { create: { supplyID: supplyId, quantityUsedMilliunits: 1000 } },
        } });
        productId = product.id;
        otherProductId = (await prisma.products.create({ data: { name: "Agua activa", priceCents: 2000 } })).id;
    });

    it("restricts status changes to admins and rejects malformed values", async () => {
        logout();
        expect((await setProductActive(productId, false)).success).toBe(false);
        expect((await setSupplyActive(supplyId, false)).success).toBe(false);
        loginAs("STAFF", adminId);
        expect((await setProductActive(productId, false)).success).toBe(false);
        expect((await setSupplyActive(supplyId, false)).success).toBe(false);
        loginAs("ADMIN", adminId);
        for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
            expect((await setProductActive(invalid, false)).success).toBe(false);
            expect((await setSupplyActive(invalid, false)).success).toBe(false);
        }
        expect((await setProductActive(productId, "false" as unknown as boolean)).success).toBe(false);
        expect((await setSupplyActive(supplyId, "false" as unknown as boolean)).success).toBe(false);
        expect((await setProductActive(2_147_483_647, false)).success).toBe(false);
        expect((await setSupplyActive(2_147_483_647, false)).success).toBe(false);
        expect((await prisma.products.findUniqueOrThrow({ where: { id: productId } })).active).toBe(true);
        expect((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).active).toBe(true);
    });

    it("combines status, stock, search and pagination with accurate counts", async () => {
        const empty = await prisma.supplies.create({ data: { name: "Masa vacía", measureUnit: "kg", currentStockMilliunits: 0, unitCostCents: 100 } });
        expect((await setSupplyActive(empty.id, false)).success).toBe(true);
        expect((await setProductActive(productId, false)).success).toBe(true);
        expect(await getProductPage()).toMatchObject({ success: true, data: { total: 1 } });
        expect(await getProductPage({ filters: { status: "inactive" } })).toMatchObject({ success: true, data: { total: 1, items: [{ id: productId }] } });
        expect(await getProductPage({ filters: { status: "all" }, pageSize: 1, page: 2 })).toMatchObject({ success: true, data: { total: 2, items: [expect.anything()] } });
        expect(await getSupplyPage()).toMatchObject({ success: true, data: { total: 1 } });
        expect(await getSupplyPage({ search: "Masa", filters: { status: "inactive", stock: "out-of-stock" } })).toMatchObject({ success: true, data: { total: 1, items: [{ id: empty.id }] } });
        expect(await getSupplyPage({ filters: { status: "all", stock: "in-stock" } })).toMatchObject({ success: true, data: { total: 1, items: [{ id: supplyId }] } });
        expect((await getProductPage({ filters: { status: "invalid" } })).success).toBe(false);
        expect((await getSupplyPage({ filters: { status: "invalid" } })).success).toBe(false);
    });

    it("excludes inactive products and products with inactive ingredients from POS and new sales", async () => {
        expect((await setProductActive(productId, false)).success).toBe(true);
        expect((await getProductsData()).map(p => p.id)).toEqual([otherProductId]);
        expect((await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_1", -1)).success).toBe(false);
        expect((await setProductActive(productId, true)).success).toBe(true);
        expect((await setSupplyActive(supplyId, false)).success).toBe(true);
        expect((await getProductsData()).map(p => p.id)).toEqual([otherProductId]);
        expect((await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_1", -1)).success).toBe(false);
        expect((await saveProduct({ name: "Nuevo taco", price: 5000, recipes: [{ supplyID: supplyId, quantityUsed: 1000 }] })).success).toBe(false);
        expect(await prisma.products.findFirst({ where: { name: "Nuevo taco" } })).toBeNull();
        expect((await prisma.products.findUniqueOrThrow({ where: { id: productId }, include: { recipes: true } })).recipes).toHaveLength(1);
        expect((await setSupplyActive(supplyId, true)).success).toBe(true);
        expect((await getProductsData()).map(p => p.id)).toContain(productId);
        expect((await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_1", -1)).success).toBe(true);
    });

    it("allows reductions and cancellation of existing sales while unavailable, restoring stock and retaining history", async () => {
        const sale = await createSale([{ productID: productId, quantity: 3 }], "UNPAID", "MESA_1", -1);
        expect(sale.success).toBe(true);
        if (!sale.success) return;
        expect((await setSupplyActive(supplyId, false)).success).toBe(true);
        expect((await updateSaleQuantity(sale.data.saleId, 4, productId)).success).toBe(false);
        expect((await updateSaleQuantity(sale.data.saleId, 2, productId)).success).toBe(true);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits)).toBe(98_000);
        expect((await cancelSaleAction(sale.data.saleId)).success).toBe(true);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits)).toBe(100_000);
        expect(await prisma.sales.findUnique({ where: { id: sale.data.saleId }, include: { sale_items: true } })).toMatchObject({ status: "CANCELLED", sale_items: [{ productID: productId }] });
        expect((await getSalesHistory()).some(s => s.id === sale.data.saleId)).toBe(true);
    });

    it("checks both the stored consumption and the current recipe when increasing an order", async () => {
        const sale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_3", -1);
        expect(sale.success).toBe(true);
        if (!sale.success) return;
        const replacement = await prisma.supplies.create({ data: { name: "Ingrediente nuevo", measureUnit: "kg", currentStockMilliunits: 50_000, unitCostCents: 100 } });
        await prisma.recipes.deleteMany({ where: { productID: productId } });
        await prisma.recipes.create({ data: { productID: productId, supplyID: replacement.id, quantityUsedMilliunits: 1000 } });
        expect((await setSupplyActive(supplyId, false)).success).toBe(true);
        expect((await updateSaleQuantity(sale.data.saleId, 2, productId)).success).toBe(false);
        expect((await setSupplyActive(supplyId, true)).success).toBe(true);
        expect((await setSupplyActive(replacement.id, false)).success).toBe(true);
        expect((await updateSaleQuantity(sale.data.saleId, 2, productId)).success).toBe(false);
        expect((await setSupplyActive(replacement.id, true)).success).toBe(true);
        expect((await updateSaleQuantity(sale.data.saleId, 2, productId)).success).toBe(true);
    });

    it("rejects a sale when a newly attached inactive recipe ingredient has zero quantity", async () => {
        const zero = await prisma.supplies.create({ data: { name: "Ingrediente cero", measureUnit: "kg", currentStockMilliunits: 1000, unitCostCents: 100 } });
        await prisma.recipes.create({ data: { productID: productId, supplyID: zero.id, quantityUsedMilliunits: 0 } });
        expect((await setSupplyActive(zero.id, false)).success).toBe(true);
        expect((await getProductsData()).map(p => p.id)).not.toContain(productId);
        expect((await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_4", -1)).success).toBe(false);
    });

    it("reduces historical duplicate lines without consuming inactive stock or discarding price and consumption snapshots", async () => {
        const sale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_5", -1);
        expect(sale.success).toBe(true);
        if (!sale.success) return;
        const secondSupply = await prisma.supplies.create({ data: { name: "Lote alternativo", measureUnit: "kg", currentStockMilliunits: 40_000, unitCostCents: 100 } });
        await prisma.sale_items.create({ data: {
            saleID: sale.data.saleId, productID: productId, quantity: 10,
            unitPriceCents: 6000, subtotalCents: 60_000, consumptionRecorded: true,
            consumptions: { create: { supplyID: secondSupply.id, quantityUsedMilliunits: 1000 } },
        } });
        await prisma.sales.update({ where: { id: sale.data.saleId }, data: { totalCents: 65_000 } });
        expect((await setSupplyActive(supplyId, false)).success).toBe(true);
        expect((await updateSaleQuantity(sale.data.saleId, 10, productId)).success).toBe(true);
        const rows = await prisma.sale_items.findMany({ where: { saleID: sale.data.saleId }, include: { consumptions: true } });
        expect(rows.reduce((sum, row) => sum + row.quantity, 0)).toBe(10);
        for (const row of rows) {
            expect(row.consumptions).toHaveLength(1);
            const supply = row.consumptions[0].supplyID;
            expect([supplyId, secondSupply.id]).toContain(supply);
            expect(Number(row.unitPriceCents)).toBe(supply === supplyId ? 5000 : 6000);
        }
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits)).toBeGreaterThanOrEqual(99_000);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: secondSupply.id } })).currentStockMilliunits)).toBeGreaterThanOrEqual(40_000);
        expect((await cancelSaleAction(sale.data.saleId)).success).toBe(true);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits)).toBe(100_000);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: secondSupply.id } })).currentStockMilliunits)).toBe(50_000);
    });

    it("increases historical duplicate lines using the oldest line's price and snapshot", async () => {
        const sale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_6", -1);
        expect(sale.success).toBe(true);
        if (!sale.success) return;
        const secondSupply = await prisma.supplies.create({ data: { name: "Segundo lote", measureUnit: "kg", currentStockMilliunits: 40_000, unitCostCents: 100 } });
        await prisma.sale_items.create({ data: {
            saleID: sale.data.saleId, productID: productId, quantity: 10,
            unitPriceCents: 6000, subtotalCents: 60_000, consumptionRecorded: true,
            consumptions: { create: { supplyID: secondSupply.id, quantityUsedMilliunits: 1000 } },
        } });
        await prisma.sales.update({ where: { id: sale.data.saleId }, data: { totalCents: 65_000 } });
        expect((await updateSaleQuantity(sale.data.saleId, 12, productId)).success).toBe(true);
        const rows = await prisma.sale_items.findMany({ where: { saleID: sale.data.saleId }, include: { consumptions: true }, orderBy: { id: "asc" } });
        expect(rows.map(row => [row.quantity, Number(row.unitPriceCents), row.consumptions[0].supplyID])).toEqual([[2, 5000, supplyId], [10, 6000, secondSupply.id]]);
        expect(Number((await prisma.sales.findUniqueOrThrow({ where: { id: sale.data.saleId } })).totalCents)).toBe(70_000);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits)).toBe(98_000);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: secondSupply.id } })).currentStockMilliunits)).toBe(40_000);
        expect((await cancelSaleAction(sale.data.saleId)).success).toBe(true);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits)).toBe(100_000);
        expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: secondSupply.id } })).currentStockMilliunits)).toBe(50_000);
    });

    it.each(["sale", "recipe"] as const)("rejects a %s after a concurrent supply deactivation commits", async (operation) => {
        const lock = new Client({ connectionString: process.env.DATABASE_URL });
        await lock.connect();
        let pending: Promise<{ success: boolean }> | undefined;
        try {
            await lock.query("BEGIN");
            const pid = (await lock.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await lock.query('SELECT id FROM supplies WHERE id = $1 FOR UPDATE', [supplyId]);
            pending = operation === "sale"
                ? createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_7", -1)
                : saveProduct({ name: "Receta concurrente", price: 5000, recipes: [{ supplyID: supplyId, quantityUsed: 1000 }] });
            const deadline = Date.now() + 5000;
            let blocked = false;
            while (Date.now() < deadline) {
                const rows = await prisma.$queryRaw<{ blocked: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS blocked`;
                if (rows[0].blocked) { blocked = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(blocked).toBe(true);
            await lock.query('UPDATE supplies SET active = false WHERE id = $1', [supplyId]);
            await lock.query("COMMIT");
            expect((await pending).success).toBe(false);
            expect(await prisma.sales.count()).toBe(0);
            expect(await prisma.products.findFirst({ where: { name: "Receta concurrente" } })).toBeNull();
            expect(Number((await prisma.supplies.findUniqueOrThrow({ where: { id: supplyId } })).currentStockMilliunits)).toBe(100_000);
        } finally {
            await lock.query("ROLLBACK").catch(() => {});
            await lock.end();
            if (pending) await pending.catch(() => {});
        }
    });

    it("settles an existing account after its product is disabled", async () => {
        const sale = await createSale([{ productID: productId, quantity: 1 }], "UNPAID", "MESA_2", -1);
        expect(sale.success).toBe(true);
        if (!sale.success) return;
        expect((await setProductActive(productId, false)).success).toBe(true);
        expect((await updateSaleQuantity(sale.data.saleId, 2, productId)).success).toBe(false);
        expect((await closeAccountAction("MESA_2", "CASH", [sale.data.saleId], 5000)).success).toBe(true);
        expect(await prisma.sales.findUnique({ where: { id: sale.data.saleId } })).toMatchObject({ status: "PAID" });
    });
});
