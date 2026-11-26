import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";
import { authorizeTestDevice } from "./access-fixture";

test("history includes the new recount after dismissing its receipt", async ({ page }) => {
  const pool = new Pool({ connectionString: E2E_DATABASE_URL });
  try {
    await page.goto("/admin/jornada");
    await page.getByRole("button", { name: "Recuento", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Cantidad $0.50 moneda", { exact: true }).fill("1");
    await dialog.getByLabel("Nota (opcional)").fill("History regression original count");
    await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
    await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
    await dialog.getByRole("button", { name: "Listo", exact: true }).click();
    // Load the persisted fixture before exercising the refresh after Recontar.
    await page.reload();
    await page.getByRole("button", { name: "Historial", exact: true }).click();
    const recount = page.getByRole("button", { name: "Recontar", exact: true });
    await expect(recount.first()).toBeVisible();
    const before = await recount.count();
    expect(before).toBeGreaterThan(0);
    await recount.first().click();
    await dialog.getByLabel("Cantidad $0.50 moneda", { exact: true }).fill("2");
    await dialog.getByLabel("Nota (motivo requerido)").fill("History regression new recount");
    await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
    await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
    expect((await pool.query("SELECT id FROM cash_count WHERE note = $1 AND \"recountOfId\" IS NOT NULL", ["History regression new recount"])).rowCount).toBe(1);
    const refresh = page.waitForResponse(response => response.url().includes("_rsc="));
    await dialog.getByRole("button", { name: "Listo", exact: true }).click();
    await refresh;
    // Known defect: router.refresh updates props, but History keeps its old state.
    test.fail(true, "History must refresh its rows after a successful recount");
    await expect(recount).toHaveCount(before + 1);
  } finally {
    await pool.end();
  }
});

test("view-only supervisor cannot start a recount from history", async ({ browser, page }) => {
  const pool = new Pool({ connectionString: E2E_DATABASE_URL });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const previous = (await pool.query<{ enabled: boolean }>(
    'SELECT enabled FROM "rolePermission" WHERE role = $1 AND capability = $2', ["SUPERVISOR", "jornada.reconcile"],
  )).rows[0];
  try {
    await page.goto("/admin/jornada");
    await page.getByRole("button", { name: "Recuento", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Cantidad $0.50 moneda", { exact: true }).fill("1");
    await dialog.getByLabel("Nota (opcional)").fill("Permission regression fixture");
    await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
    await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
    await dialog.getByRole("button", { name: "Listo", exact: true }).click();
    await pool.query(
      'INSERT INTO "rolePermission" (role, capability, enabled) VALUES ($1, $2, false) ON CONFLICT (role, capability) DO UPDATE SET enabled = false',
      ["SUPERVISOR", "jornada.reconcile"],
    );
    await authorizeTestDevice(context, "FIXED");
    const supervisor = await context.newPage();
    await supervisor.goto("/login");
    await supervisor.getByRole("tab", { name: "Dispositivo fijo", exact: true }).click();
    await supervisor.locator('input[name="pin"]').fill("654321");
    await supervisor.getByRole("button", { name: "Ingresar", exact: true }).click();
    await expect(supervisor).toHaveURL(/\/pos/, { timeout: 30_000 });
    await supervisor.goto("/admin/jornada");
    await expect(supervisor.getByText("Esperado caja", { exact: true })).toBeVisible();
    await expect(supervisor.getByRole("button", { name: "Recuento", exact: true })).toHaveCount(0);
    await supervisor.getByRole("button", { name: "Historial", exact: true }).click();
    await expect(supervisor.getByRole("button", { name: /^Recuento Jornada/ }).first()).toBeVisible();
    test.fail(true, "History must respect jornada.reconcile when showing Recontar");
    await expect(supervisor.getByRole("button", { name: "Recontar", exact: true })).toHaveCount(0);
  } finally {
    if (previous) {
      await pool.query('UPDATE "rolePermission" SET enabled = $3 WHERE role = $1 AND capability = $2', ["SUPERVISOR", "jornada.reconcile", previous.enabled]);
    } else {
      await pool.query('DELETE FROM "rolePermission" WHERE role = $1 AND capability = $2', ["SUPERVISOR", "jornada.reconcile"]);
    }
    await context.close();
    await pool.end();
  }
});
