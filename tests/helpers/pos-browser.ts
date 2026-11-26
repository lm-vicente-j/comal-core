import { test as base, expect, type Page, type Browser, type BrowserContext, type Locator } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";
import { assertTestDatabase } from "./test-env";
import { authorizeTestDevice } from "./e2e-access";

export const viewports = [{ width: 320, height: 480 }, { width: 1280, height: 800 }];
export const ADMIN_STATE = "tests/e2e/.auth/admin.json";
export const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 1024;
export const actionRequest = (request: { method(): string; headers(): Record<string, string> }) => request.method() === "POST" && !!request.headers()["next-action"];

export type PosScenario = {
    pool: Pool; owner: number; jornada: number; customer: number; product: number; supply: number;
    name: string; productName: string;
    permission(role: "STAFF" | "SUPERVISOR", capability: string, enabled: boolean): Promise<void>;
};

export const test = base.extend<{ scenario: PosScenario }>({
    scenario: async ({}, provide, info) => {
        assertTestDatabase(E2E_DATABASE_URL);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const prior = (await pool.query<{ id: number }>("SELECT id FROM jornada WHERE status='OPEN'")).rows.map(row => row.id);
        const before = (await pool.query<{ id: number }>('SELECT COALESCE(MAX(id),0)::int AS id FROM jornada')).rows[0].id;
        const permissionRows = (await pool.query('SELECT * FROM "rolePermission"')).rows;
        const terminalIds = (await pool.query<{ id: string }>("SELECT id FROM terminal")).rows.map(row => row.id);
        let product: number | undefined;
        let supply: number | undefined;
        let customer: number | undefined;
        try {
            const owner = (await pool.query<{ id: number }>("SELECT id FROM users WHERE role='ADMIN'")).rows[0].id;
            await pool.query("UPDATE jornada SET status='CLOSED' WHERE status='OPEN'");
            const jornada = (await pool.query<{ id: number }>('INSERT INTO jornada ("openedBy", "openingAmountCents", status) VALUES ($1,50000,\'OPEN\') RETURNING id', [owner])).rows[0].id;
            const name = `Issue60 ${info.testId.slice(-12)}`;
            const productName = `Recipe60 ${info.testId.slice(-12)}`;
            customer = (await pool.query<{ id: number }>('INSERT INTO customer ("customerName", "currentBalanceCents", "registeredDate") VALUES ($1,0,CURRENT_DATE) RETURNING id', [name])).rows[0].id;
            supply = (await pool.query<{ id: number }>('INSERT INTO supplies (name,"measureUnit","currentStockMilliunits","unitCostCents") VALUES ($1,\'kg\',100000,50) RETURNING id', [name])).rows[0].id;
            product = (await pool.query<{ id: number }>('INSERT INTO products (name,"priceCents") VALUES ($1,2500) RETURNING id', [productName])).rows[0].id;
            await pool.query('INSERT INTO recipes ("productID","supplyID","quantityUsedMilliunits") VALUES ($1,$2,125)', [product, supply]);
            await provide({ pool, owner, jornada, customer, product, supply, name, productName,
                permission: async (role, capability, enabled) => {
                    await pool.query('INSERT INTO "rolePermission" (role,capability,enabled) VALUES ($1,$2,$3) ON CONFLICT (role,capability) DO UPDATE SET enabled=EXCLUDED.enabled', [role, capability, enabled]);
                },
            });
        } finally {
            // Counts remain immutable; close fixture shifts and remove only their domain rows.
            await pool.query("UPDATE jornada SET status='CLOSED' WHERE id>$1", [before]);
            await pool.query('DELETE FROM debtors WHERE "saleID" IN (SELECT id FROM sales WHERE "jornadaId">$1)', [before]);
            await pool.query('DELETE FROM sale_item_consumptions WHERE "saleItemID" IN (SELECT i.id FROM sale_items i JOIN sales s ON s.id=i."saleID" WHERE s."jornadaId">$1)', [before]);
            await pool.query('DELETE FROM sale_items WHERE "saleID" IN (SELECT id FROM sales WHERE "jornadaId">$1)', [before]);
            await pool.query('DELETE FROM sales WHERE "jornadaId">$1', [before]);
            await pool.query("DELETE FROM setting WHERE key LIKE 'TICKET_RES:%' AND split_part(key,':',2)::int > $1", [before]);
            if (product) { await pool.query('DELETE FROM recipes WHERE "productID"=$1', [product]); await pool.query('DELETE FROM products WHERE id=$1', [product]); }
            if (supply) await pool.query('DELETE FROM supplies WHERE id=$1', [supply]);
            if (customer) await pool.query('DELETE FROM customer WHERE id=$1', [customer]);
            await pool.query('DELETE FROM terminal WHERE NOT (id = ANY($1::uuid[]))', [terminalIds]);
            await pool.query('DELETE FROM "rolePermission"');
            for (const row of permissionRows) await pool.query('INSERT INTO "rolePermission" (role,capability,enabled) VALUES ($1,$2,$3)', [row.role,row.capability,row.enabled]);
            if (prior.length) await pool.query("UPDATE jornada SET status='OPEN' WHERE id=ANY($1::int[])", [prior]);
            await pool.end();
        }
    },
});

export async function terminal(browser: Browser, viewport: { width: number; height: number }, role: "ADMIN" | "SUPERVISOR" | "STAFF" = "ADMIN") {
    const context = await browser.newContext({ viewport, storageState: role === "ADMIN" ? ADMIN_STATE : { cookies: [], origins: [] } });
    const page = await context.newPage();
    page.on("dialog", dialog => void dialog.dismiss());
    if (role !== "ADMIN") {
        await authorizeTestDevice(context, "FIXED");
        await page.goto("/login");
        await page.getByRole("tab", { name: "Dispositivo fijo", exact: true }).click();
        await page.locator('input[name="pin"]').fill(role === "STAFF" ? "123456" : "654321");
        await page.getByRole("button", { name: "Ingresar", exact: true }).click();
        await expect(page).toHaveURL(/\/pos/, { timeout: 30_000 });
    }
    return { context, page };
}

export async function selectCustomer(page: Page, scenario: PosScenario) {
    await page.goto("/pos");
    if (isMobile(page)) await page.getByRole("button", { name: "Cliente", exact: true }).click();
    await page.getByRole("combobox").filter({ hasText: "Nombre de cliente" }).click();
    await page.getByPlaceholder("Buscar por nombre o alias...").fill(scenario.name);
    await page.getByRole("option", { name: new RegExp(scenario.name) }).click();
}

export async function addProduct(page: Page, scenario: PosScenario) {
    const button = page.getByRole("button", { name: new RegExp(scenario.productName) }).first();
    await button.click();
    await expect.poll(async () => (await scenario.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM sales WHERE "jornadaId"=$1 AND status=\'UNPAID\'', [scenario.jornada])).rows[0].count).toBeGreaterThan(0);
    await expect(button).toBeEnabled();
}

export async function account(page: Page) {
    if (isMobile(page)) {
        await page.getByRole("button", { name: "Abrir cuenta", exact: true }).click();
        return page.getByRole("dialog", { name: /^Cuenta/ });
    }
    return page.locator("main");
}

export async function startDebt(page: Page) {
    const root = await account(page);
    await root.getByRole("button", { name: /^A deuda/ }).click();
    return isMobile(page) ? root.getByRole("button", { name: "Sí, a deuda", exact: true })
        : page.getByRole("alertdialog").getByRole("button", { name: "Aceptar", exact: true });
}

export async function sendToDebt(page: Page, scenario: PosScenario) {
    await (await startDebt(page)).click();
    await expect.poll(async () => (await scenario.pool.query<{ balance: string }>('SELECT "currentBalanceCents" AS balance FROM customer WHERE id=$1', [scenario.customer])).rows[0].balance).toBe("2500");
}

export async function debtSummary(page: Page, scenario: PosScenario) {
    await page.goto("/debtors");
    await page.getByRole("row").filter({ has: page.getByText(scenario.name, { exact: true }) }).getByRole("button").click();
    await page.getByRole("button", { name: "Cobrar", exact: true }).click();
    const summary = page.getByRole("dialog", { name: `Cobrar cuenta de ${scenario.name}`, exact: true });
    await expect(summary).toBeVisible();
    return summary;
}

export async function cashCollection(page: Page, scenario: PosScenario) {
    const summary = await debtSummary(page, scenario);
    await summary.getByRole("button", { name: "Ingresar efectivo", exact: true }).click();
    const cash = page.getByRole("dialog", { name: "Cobrar en efectivo", exact: true });
    await cash.getByLabel("Efectivo recibido", { exact: true }).fill("25");
    return cash.getByRole("button", { name: "Confirmar y cerrar", exact: true });
}

export async function checkout(page: Page) {
    let summary: Locator;
    if (isMobile(page)) {
        summary = await account(page);
        await summary.getByRole("button", { name: /^Cobrar \$/ }).click();
        const cash = page.getByRole("dialog", { name: "Cobrar en efectivo", exact: true });
        await cash.getByLabel("Efectivo recibido", { exact: true }).fill("25");
        return cash.getByRole("button", { name: /^Cobrar \$/ });
    }
    await page.getByRole("button", { name: /Cerrar cuenta/ }).click();
    summary = page.getByRole("dialog", { name: /^Pago de cuenta/ });
    await summary.getByLabel("Efectivo recibido", { exact: true }).fill("25");
    return summary.getByRole("button", { name: "Confirmar y Cerrar", exact: true });
}

export async function closeShift(page: Page) {
    await page.goto("/admin/jornada");
    await page.getByRole("button", { name: "Cerrar jornada", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Cantidad $500.00 billete", { exact: true }).fill("1");
    await dialog.getByLabel("Nota (opcional)").fill("Issue60 fixture closure");
    await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
    await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
    await dialog.getByRole("button", { name: "Listo", exact: true }).click();
}

export async function openShift(page: Page) {
    await page.goto("/admin/jornada");
    await page.getByRole("button", { name: "Abrir jornada", exact: true }).last().click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Cantidad $500.00 billete", { exact: true }).fill("1");
    await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
    await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
    await dialog.getByRole("button", { name: "Listo", exact: true }).click();
}

export async function stock(scenario: PosScenario) {
    return (await scenario.pool.query<{ stock: string }>('SELECT "currentStockMilliunits" AS stock FROM supplies WHERE id=$1', [scenario.supply])).rows[0].stock;
}

export async function withTerminals(browser: Browser, viewport: { width: number; height: number }, run: (a: Page, b: Page) => Promise<void>) {
    const contexts: BrowserContext[] = [];
    try {
        const a = await terminal(browser, viewport); contexts.push(a.context);
        const b = await terminal(browser, viewport); contexts.push(b.context);
        await run(a.page, b.page);
    } finally { await Promise.all(contexts.map(context => context.close())); }
}

/** Pause an actual browser action before it reaches the server. */
export async function holdAction(page: Page, matches: (body: string) => boolean) {
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>(resolve => { arrive = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const response = page.waitForResponse(r => actionRequest(r.request()) && matches(r.request().postData() ?? ""), { timeout: 120_000 });
    void response.catch(() => {});
    await page.route("**/*", async route => {
        if (!actionRequest(route.request()) || !matches(route.request().postData() ?? "")) return route.continue();
        arrive();
        await resume;
        await route.continue();
    });
    return { arrived, release, response, dispose: async () => { release(); await page.unrouteAll({ behavior: "wait" }); } };
}
