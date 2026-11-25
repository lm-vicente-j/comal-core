import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

for (const width of [1280, 360]) {
    test(`catalog records can be deactivated and reactivated at ${width}px`, async ({ page }) => {
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const suffix = `${Date.now().toString(36)}${width}`;
        const supplyName = `Insumo ${suffix}`;
        const productName = `Producto ${suffix}`;
        let supplyId: number | undefined;
        let productId: number | undefined;
        try {
            supplyId = (await pool.query('INSERT INTO supplies (name, "measureUnit", "currentStockMilliunits", "unitCostCents") VALUES ($1, $2, 5000, 100) RETURNING id', [supplyName, "kg"])).rows[0].id;
            productId = (await pool.query('INSERT INTO products (name, "priceCents") VALUES ($1, 1000) RETURNING id', [productName])).rows[0].id;
            await pool.query('INSERT INTO recipes ("productID", "supplyID", "quantityUsedMilliunits") VALUES ($1, $2, 1000)', [productId, supplyId]);
            await page.setViewportSize({ width, height: 800 });
            const rootSelector = width < 768 ? "div.flex.md\\:hidden" : "div.hidden.md\\:flex";
            for (const [path, name, isSupply] of [["inventory", supplyName, true], ["menu", productName, false]] as const) {
                await page.goto(`/admin/${path}`);
                const root = page.locator(rootSelector).filter({ visible: true });
                const search = root.getByRole("textbox", { name: isSupply ? "Buscar insumo" : "Buscar producto" });
                await search.fill(name);
                await expect(root.getByText(name)).toBeVisible();
                if (width >= 768) await root.getByText(name).click();
                await root.getByRole("button", { name: `Desactivar ${name}`, exact: true }).click();
                const dialog = page.getByRole("alertdialog");
                await expect(dialog).toContainText(isSupply ? "productos que lo contienen" : "ventas");
                await dialog.getByRole("button", { name: "Desactivar", exact: true }).click();
                await expect(root.getByText(name)).toHaveCount(0);
                await expect(search).toBeFocused();
                await root.getByRole("combobox", { name: "Filtrar por estado" }).click();
                await page.getByRole("option", { name: "Inactivos", exact: true }).click();
                await expect(root.getByText(name)).toBeVisible();
                await expect(root.getByText("Inactivo", { exact: true })).toBeVisible();
                if (width >= 768) await root.getByText(name).click();
                if (isSupply) {
                    await expect(root.getByText("Reactiva este insumo para editarlo.")).toBeVisible();
                    if (width < 768) await expect(root.getByRole("button", { name: `Editar ${name}` })).toBeDisabled();
                    else {
                        const form = root.locator("form:not([hidden])");
                        await expect(form.locator('input[name="name"]')).toBeDisabled();
                        await expect(form.getByRole("button", { name: "Actualizar" })).toBeDisabled();
                    }
                }
                await root.getByRole("button", { name: `Reactivar ${name}`, exact: true }).click();
                await dialog.getByRole("button", { name: "Reactivar", exact: true }).click();
                await expect(root.getByText(name)).toHaveCount(0);
                await expect(search).toBeFocused();
                await root.getByRole("combobox", { name: "Filtrar por estado" }).click();
                await page.getByRole("option", { name: "Activos", exact: true }).click();
                await expect(root.getByText(name)).toBeVisible();
            }
            expect((await pool.query('SELECT count(*)::int AS count FROM recipes WHERE "productID" = $1 AND "supplyID" = $2', [productId, supplyId])).rows[0].count).toBe(1);
        } finally {
            if (productId && supplyId) await pool.query('DELETE FROM recipes WHERE "productID" = $1 AND "supplyID" = $2', [productId, supplyId]);
            if (productId) await pool.query('DELETE FROM products WHERE id = $1', [productId]);
            if (supplyId) await pool.query('DELETE FROM supplies WHERE id = $1', [supplyId]);
            await pool.end();
        }
    });
}
