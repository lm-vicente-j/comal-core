import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

async function withSupplies(run: (prefix: string) => Promise<void>) {
    const pool = new Pool({ connectionString: E2E_DATABASE_URL });
    const ids: number[] = [];
    const prefix = `Resize focus ${process.pid}`;
    try {
        const fixtures = await pool.query<{ id: number }>(
            'INSERT INTO supplies (name, "measureUnit", "currentStockMilliunits", "unitCostCents") SELECT $1 || \' \' || i, \'kg\', 1000, 100 FROM generate_series(1, 12) AS i RETURNING id',
            [prefix],
        );
        ids.push(...fixtures.rows.map(row => row.id));
        await run(prefix);
    } finally {
        await pool.query("DELETE FROM supplies WHERE id = ANY($1::int[])", [ids]);
        await pool.end();
    }
}

// Regression coverage for the focus failures found in adversarial round 2.
for (const scenario of [
    { from: 360, to: 800, open: true, escape: false, name: "replacing the mobile list with the tablet list keeps focus in the list" },
    { from: 800, to: 1280, open: true, escape: true, name: "closing the mobile selector on desktop returns focus to the list instead of the sidebar" },
    { from: 800, to: 1280, open: false, escape: false, name: "hiding a focused mobile pagination button on desktop keeps focus in the list" },
]) {
    test(scenario.name, async ({ page }) => {
        await page.setViewportSize({ width: scenario.from, height: 800 });
        await withSupplies(async prefix => {
            await page.goto("/admin/inventory");
            await page.getByRole("textbox", { name: "Buscar insumo" }).fill(prefix);
            await expect(page.getByRole("navigation", { name: "Paginación de insumos" })).toContainText("Página 1 de 2");
            const trigger = page.getByRole("button", { name: /Seleccionar página/ });
            await trigger.focus();
            if (scenario.open) await trigger.press("Enter");
            const dialog = page.getByRole("dialog", { name: "Ir a página" });
            if (scenario.open) await expect(dialog).toBeVisible();
            await page.setViewportSize({ width: scenario.to, height: 800 });
            if (scenario.escape) await page.keyboard.press("Escape");
            await expect(dialog).toHaveCount(0);

            await expect.poll(
                () => page.locator("main > div.overflow-y-auto").evaluate(list => {
                    const active = document.activeElement;
                    return active instanceof HTMLElement
                        && list.contains(active)
                        && active.getClientRects().length > 0;
                }),
                { message: "Responsive changes must keep keyboard focus on a visible element in the list", timeout: 3000 },
            ).toBe(true);
        });
    });
}

test("collapsing supply pagination restores focus to the recipe supply picker", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await withSupplies(async prefix => {
        await page.goto("/admin/menu");
        await page.getByRole("button", { name: "Agregar producto", exact: true }).click();
        const editor = page.getByRole("dialog", { name: "Agregar producto al menú" });
        const search = editor.getByPlaceholder("Escriba un insumo...");
        await search.fill(prefix);
        const nav = editor.getByRole("navigation", { name: "Paginación de insumos" });
        await expect(nav).toContainText("Página 1 de 2");
        await nav.getByRole("button", { name: /Seleccionar página/ }).click();
        const selector = page.getByRole("dialog", { name: "Ir a página" });
        await selector.getByRole("combobox", { name: "Registros por página" }).click();
        await page.getByRole("option", { name: "50", exact: true }).click();
        await expect(selector).toHaveCount(0);
        await expect(nav).toHaveCount(0);
        await expect(editor).toBeVisible();
        await expect(search).toBeFocused({ timeout: 3000 });
    });
});
