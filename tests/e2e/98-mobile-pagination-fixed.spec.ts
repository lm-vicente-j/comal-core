import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

const prefix = "Pinned pagination";
const pool = new Pool({ connectionString: E2E_DATABASE_URL });
const customerIds: number[] = [];
const userIds: number[] = [];
const saleIds: number[] = [];

test.beforeAll(async () => {
    const admin = (await pool.query("SELECT id FROM users WHERE email = 'admin@e2e.local'")).rows[0];
    const jornada = (await pool.query("SELECT id FROM jornada WHERE status = 'OPEN' LIMIT 1")).rows[0];
    for (let i = 0; i < 12; i++) {
        const name = `${prefix} ${String(i).padStart(2, "0")}`;
        await pool.query('INSERT INTO products (name, "priceCents") VALUES ($1, 1000)', [name]);
        await pool.query('INSERT INTO supplies (name, "measureUnit", "currentStockMilliunits", "unitCostCents") VALUES ($1, $2, 10000, 100)', [name, "kg"]);
        const customer = (await pool.query('INSERT INTO customer ("customerName", "currentBalanceCents") VALUES ($1, 1000) RETURNING id', [name])).rows[0];
        customerIds.push(customer.id);
        const user = (await pool.query("INSERT INTO users (name, username, role, active) VALUES ($1, $2, 'STAFF', true) RETURNING id", [name, `PINNED${i}`])).rows[0];
        userIds.push(user.id);
        for (const status of ["DEBT", "PAID"]) {
            const sale = (await pool.query('INSERT INTO sales ("totalCents", source_type, "customerID", "placedBy", status, "jornadaId", payment_method) VALUES (1000, $1, $2, $3, $4, $5, $6) RETURNING id', [`CL- ${customer.id}`, customer.id, admin.id, status, jornada.id, "CASH"])).rows[0];
            saleIds.push(sale.id);
            if (status === "DEBT") await pool.query('INSERT INTO debtors ("saleID", "customerID", "amountCents", status, "createdJornadaId") VALUES ($1, $2, 1000, $3, $4)', [sale.id, customer.id, status, jornada.id]);
        }
        await pool.query('INSERT INTO salary ("userID", "amountCents", "payDate", period, "jornadaId", payment_method) VALUES ($1, 1000, CURRENT_DATE, $2, $3, $4)', [userIds[0], name, jornada.id, "CASH"]);
        await pool.query('INSERT INTO savings_movement ("amountCents", type, description, registered_by, "jornadaId") VALUES (100, $1, $2, $3, $4)', ["DEPOSIT", name, admin.id, jornada.id]);
        await pool.query('INSERT INTO savings_goal (name, "targetAmountCents") VALUES ($1, 10000)', [name]);
    }
});

test.afterAll(async () => {
    await pool.query('DELETE FROM debtors WHERE "saleID" = ANY($1::int[])', [saleIds]);
    await pool.query('DELETE FROM sales WHERE id = ANY($1::int[])', [saleIds]);
    await pool.query('DELETE FROM customer WHERE id = ANY($1::int[])', [customerIds]);
    await pool.query('DELETE FROM salary WHERE "userID" = ANY($1::int[])', [userIds]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
    for (const table of ["products", "supplies", "savings_goal"]) {
        await pool.query(`DELETE FROM ${table} WHERE name LIKE $1`, [`${prefix}%`]);
    }
    await pool.query("DELETE FROM savings_movement WHERE description LIKE $1", [`${prefix}%`]);
    await pool.end();
});

const modules = [
    { route: "/admin/inventory", label: "insumos" },
    { route: "/admin/menu", label: "productos" },
    { route: "/admin/crm", label: "clientes" },
    { route: "/admin/crm", label: "empleados", tab: "Empleados" },
    { route: "/expenses", label: "gastos" },
    { route: "/debtors", label: "deudores" },
    { route: "/admin/roster", label: "pagos" },
    { route: "/admin/savings", label: "movimientos" },
    { route: "/admin/savings", label: "metas", tab: "Metas" },
    { route: "/admin/reports", label: "registros" },
    { route: "/admin/statistics", label: "registros" },
];

for (const viewport of [{ width: 320, height: 480 }, { width: 800, height: 600 }]) {
    for (const entry of modules) {
        test(`${entry.route} ${entry.label}: fixed mobile pagination at ${viewport.width}px`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await page.goto(entry.route);
            if (entry.tab) await page.getByRole("tab", { name: entry.tab, exact: true }).click();
            if (entry.route === "/admin/roster") {
                await page.getByRole("combobox").first().click();
                const picker = page.locator('[data-slot="popover-content"]');
                await picker.getByPlaceholder("Buscar por nombre o usuario...").fill(`${prefix} 00`);
                await picker.getByRole("option", { name: /Pinned pagination 00/ }).click();
            }

            const nav = page.getByRole("navigation", { name: `Paginación de ${entry.label}`, exact: true });
            await expect(nav).toBeVisible();
            const dock = page.locator('[data-pagination-placement="page"]').filter({ visible: true });
            await expect(dock).toHaveCount(1);
            const before = (await nav.boundingBox())!;
            expect(before.y).toBeGreaterThanOrEqual(0);
            expect(before.y + before.height).toBeLessThanOrEqual(viewport.height - 64);

            await page.locator("main").evaluate(async main => {
                for (const el of [main, ...main.querySelectorAll<HTMLElement>("*")]) {
                    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
                }
                await new Promise(requestAnimationFrame);
            });
            const after = (await nav.boundingBox())!;
            expect(after.y).toBeCloseTo(before.y, 0);
            await expect(nav.getByRole("button", { name: "Página siguiente" })).toBeInViewport({ ratio: 1 });
            await nav.getByRole("button", { name: "Página siguiente" }).click();
            await expect(nav).toContainText("Página 2 de");
            await nav.getByRole("button", { name: /Seleccionar página/ }).click();
            await page.getByRole("dialog", { name: "Ir a página" }).getByRole("button", { name: "1", exact: true }).click();
            await expect(nav).toContainText("Página 1 de");
        });
    }
}

test("mobile pagination disappears for empty and single-page lists and returns when filters are cleared", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/admin/inventory");
    const search = page.getByRole("textbox", { name: "Buscar insumo" });
    const nav = page.getByRole("navigation", { name: "Paginación de insumos" });
    const dock = page.locator('[data-pagination-placement="page"]');

    await expect(nav).toBeVisible();
    await search.fill(`${prefix} 00`);
    await expect(page.getByText(`${prefix} 00`, { exact: true })).toBeVisible();
    await expect(dock).toHaveCount(0);
    await search.fill("No matching pagination supply");
    await expect(page.getByText("No hay insumos que coincidan.")).toBeVisible();
    await expect(dock).toHaveCount(0);

    await search.clear();
    await expect(nav).toBeVisible();
    await nav.getByRole("button", { name: /Seleccionar página/ }).click();
    await page.getByRole("combobox", { name: "Registros por página" }).click();
    await page.getByRole("option", { name: "50", exact: true }).click();
    await expect(dock).toHaveCount(0);

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByText(/Mostrando.*insumos/)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "pagination", exact: true })).toBeVisible();
});

test("embedded supply pagination stays inside the mobile recipe editor", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto("/admin/menu");
    await page.getByRole("button", { name: "Agregar producto", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Agregar producto al menú" });
    await dialog.getByPlaceholder("Escriba un insumo...").fill(prefix);
    const picker = dialog.locator('[data-pagination-placement="inline"]');
    await expect(picker).toBeVisible();
    expect(await picker.evaluate(el => getComputedStyle(el).position)).toBe("static");
    await picker.getByRole("button", { name: "Página siguiente" }).click();
    await expect(picker).toContainText("Página 2 de 2");
});
