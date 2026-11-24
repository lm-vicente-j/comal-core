import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "./helpers";
import { deleteProduct, getProductsData, saveProduct } from "@/lib/actions/products";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DataTable from "@/app/(dashboard)/pos/date-table";
import { MenuManager } from "@/app/(dashboard)/admin/menu/menu-manager";

describe("products actions", () => {
    let supplyId: number;

    beforeAll(async () => {
        await resetDb();
        await seedBase();
        const supply = await prisma.supplies.create({
            data: { name: "Tortilla", measureUnit: "pz", currentStockMilliunits: 100000, unitCostCents: 100 },
        });
        supplyId = supply.id;
    });

    it("rejects saveProduct for non-admin sessions", async () => {
        logout();
        expect(await saveProduct({ name: "Taco", price: 2500 })).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        loginAs("STAFF");
        expect(await saveProduct({ name: "Taco", price: 2500 })).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        expect(await prisma.products.count()).toBe(0);
    });

    it("creates a product with its recipe", async () => {
        loginAs("ADMIN");
        const res = await saveProduct({ name: "Taco", price: 2500, recipes: [{ supplyID: supplyId, quantityUsed: 2000 }] });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.products.findFirstOrThrow({ where: { name: "Taco" }, include: { recipes: true } });
        expect(Number(row.priceCents)).toBe(2500);
        expect(row.recipes).toHaveLength(1);
        expect(row.recipes[0].supplyID).toBe(supplyId);
        expect(Number(row.recipes[0].quantityUsedMilliunits)).toBe(2000);
    });

    it("updates a product replacing its recipes", async () => {
        loginAs("ADMIN");
        const existing = await prisma.products.findFirstOrThrow({ where: { name: "Taco" } });

        const res = await saveProduct({ id: existing.id, name: "Taco Especial", price: 3000, recipes: [] });
        expect(res).toMatchObject({ success: true });

        const row = await prisma.products.findUniqueOrThrow({ where: { id: existing.id }, include: { recipes: true } });
        expect(row.name).toBe("Taco Especial");
        expect(Number(row.priceCents)).toBe(3000);
        expect(row.recipes).toHaveLength(0);
        expect(await prisma.products.count()).toBe(1);
    });

    it("rejects invalid data with field errors", async () => {
        loginAs("ADMIN");
        const res = await saveProduct({ name: "ab", price: -100 });
        expect(res.success).toBe(false);
        expect(res.fieldErrors).toBeDefined();
    });

    it("deletes a product without recipes", async () => {
        loginAs("ADMIN");
        const existing = await prisma.products.findFirstOrThrow({ where: { name: "Taco Especial" } });

        expect(await deleteProduct(existing.id)).toMatchObject({ success: true });
        expect(await prisma.products.findUnique({ where: { id: existing.id } })).toBeNull();
    });

    it("refuses to delete a product that still has recipes", async () => {
        loginAs("ADMIN");
        await saveProduct({ name: "Quesadilla", price: 3500, recipes: [{ supplyID: supplyId, quantityUsed: 1000 }] });
        const row = await prisma.products.findFirstOrThrow({ where: { name: "Quesadilla" } });

        const res = await deleteProduct(row.id);
        expect(res.success).toBe(false);
        expect(await prisma.products.findUnique({ where: { id: row.id } })).not.toBeNull();
    });

    it("getProductsData is empty without a session", async () => {
        logout();
        expect(await getProductsData()).toEqual([]);
    });

    it("rejects a sale price at or below the recipe base cost", async () => {
        loginAs("ADMIN");
        // Base cost is 5 * 1 = 5. Price = 1 (below base cost) should be rejected
        const resBelow = await saveProduct({ name: "Torta", price: 100, recipes: [{ supplyID: supplyId, quantityUsed: 5000 }] });
        expect(resBelow.success).toBe(false);
        expect(resBelow.fieldErrors?.price).toContain("El precio debe ser mayor al costo base");
        expect(await prisma.products.findFirst({ where: { name: "Torta" } })).toBeNull();

        // Price = 5 (equal to base cost) should also be rejected
        const resEqual = await saveProduct({ name: "Torta", price: 500, recipes: [{ supplyID: supplyId, quantityUsed: 5000 }] });
        expect(resEqual.success).toBe(false);
        expect(resEqual.fieldErrors?.price).toContain("El precio debe ser mayor al costo base");
        expect(await prisma.products.findFirst({ where: { name: "Torta" } })).toBeNull();

        // Price = 6 (above base cost) should succeed
        const resAbove = await saveProduct({ name: "Torta", price: 600, recipes: [{ supplyID: supplyId, quantityUsed: 5000 }] });
        expect(resAbove.success).toBe(true);
    });

    it("keeps the stored recipe when a product is updated without one", async () => {
        loginAs("ADMIN");
        const before = await prisma.products.findFirstOrThrow({ where: { name: "Quesadilla" }, include: { recipes: true } });
        expect(before.recipes.length).toBeGreaterThan(0);

        const res = await saveProduct({ id: before.id, name: "Quesadilla Grande", price: 4000 });
        expect(res).toMatchObject({ success: true });

        const after = await prisma.products.findUniqueOrThrow({ where: { id: before.id }, include: { recipes: true } });
        expect(after.name).toBe("Quesadilla Grande");
        expect(after.recipes).toHaveLength(before.recipes.length);
    });

    it("rounds the combined recipe cost half to even", async () => {
        loginAs("ADMIN");
        // At 10 milliunits each, the ingredients cost 0.75 and 1.75 cents.
        const supplyA = await prisma.supplies.create({
            data: { name: "Ingrediente A", measureUnit: "pz", currentStockMilliunits: 100000, unitCostCents: 75 },
        });
        const supplyB = await prisma.supplies.create({
            data: { name: "Ingrediente B", measureUnit: "pz", currentStockMilliunits: 100000, unitCostCents: 175 },
        });

        // The combined cost of 2.5 cents rounds to the even cent.
        const res = await saveProduct({
            name: "Producto Precision",
            price: 2,
            recipes: [
                { supplyID: supplyA.id, quantityUsed: 10 },
                { supplyID: supplyB.id, quantityUsed: 10 },
            ],
        });
        expect(res.success).toBe(false);
        expect(res.fieldErrors?.price).toContain("El precio debe ser mayor al costo base");

        expect(await saveProduct({
            name: "Producto con costo redondeado",
            price: 3,
            recipes: [
                { supplyID: supplyA.id, quantityUsed: 10 },
                { supplyID: supplyB.id, quantityUsed: 10 },
            ],
        })).toMatchObject({ success: true });
    });

    it("returns an empty list when all products are deleted and restores state", async () => {
        loginAs("ADMIN");
        try {
            await prisma.recipes.deleteMany({});
            await prisma.sale_items.deleteMany({});
            await prisma.products.deleteMany({});

            const products = await getProductsData();
            expect(products).toEqual([]);
        } finally {
            await resetDb();
            await seedBase();
            const supply = await prisma.supplies.create({
                data: { name: "Tortilla", measureUnit: "pz", currentStockMilliunits: 100000, unitCostCents: 100 },
            });
            supplyId = supply.id;
        }
    });

    it("handles long product names up to maximum schema length", async () => {
        loginAs("ADMIN");
        const longName = "Taco de arrachera con queso y guacamole!"; // 40 chars
        const res = await saveProduct({ name: longName, price: 9500 });
        expect(res.success).toBe(true);

        const products = await getProductsData();
        const found = products.find((p) => p.name === longName);
        expect(found).toBeDefined();
        expect(found?.name).toBe(longName);
        expect(found?.price).toBe(9500);

        if (found?.id) {
            await deleteProduct(found.id);
        }
    });

    it("renders long product names with multiline wrapping classes in POS DataTable", () => {
        const testProduct = {
            id: 999,
            name: "Taco de arrachera con queso y guacamole!",
            price: 9500,
        };

        const html = renderToStaticMarkup(
            React.createElement(DataTable, {
                data: [testProduct],
                onProductTap: () => {},
                pendingId: null,
            })
        );

        // Verify product name is in markup
        expect(html).toContain("Taco de arrachera con queso y guacamole!");
        // Verify desktop button has whitespace-normal and text-wrap to override Button's whitespace-nowrap
        expect(html).toContain("whitespace-normal");
        expect(html).toContain("text-wrap");
        expect(html).toContain("line-clamp-3");
        expect(html).toContain("break-words");
    });

    it("renders MenuManager with 'Editar Producto' and 'Editar insumos' button instead of 'Editar Insumo'", () => {
        const dummyProduct = {
            id: 1,
            name: "Taco Al Pastor",
            price: 2500,
            recipes: [],
        };
        const html = renderToStaticMarkup(
            React.createElement(MenuManager)
        );

        expect(html).toContain("Editar Producto");
        expect(html).not.toContain("Editar Insumo");
        expect(html).toContain("Editar insumos");
    });

    it("updates an existing product's recipe supplies and quantities", async () => {
        loginAs("ADMIN");
        const extraSupply = await prisma.supplies.create({
            data: { name: "Cebolla", measureUnit: "pz", currentStockMilliunits: 50000, unitCostCents: 200 },
        });

        const created = await saveProduct({
            name: "Taco Doble",
            price: 3000,
            recipes: [{ supplyID: supplyId, quantityUsed: 1000 }],
        });
        expect(created.success).toBe(true);

        const prod = await prisma.products.findFirstOrThrow({
            where: { name: "Taco Doble" },
            include: { recipes: true },
        });
        expect(prod.recipes).toHaveLength(1);
        expect(prod.recipes[0].supplyID).toBe(supplyId);

        const updated = await saveProduct({
            id: prod.id,
            name: "Taco Doble Con Todo",
            price: 3500,
            recipes: [
                { supplyID: supplyId, quantityUsed: 2000 },
                { supplyID: extraSupply.id, quantityUsed: 3000 },
            ],
        });
        expect(updated.success).toBe(true);

        const updatedProd = await prisma.products.findUniqueOrThrow({
            where: { id: prod.id },
            include: { recipes: true },
        });
        expect(updatedProd.name).toBe("Taco Doble Con Todo");
        expect(updatedProd.recipes).toHaveLength(2);
        const tortillaRecipe = updatedProd.recipes.find((r) => r.supplyID === supplyId);
        const cebollaRecipe = updatedProd.recipes.find((r) => r.supplyID === extraSupply.id);
        expect(Number(tortillaRecipe?.quantityUsedMilliunits)).toBe(2000);
        expect(Number(cebollaRecipe?.quantityUsedMilliunits)).toBe(3000);

        await prisma.recipes.deleteMany({ where: { productID: prod.id } });
        await prisma.products.delete({ where: { id: prod.id } });
        await prisma.supplies.delete({ where: { id: extraSupply.id } });
    });
});
