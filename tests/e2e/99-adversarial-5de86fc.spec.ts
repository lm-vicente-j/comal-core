import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

// Regression found during the adversarial review of commit 5de86fc.
test("changing page size to a single page preserves keyboard focus in the list", async ({ page }) => {
    const pool = new Pool({ connectionString: E2E_DATABASE_URL });
    const ids: number[] = [];
    const prefix = `Focus 5de86fc ${process.pid}`;

    try {
        const fixtures = await pool.query<{ id: number }>(
            'INSERT INTO supplies (name, "measureUnit", "currentStockMilliunits", "unitCostCents") SELECT $1 || \' \' || i, \'kg\', 1000, 100 FROM generate_series(1, 12) AS i RETURNING id',
            [prefix],
        );
        ids.push(...fixtures.rows.map(row => row.id));

        await page.setViewportSize({ width: 360, height: 640 });
        await page.goto("/admin/inventory");
        await page.getByRole("textbox", { name: "Buscar insumo" }).fill(prefix);
        const nav = page.getByRole("navigation", { name: "Paginación de insumos" });
        await expect(nav).toContainText("Página 1 de 2");
        await nav.getByRole("button", { name: /Seleccionar página/ }).click();
        const dialog = page.getByRole("dialog", { name: "Ir a página" });
        await dialog.getByRole("combobox", { name: "Registros por página" }).click();
        await page.getByRole("option", { name: "50", exact: true }).click();

        // Hiding pagination for one page is expected. Losing the user's focus is not.
        await expect(dialog).toHaveCount(0);
        await expect(nav).toHaveCount(0);
        await expect.poll(
            () => page.evaluate(() => {
                const active = document.activeElement;
                return active !== document.body
                    && !!document.querySelector("main > div.overflow-y-auto")?.contains(active)
                    && active instanceof HTMLElement
                    && active.getClientRects().length > 0;
            }),
            { message: "Focus must remain on a visible element in the list after the pagination dialog disappears", timeout: 3000 },
        ).toBe(true);
    } finally {
        await pool.query("DELETE FROM supplies WHERE id = ANY($1::int[])", [ids]);
        await pool.end();
    }
});
