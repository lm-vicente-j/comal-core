import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

async function withInventory(page: Page, width: number, run: (pool: Pool, ids: number[], prefix: string) => Promise<void>) {
    const pool = new Pool({ connectionString: E2E_DATABASE_URL });
    const ids: number[] = [];
    const prefix = `Pending focus ${process.pid}`;
    try {
        const fixtures = await pool.query<{ id: number }>(
            'INSERT INTO supplies (name, "measureUnit", "currentStockMilliunits", "unitCostCents") SELECT $1 || \' \' || i, \'kg\', 1000, 100 FROM generate_series(1, 30) AS i RETURNING id',
            [prefix],
        );
        ids.push(...fixtures.rows.map(row => row.id));
        await page.setViewportSize({ width, height: 800 });
        await page.goto("/admin/inventory");
        await page.getByRole("textbox", { name: "Buscar insumo" }).fill(prefix);
        if (width < 1024) await expect(page.getByRole("navigation", { name: "Paginación de insumos" })).toContainText("Página 1 de 3");
        else await expect(page.getByText(/Mostrando.*30 insumos/)).toBeVisible();
        await run(pool, ids, prefix);
    } finally {
        await page.unroute("**/admin/inventory");
        await pool.query("DELETE FROM supplies WHERE id = ANY($1::int[])", [ids]);
        await pool.end();
    }
}

async function expectListFocus(page: Page) {
    await expect.poll(() => page.locator("main > div.overflow-y-auto").evaluate(list => {
        const active = document.activeElement;
        return active instanceof HTMLElement && list.contains(active) && active.getClientRects().length > 0
            ? "list" : active?.tagName;
    }), { message: "Keyboard focus must return to the list after pagination completes", timeout: 3000 }).toBe("list");
}

// Round 3 findings: failing reproductions, kept separate from the corrected round 2 cases.
test("mobile next-page navigation restores focus after a slow response", async ({ page }) => {
    await withInventory(page, 360, async (_pool, _ids, prefix) => {
        await page.route("**/admin/inventory", async route => {
            if (route.request().method() === "POST" && route.request().postData()?.includes('"page":2')
                && route.request().postData()?.includes(prefix)) await new Promise(resolve => setTimeout(resolve, 600));
            await route.continue();
        });
        const nav = page.getByRole("navigation", { name: "Paginación de insumos" });
        const next = nav.getByRole("button", { name: "Página siguiente" });
        await next.focus();
        await next.press("Enter");
        await expect(nav).toContainText("Página 2 de 3");
        await expectListFocus(page);
    });
});

test("desktop page-size selection restores focus after a slow response", async ({ page }) => {
    await withInventory(page, 1280, async (_pool, _ids, prefix) => {
        await page.route("**/admin/inventory", async route => {
            if (route.request().method() === "POST" && route.request().postData()?.includes('"pageSize":20')
                && route.request().postData()?.includes(prefix)) await new Promise(resolve => setTimeout(resolve, 600));
            await route.continue();
        });
        const size = page.getByRole("combobox", { name: "Registros por página" });
        await size.click();
        await page.getByRole("option", { name: "20", exact: true }).click();
        await expect(size).toContainText("20");
        await expect(size).toBeEnabled();
        await expectListFocus(page);
    });
});

test("a clamped next-page request keeps focus in the list when pagination disappears", async ({ page }) => {
    await withInventory(page, 360, async (pool, ids, prefix) => {
        await page.route("**/admin/inventory", async route => {
            if (route.request().method() === "POST" && route.request().postData()?.includes('"page":2')
                && route.request().postData()?.includes(prefix)) {
                await pool.query("DELETE FROM supplies WHERE id = ANY($1::int[])", [ids.slice(2)]);
            }
            await route.continue();
        });
        const nav = page.getByRole("navigation", { name: "Paginación de insumos" });
        const next = nav.getByRole("button", { name: "Página siguiente" });
        await next.focus();
        await next.press("Enter");
        await expect(page.getByText(new RegExp(`^${prefix} \\d+$`))).toHaveCount(2);
        await expect(nav).toHaveCount(0);
        await expectListFocus(page);
    });
});

test("closing a desktop page-size selector after resizing restores focus inside the list", async ({ page }) => {
    await withInventory(page, 1280, async () => {
        await page.getByRole("combobox", { name: "Registros por página" }).click();
        await expect(page.getByRole("option", { name: "10", exact: true })).toBeVisible();
        await page.setViewportSize({ width: 800, height: 800 });
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);
        await expectListFocus(page);
    });
});
