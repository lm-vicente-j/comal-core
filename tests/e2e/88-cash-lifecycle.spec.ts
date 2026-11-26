import { expect, test, type Browser, type Locator } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";
import { authorizeTestDevice } from "./access-fixture";

type Role = "ADMIN" | "SUPERVISOR" | "STAFF";

async function operatorContext(browser: Browser, role: Role, width: number) {
  const context = await browser.newContext({
    storageState: role === "ADMIN" ? "tests/e2e/.auth/admin.json" : { cookies: [], origins: [] },
    viewport: { width, height: width === 320 ? 480 : 800 },
  });
  try {
    if (role !== "ADMIN") {
      await authorizeTestDevice(context, "FIXED");
      const login = await context.newPage();
      await login.goto("/login");
      await login.getByRole("tab", { name: "Dispositivo fijo", exact: true }).click();
      await login.locator('input[name="pin"]').fill(role === "STAFF" ? "123456" : "654321");
      await login.getByRole("button", { name: "Ingresar", exact: true }).click();
      await expect(login).toHaveURL(/\/pos/, { timeout: 30_000 });
      await login.close();
    }
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function assertDenominations(dialog: Locator) {
  await expect(dialog.getByLabel("Cantidad $0.50 moneda", { exact: true })).toHaveCount(1);
  for (const amount of ["0.05", "0.10", "0.20"]) {
    await expect(dialog.getByLabel(`Cantidad $${amount} moneda`, { exact: true })).toHaveCount(0);
  }
  await expect(dialog.getByRole("spinbutton")).toHaveCount(12);
}

// Each case owns a fresh jornada. Preserve the shared fixture for subsequent specs.
for (const role of ["ADMIN", "SUPERVISOR", "STAFF"] as const) {
  for (const width of [320, 1280]) {
    test(`${role} opening, count, POS change and closing at ${width}px`, async ({ browser }) => {
      test.setTimeout(120_000);
      const pool = new Pool({ connectionString: E2E_DATABASE_URL });
      const context = await operatorContext(browser, role, width);
      const page = await context.newPage();
      let originalOpenIds: number[] = [];
      let jornadaId: number | undefined;
      let unpaidId: number | undefined;
      const priorPermissions = (await pool.query<{ capability: string; enabled: boolean }>(
        'SELECT capability, enabled FROM "rolePermission" WHERE role = $1 AND capability = ANY($2::text[])',
        [role, ["jornada.open", "jornada.close"]],
      )).rows;
      try {
        if (role === "STAFF") {
          await page.goto("/admin/jornada");
          await expect(page.getByRole("button", { name: "Recuento", exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Cerrar jornada", exact: true })).toHaveCount(0);
          await expect(page.getByText("Esperado caja", { exact: true })).toHaveCount(0);
          // Opening/closing may be delegated; cash-summary access stays disabled.
          await pool.query(
            'INSERT INTO "rolePermission" (role, capability, enabled) VALUES ($1, $2, true), ($1, $3, true) ON CONFLICT (role, capability) DO UPDATE SET enabled = true',
            [role, "jornada.open", "jornada.close"],
          );
        }
        originalOpenIds = (await pool.query<{ id: number }>(
          "UPDATE jornada SET status = 'CLOSED' WHERE status = 'OPEN' RETURNING id",
        )).rows.map(row => row.id);
        await page.goto("/admin/jornada");
        await page.getByRole("button", { name: "Abrir jornada", exact: true }).last().click();
        const dialog = page.getByRole("alertdialog");
        await assertDenominations(dialog);
        await dialog.getByLabel("Cantidad $500.00 billete", { exact: true }).fill("1");
        await dialog.getByLabel("Cantidad $0.50 moneda", { exact: true }).fill("1");
        await expect(dialog.getByText("Total contado").locator("..")).toContainText("$500.50");
        await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
        await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
        await expect(dialog.getByText("Esperado: $500.50", { exact: true })).toHaveCount(role === "STAFF" ? 0 : 1);
        jornadaId = (await pool.query<{ id: number }>("SELECT id FROM jornada WHERE status = 'OPEN'")).rows[0].id;
        await dialog.getByRole("button", { name: "Listo", exact: true }).click();

        await page.getByRole("button", { name: "Recuento", exact: true }).click();
        await assertDenominations(dialog);
        await dialog.getByLabel("Cantidad $500.00 billete", { exact: true }).fill("1");
        await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("Agrega una nota");
        expect((await pool.query("SELECT id FROM cash_count WHERE \"jornadaId\" = $1 AND type = 'INTERIM'", [jornadaId])).rowCount).toBe(0);
        await dialog.getByLabel("Nota (opcional)").fill(`Faltante de cincuenta centavos ${role} ${width}`);
        await dialog.getByRole("button", { name: "Guardar conteo", exact: true }).click();
        await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
        await expect(dialog.getByText(/Diferencia:/)).toHaveCount(role === "STAFF" ? 0 : 1);
        await dialog.getByRole("button", { name: "Listo", exact: true }).click();

        await page.goto("/pos");
        await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
        if (width === 320) {
          const account = page.getByRole("button", { name: "Abrir cuenta", exact: true });
          await expect(account).toContainText("$25.00");
          await expect(account).toBeEnabled();
          await account.click();
          await page.getByRole("dialog", { name: /^Cuenta/ }).getByRole("button", { name: "Cobrar $25.00", exact: true }).click();
        } else {
          await expect(page.locator("tbody tr")).toHaveCount(1);
          await page.getByRole("button", { name: /Cerrar cuenta/ }).click();
        }
        const payment = page.getByRole("dialog");
        await payment.getByLabel("Efectivo recibido", { exact: true }).fill("50,50");
        await expect(payment.getByRole("status")).toContainText("$25.50");
        await payment.getByRole("button", { name: width === 320 ? "Cobrar $25.00" : "Confirmar y Cerrar", exact: true }).click();
        await expect(payment).toHaveCount(0);
        await expect.poll(async () => (await pool.query(
          'SELECT id FROM sales WHERE "paidJornadaId" = $1 AND status = \'PAID\' AND payment_method = \'CASH\'', [jornadaId],
        )).rowCount).toBe(1);

        await page.goto("/admin/jornada");
        if (role !== "STAFF") {
          await expect(page.getByText("Esperado caja", { exact: true }).locator("..")).toContainText("$525.50");
        }
        const operator = (await pool.query<{ id: number }>("SELECT id FROM users WHERE role = $1", [role])).rows[0];
        unpaidId = (await pool.query<{ id: number }>(
          'INSERT INTO sales ("totalCents", source_type, status, "placedBy", "jornadaId") VALUES (2500, \'MESA_9\', \'UNPAID\', $1, $2) RETURNING id',
          [operator.id, jornadaId],
        )).rows[0].id;
        await page.getByRole("button", { name: "Cerrar jornada", exact: true }).click();
        await assertDenominations(dialog);
        await dialog.getByLabel("Cantidad $500.00 billete", { exact: true }).fill("1");
        await dialog.getByLabel("Cantidad $20.00 billete", { exact: true }).fill("1");
        await dialog.getByLabel("Cantidad $5.00 moneda", { exact: true }).fill("1");
        await dialog.getByLabel("Cantidad $0.50 moneda", { exact: true }).fill("1");
        const save = dialog.getByRole("button", { name: "Guardar conteo", exact: true });
        await save.click();
        await expect(dialog.getByRole("alert")).toContainText("cuentas abiertas sin cobrar");
        expect((await pool.query("SELECT id FROM cash_count WHERE \"jornadaId\" = $1 AND type = 'CLOSING'", [jornadaId])).rowCount).toBe(0);
        await expect(save).toBeInViewport({ ratio: 1 });
        await pool.query("DELETE FROM sales WHERE id = $1", [unpaidId]);
        unpaidId = undefined;
        await save.click();
        await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
        await expect(dialog.getByText("Esperado: $525.50", { exact: true })).toHaveCount(role === "STAFF" ? 0 : 1);
        await dialog.getByRole("button", { name: "Listo", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Iniciar jornada", exact: true })).toBeVisible();
        const counts = (await pool.query<{ type: string; operatorId: number; counted: string; expected: string; difference: string; denominations: { valueCents: number }[] }>(
          'SELECT type, "operatorId", "countedAmountCents"::text AS counted, "expectedAmountCents"::text AS expected, "differenceCents"::text AS difference, denominations FROM cash_count WHERE "jornadaId" = $1 ORDER BY id', [jornadaId],
        )).rows;
        expect(counts.map(c => [c.type, c.counted, c.expected, c.difference])).toEqual([
          ["OPENING", "50050", "50050", "0"],
          ["INTERIM", "50000", "50050", "-50"],
          ["CLOSING", "52550", "52550", "0"],
        ]);
        expect(counts.every(c => c.operatorId === operator.id && c.denominations.every(d => d.valueCents >= 50))).toBe(true);
        expect((await pool.query('SELECT status, "closedBy", "actualClosingAmountCents"::text AS actual FROM jornada WHERE id = $1', [jornadaId])).rows[0]).toMatchObject({ status: "CLOSED", closedBy: operator.id, actual: "52550" });
      } finally {
        if (unpaidId) await pool.query("DELETE FROM sales WHERE id = $1", [unpaidId]);
        if (jornadaId) await pool.query("UPDATE jornada SET status = 'CLOSED' WHERE id = $1", [jornadaId]);
        if (originalOpenIds.length) await pool.query("UPDATE jornada SET status = 'OPEN' WHERE id = ANY($1::int[])", [originalOpenIds]);
        if (role === "STAFF") {
          await pool.query('DELETE FROM "rolePermission" WHERE role = $1 AND capability = ANY($2::text[])', [role, ["jornada.open", "jornada.close"]]);
          for (const permission of priorPermissions) {
            await pool.query('INSERT INTO "rolePermission" (role, capability, enabled) VALUES ($1, $2, $3)', [role, permission.capability, permission.enabled]);
          }
        }
        await context.close();
        await pool.end();
      }
    });
  }
}
