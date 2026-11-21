import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";


test.describe("menu products", () => {
    test("creates a product and shows it in the menu table", async ({ page }) => {
        await page.goto("/admin/menu");

        await page.getByPlaceholder("Nombre del producto...").fill("Producto E2E");
        await page.getByPlaceholder("0.00").fill("45");
        await page.getByRole("button", { name: "AGREGAR" }).click();

        // saveProduct revalidates other routes, so reload to see the fresh list.
        await page.waitForTimeout(1000);
        await page.reload();
        // Desktop and mobile managers coexist in the DOM; use the visible one.
        await page.getByPlaceholder("Buscar producto...").filter({ visible: true }).fill("Producto E2E");
        await expect(page.getByRole("cell", { name: "Producto E2E" }).first()).toBeVisible();
    });

    test("selecting an existing product in desktop menu displays 'Editar Producto' panel and 'Editar insumos' button", async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 720 });
        await page.goto("/admin/menu");

        const desktopMenu = page.locator("div.hidden.md\\:flex");
        const firstRowCheckbox = desktopMenu.getByRole("checkbox", { name: "Select row" }).first();
        await firstRowCheckbox.click();

        await expect(desktopMenu.getByRole("heading", { name: "Editar Producto" })).toBeVisible();
        await expect(desktopMenu.getByRole("heading", { name: "Editar Insumo", exact: true })).toHaveCount(0);

        const editIngredientsButton = desktopMenu.getByRole("button", { name: "Editar insumos" });
        await expect(editIngredientsButton).toBeVisible();
        await editIngredientsButton.click();

        const recipeDialog = page.getByRole("dialog");
        await expect(recipeDialog.getByRole("heading", { name: "Editar lista de insumos" })).toBeVisible();
        await recipeDialog.getByRole("button", { name: "Cerrar", exact: true }).click();
        await expect(recipeDialog).toHaveCount(0);

    });

    test("desktop menu exposes pagination controls for products table", async ({ page }) => {
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 12 }, (_, index) => `ZZ página ${index + 1}`);
        try {
            await pool.query("INSERT INTO products (name, price) SELECT name, 25 FROM unnest($1::text[]) AS name", [names]);
            await page.setViewportSize({ width: 1280, height: 720 });
            await page.goto("/admin/menu");

            const desktopMenu = page.locator("div.hidden.md\\:flex");
            await expect(desktopMenu.getByRole("button", { name: "Anterior" })).toBeDisabled();
            await desktopMenu.locator("tbody").getByRole("checkbox").first().click();
            await expect(desktopMenu.getByRole("heading", { name: "Editar Producto" })).toBeVisible();
            await desktopMenu.getByRole("button", { name: "Siguiente" }).click();
            await expect(desktopMenu.getByText(/Página 2 de/)).toBeVisible();
            await expect(desktopMenu.getByRole("heading", { name: "Editar Producto" })).toBeVisible();
            await desktopMenu.getByRole("button", { name: "+ Nuevo", exact: true }).click();
            await expect(desktopMenu.getByRole("heading", { name: "Agregar producto al menú" })).toBeVisible();
            await desktopMenu.getByRole("button", { name: "Anterior" }).click();
            await expect(desktopMenu.getByText(/Página 1 de/)).toBeVisible();
            await expect(desktopMenu.locator("tbody").getByRole("checkbox").first()).not.toBeChecked();

            await desktopMenu.getByRole("button", { name: "Siguiente" }).click();
            await expect(desktopMenu.getByText(/Página 2 de/)).toBeVisible();
            const productRow = desktopMenu.locator("tbody").getByRole("row").filter({ hasText: /ZZ página/ }).first();
            await productRow.getByRole("checkbox").click();
            const salePrice = desktopMenu.locator('form:not([hidden]) input[name="price"]');
            await salePrice.fill("31");
            let failedPageLoads = 0;
            await page.route("**/admin/menu", async (route) => {
                const request = route.request();
                if (request.method() === "POST" && /"page":\s*2\b/.test(request.postData() ?? "") && failedPageLoads < 2) {
                    failedPageLoads++;
                    await route.fulfill({ status: 503, body: "Service unavailable" });
                    return;
                }
                await route.continue();
            });
            await desktopMenu.getByRole("button", { name: "Actualizar" }).click();
            await expect(desktopMenu.getByRole("heading", { name: "Agregar producto al menú" })).toBeVisible();
            await expect(desktopMenu.getByText("Producto actualizado exitosamente.")).toBeVisible();
            await productRow.getByRole("checkbox").click();
            await expect(salePrice).toHaveValue("31");
            expect(failedPageLoads).toBe(2);
        } finally {
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });
});


for (const viewport of [{ width: 1280, height: 720 }, { width: 360, height: 640 }]) {
    test("creates a gram supply and uses grams in a menu recipe at " + viewport.width + "x" + viewport.height, async ({ page }) => {
        test.setTimeout(180_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const suffix = Date.now().toString(36);
        const supplyName = "Gramos E2E " + suffix;
        const productName = "Receta gramos E2E " + suffix;
        const mobile = viewport.width < 768;
        const rootSelector = mobile ? "div.flex.md\\:hidden" : "div.hidden.md\\:flex";
        try {
            await page.setViewportSize(viewport);
            await page.goto("/admin/inventory");
            const inventory = page.locator(rootSelector).filter({ visible: true });
            const supplyForm = mobile ? page.getByRole("dialog") : inventory.locator("form:not([hidden])");
            if (mobile) await inventory.getByRole("button", { name: "Nuevo", exact: true }).click();
            await supplyForm.locator('input[name="name"]').fill(supplyName);
            await supplyForm.locator('input[name="currentStock"]').fill("200");
            await supplyForm.locator('input[name="unitCost"]').fill("1");
            if (mobile) {
                await supplyForm.locator('select[name="measureUnit"]').selectOption("g");
                await supplyForm.getByRole("button", { name: "Guardar Insumo", exact: true }).click();
                await expect(supplyForm.getByText("Guardado exitosamente.", { exact: true })).toBeVisible();
                await expect(supplyForm).toBeHidden();
            } else {
                await supplyForm.locator('button:has-text("...")').click();
                await page.getByRole("option", { name: "GRAMOS", exact: true }).click();
                await supplyForm.getByRole("button", { name: "AGREGAR", exact: true }).click();
                await expect(inventory.getByText("Insumo guardado exitosamente.", { exact: true })).toBeVisible();
            }
            const savedSupply = (await pool.query<{ measureUnit: string; currentStock: string }>(
                'SELECT "measureUnit", "currentStock"::text FROM supplies WHERE name = $1', [supplyName]
            )).rows[0];
            expect(savedSupply.measureUnit).toBe("g");
            expect(Number(savedSupply.currentStock)).toBe(200);

            await page.goto("/admin/menu");
            const menu = page.locator(rootSelector).filter({ visible: true });
            if (mobile) await menu.getByRole("button", { name: "Agregar producto", exact: true }).click();
            const productForm = mobile ? page.getByRole("dialog") : menu.locator("form:not([hidden])");
            await productForm.locator('input[name="name"]').fill(productName);
            await productForm.locator('input[name="price"]').fill("100");
            if (!mobile) await productForm.getByRole("button", { name: "Editar lista insumos", exact: true }).click();
            const recipeDialog = page.getByRole("dialog");
            await recipeDialog.getByPlaceholder("Escriba un insumo...").fill(supplyName);
            await recipeDialog.getByRole("option", { name: supplyName, exact: true }).click();
            await recipeDialog.getByRole("button", { name: "Submit", exact: true }).click();
            const recipeRow = recipeDialog.getByRole("row").filter({ hasText: supplyName });
            await expect(recipeRow.getByRole("cell", { name: "g", exact: true })).toBeVisible();
            await recipeRow.locator('input[type="number"]').fill("25");
            const capture = test.info().outputPath("menu-grams-recipe.png");
            await page.screenshot({ path: capture });
            await test.info().attach("menu-grams-recipe", { path: capture, contentType: "image/png" });
            if (!mobile) await recipeDialog.getByRole("button", { name: "Cerrar", exact: true }).click();
            await expect(productForm.getByText("$25.00", { exact: true })).toBeVisible();
            await productForm.getByRole("button", { name: mobile ? "Agregar" : "AGREGAR", exact: true }).click();
            await expect((mobile ? productForm : menu).getByText(
                mobile ? "Guardado exitosamente." : "Producto agregado exitosamente.", { exact: true }
            )).toBeVisible();
            const savedRecipe = (await pool.query<{ quantity: string; unit: string }>(
                'SELECT r."quantityUsed"::text AS quantity, s."measureUnit" AS unit FROM products p JOIN recipes r ON r."productID" = p.id JOIN supplies s ON s.id = r."supplyID" WHERE p.name = $1 AND s.name = $2',
                [productName, supplyName]
            )).rows[0];
            expect(savedRecipe.unit).toBe("g");
            expect(Number(savedRecipe.quantity)).toBe(25);
        } finally {
            await pool.query('DELETE FROM recipes WHERE "productID" IN (SELECT id FROM products WHERE name = $1)', [productName]);
            await pool.query("DELETE FROM products WHERE name = $1", [productName]);
            await pool.query("DELETE FROM supplies WHERE name = $1", [supplyName]);
            await pool.end();
        }
    });
}
