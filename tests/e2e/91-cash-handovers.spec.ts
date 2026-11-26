import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { mkdir } from "node:fs/promises";
import { E2E_DATABASE_URL } from "../../playwright.config";

test.use({ actionTimeout: 10_000 });

for (const viewport of [
  { width: 393, height: 852, label: "mobile" },
  { width: 1440, height: 1000, label: "desktop" },
]) {
  test(`cash handover confirmation and receipt on ${viewport.label}`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const pool = new Pool({ connectionString: E2E_DATABASE_URL });
    const context = await browser.newContext({
      storageState: "tests/e2e/.auth/admin.json",
      viewport,
    });
    const page = await context.newPage();
    const owner = (
      await pool.query<{ id: number }>(
        "SELECT id FROM users WHERE role = 'ADMIN'",
      )
    ).rows[0].id;
    const incoming = (
      await pool.query<{ id: number }>(
        "SELECT id FROM users WHERE username = 'TEST1'",
      )
    ).rows[0].id;
    const prior = (
      await pool.query<{ id: number }>(
        "UPDATE jornada SET status = 'CLOSED' WHERE status = 'OPEN' RETURNING id",
      )
    ).rows.map((r) => r.id);
    let jornadaId: number | undefined;
    try {
      jornadaId = (
        await pool.query<{ id: number }>(
          'INSERT INTO jornada ("openedBy", "openingAmountCents", status, "openedAt") VALUES ($1, 50000, \'OPEN\', NOW()) RETURNING id',
          [owner],
        )
      ).rows[0].id;
      await page.goto("/admin/jornada");
      await expect(
        page.getByText("Responsable de caja: Admin E2E", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Entregar caja", exact: true })
        .click();
      const dialog = page.getByRole("alertdialog");
      await expect(
        dialog.getByRole("heading", { name: "Entregar caja", exact: true }),
      ).toBeVisible();
      await dialog
        .getByLabel("Cantidad $200.00 billete", { exact: true })
        .fill("2");
      await dialog
        .getByLabel("Cantidad $50.00 billete", { exact: true })
        .fill("1");
      await dialog
        .getByLabel("Cantidad $20.00 billete", { exact: true })
        .fill("2");
      await dialog
        .getByLabel("Nota (opcional)")
        .fill("Faltante de $10.00 verificado al entregar la caja.");
      await dialog
        .getByLabel("Recibe la caja", { exact: true })
        .selectOption(String(incoming));
      const confirm = dialog.getByRole("button", {
        name: "Guardar conteo",
        exact: true,
      });
      await expect(confirm).toBeDisabled();
      await expect(dialog.locator('[data-slot="input-otp-slot"]')).toHaveCount(
        6,
      );
      await dialog
        .getByLabel("PIN de quien recibe", { exact: true })
        .fill("000000");
      await confirm.click();
      await expect(dialog.getByRole("alert")).toContainText(
        "Revisa el operador entrante y su PIN",
      );
      expect(
        (
          await pool.query('SELECT id FROM cash_count WHERE "jornadaId"=$1', [
            jornadaId,
          ])
        ).rowCount,
      ).toBe(0);
      const pinBoxes = dialog.getByLabel("PIN de quien recibe", {
        exact: true,
      });
      await pinBoxes.press("ControlOrMeta+A");
      await pinBoxes.press("Backspace");
      await expect(pinBoxes).toHaveValue("");
      await pinBoxes.pressSequentially("123456");
      await expect(pinBoxes).toHaveValue("123456");
      await expect(dialog.locator('[data-slot="input-otp-mask"]')).toHaveCount(
        6,
      );
      await dialog
        .getByLabel("Recibe la caja", { exact: true })
        .scrollIntoViewIfNeeded();
      // Retain the complete form, including the accepted total, in the review image.
      await dialog
        .getByText("Total contado", { exact: true })
        .scrollIntoViewIfNeeded();
      await mkdir("ci_results/issue-42", { recursive: true });
      await page.screenshot({
        path: `ci_results/issue-42/handover-${viewport.label}.png`,
        fullPage: true,
        style: "nextjs-portal { display: none !important; }",
      });
      await confirm.click();
      await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
      await expect(
        dialog.getByText("Recibe: Staff E2E · PIN confirmado", { exact: true }),
      ).toBeVisible();
      await expect(
        dialog.getByText("Diferencia: -$10.00 · Con diferencia", {
          exact: true,
        }),
      ).toBeVisible();
      await page.screenshot({
        path: `ci_results/issue-42/receipt-${viewport.label}.png`,
        fullPage: true,
        style: "nextjs-portal { display: none !important; }",
      });
      const saved = (
        await pool.query<{
          operatorId: number;
          incomingOperatorId: number;
          differenceCents: string;
        }>(
          'SELECT "operatorId", "incomingOperatorId", "differenceCents" FROM cash_count WHERE "jornadaId"=$1',
          [jornadaId],
        )
      ).rows;
      expect(saved).toEqual([
        {
          operatorId: owner,
          incomingOperatorId: incoming,
          differenceCents: "-1000",
        },
      ]);
      await dialog.getByRole("button", { name: "Listo", exact: true }).click();
      await expect(
        page.getByText("Responsable de caja: Staff E2E", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Entregar caja", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Historial", exact: true })
        .click();
      await page
        .getByRole("combobox", { name: "Tipo", exact: true })
        .selectOption("HANDOVER");
      await page.getByRole("button", { name: "Filtrar", exact: true }).click();
      await expect(
        page.getByRole("button", { name: /^Relevo Jornada/ }).first(),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      if (jornadaId)
        await pool.query("UPDATE jornada SET status='CLOSED' WHERE id=$1", [
          jornadaId,
        ]);
      if (prior.length)
        await pool.query(
          "UPDATE jornada SET status='OPEN' WHERE id=ANY($1::int[])",
          [prior],
        );
      await context.close();
      await pool.end();
    }
  });
}
