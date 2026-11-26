import { expect, test } from "@playwright/test";
import { authorizeTestDevice } from "../helpers/e2e-access";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

test.describe("cash count adversarial interactions", () => {
    test("a dismissed saved receipt does not prevent starting a fresh count", async ({ page }) => {
        await page.goto("/admin/jornada");
        const trigger = page.getByRole("button", { name: "Recuento", exact: true });
        await trigger.click();
        const dialog = page.getByRole("alertdialog");
        await dialog.getByLabel("Cantidad $5.00 moneda").fill("1");
        await dialog.getByLabel("Nota (opcional)").fill("Receipt dismissal regression");
        await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
        await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        await trigger.click();
        await expect(dialog.getByLabel("Cantidad $5.00 moneda")).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Guardar conteo", exact: true })).toBeEnabled();
        await expect(dialog.getByText(/Conteo guardado/)).toHaveCount(0);
    });

    test("a rejected savings action releases controls and reports the connection failure", async ({ page }) => {
        await page.goto("/admin/jornada");
        await page.getByRole("button", { name: "Registrar depósito", exact: true }).click();
        const dialog = page.getByRole("alertdialog");
        await dialog.getByLabel("Monto en pesos").fill("1");
        await page.route("**/admin/jornada*", async route => {
            if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
                await route.abort("connectionfailed");
            } else {
                await route.continue();
            }
        });
        await dialog.getByRole("button", { name: "Guardar depósito", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Guardar depósito", exact: true })).toBeEnabled();
        await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeEnabled();
        await expect(dialog.getByRole("alert")).toContainText(/conexión|conectar/i);
    });

    test("STAFF with counting permission can reach Jornada from desktop and mobile", async ({ browser }) => {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 720 } });
        try {
            await authorizeTestDevice(context, "FIXED");
            const page = await context.newPage();
            await page.goto("/login");
            await page.getByRole("tab", { name: "Dispositivo fijo", exact: true }).click();
            await page.locator('input[name="pin"]').fill("123456");
            await page.getByRole("button", { name: "Ingresar", exact: true }).click();
            await expect(page).toHaveURL(/\/pos/, { timeout: 30_000 });
            const desktopEntry = page.locator('a[href="/admin/jornada"]:visible').first();
            await expect(desktopEntry).toBeVisible();
            await desktopEntry.click();
            await expect(page.getByRole("button", { name: "Recuento", exact: true })).toBeVisible();
            await expect(page.getByText("Esperado caja", { exact: true })).toHaveCount(0);

            await page.setViewportSize({ width: 360, height: 640 });
            await page.goto("/pos");
            await page.getByRole("button", { name: "Menú de usuario", exact: true }).click();
            const mobileEntry = page.getByRole("menu").locator('a[href="/admin/jornada"]');
            await expect(mobileEntry).toBeVisible();
            await mobileEntry.click();
            await expect(page.getByRole("button", { name: "Recuento", exact: true })).toBeVisible();
        } finally {
            await context.close();
        }
    });
    test("hides privileged receipt fields after cash-view permission is revoked", async ({ browser }) => {
        const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const previous = await pool.query<{ enabled: boolean }>(
            'SELECT enabled FROM "rolePermission" WHERE role = $1 AND capability = $2',
            ["SUPERVISOR", "jornada.viewCash"],
        );
        try {
            await authorizeTestDevice(context, "FIXED");
            const page = await context.newPage();
            await page.goto("/login");
            await page.getByRole("tab", { name: "Dispositivo fijo", exact: true }).click();
            await page.locator('input[name="pin"]').fill("654321");
            await page.getByRole("button", { name: "Ingresar", exact: true }).click();
            await expect(page).toHaveURL(/\/pos/, { timeout: 30_000 });
            await page.goto("/admin/jornada");
            await page.getByRole("button", { name: "Recuento", exact: true }).click();
            const dialog = page.getByRole("alertdialog");
            await dialog.getByLabel("Cantidad $5.00 moneda").fill("1");
            await dialog.getByLabel("Nota (opcional)").fill("Permission refresh regression");
            await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
            await expect(dialog.getByText("Esperado:")).toBeVisible();
            await pool.query(
                'INSERT INTO "rolePermission" (role, capability, enabled) VALUES ($1, $2, false) ON CONFLICT (role, capability) DO UPDATE SET enabled = false',
                ["SUPERVISOR", "jornada.viewCash"],
            );
            const refreshed = page.waitForResponse(response => response.url().includes("_rsc="));
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await refreshed;
            await expect(dialog.getByText("Esperado:")).toHaveCount(0);
            await expect(dialog.getByText(/Diferencia:/)).toHaveCount(0);
            await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
            await expect(dialog.getByRole("button", { name: "Listo", exact: true })).toBeVisible();
        } finally {
            if (previous.rows.length) {
                await pool.query('UPDATE "rolePermission" SET enabled = $3 WHERE role = $1 AND capability = $2',
                    ["SUPERVISOR", "jornada.viewCash", previous.rows[0].enabled]);
            } else {
                await pool.query('DELETE FROM "rolePermission" WHERE role = $1 AND capability = $2',
                    ["SUPERVISOR", "jornada.viewCash"]);
            }
            await context.close();
            await pool.end();
        }
    });

    test("explains that a captured shift was closed elsewhere", async ({ page }) => {
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const active = (await pool.query<{ id: number }>(
            "SELECT id FROM jornada WHERE status = 'OPEN' LIMIT 1",
        )).rows[0];
        try {
            await page.goto("/admin/jornada");
            await page.getByRole("button", { name: "Recuento", exact: true }).click();
            const dialog = page.getByRole("alertdialog");
            await dialog.getByLabel("Cantidad $5.00 moneda").fill("1");
            await dialog.getByLabel("Nota (opcional)").fill("Stale shift regression");
            const before = (await pool.query<{ count: string }>(
                'SELECT COUNT(*) AS count FROM cash_count WHERE "jornadaId" = $1', [active.id],
            )).rows[0].count;
            // Fixture changes only the eligibility flag to simulate an external closure.
            await pool.query("UPDATE jornada SET status = 'CLOSED' WHERE id = $1", [active.id]);
            const refreshed = page.waitForResponse(response => response.url().includes("_rsc="));
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await refreshed;
            await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
            await expect(dialog.getByRole("alert")).toContainText("La jornada ya está cerrada");
            expect((await pool.query<{ count: string }>(
                'SELECT COUNT(*) AS count FROM cash_count WHERE "jornadaId" = $1', [active.id],
            )).rows[0].count).toBe(before);
        } finally {
            await pool.query("UPDATE jornada SET status = 'OPEN' WHERE id = $1", [active.id]);
            await pool.end();
        }
    });

});
