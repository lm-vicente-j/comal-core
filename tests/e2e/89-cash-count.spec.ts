import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

test.describe("immutable cash counts", () => {
  test("saves denomination detail and rejects database edits and deletes", async ({
    page,
  }) => {
    const pool = new Pool({ connectionString: E2E_DATABASE_URL });
    try {
      await page.goto("/admin/jornada");
      await page.getByRole("button", { name: "Recuento", exact: true }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(
        dialog.getByText("Total contado").locator(".."),
      ).toContainText("$0.00");
      await expect(dialog.getByText(/-\$0\.00/)).toHaveCount(0);
      await dialog.getByRole("button", { name: "Guardar conteo" }).click();
      await expect(dialog.getByRole("alert")).toContainText(
        "Confirma que la caja está vacía",
      );
      await dialog.getByLabel("Cantidad $5.00 moneda").fill("1");
      await dialog
        .getByLabel("Nota (opcional)")
        .fill("Conteo E2E de inmutabilidad");
      await expect(dialog.getByText("Esperado:")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Guardar conteo" }).click();
      await expect(dialog.getByText(/Conteo guardado/)).toBeVisible();
      await expect(dialog.getByText("Esperado:")).toBeVisible();

      const row = (
        await pool.query<{
          id: number;
          jornadaId: number;
          countedAmountCents: string;
        }>(
          `SELECT id, "jornadaId", "countedAmountCents"::text AS "countedAmountCents"
         FROM cash_count WHERE note = $1 ORDER BY id DESC LIMIT 1`,
          ["Conteo E2E de inmutabilidad"],
        )
      ).rows[0];
      expect(row).toBeTruthy();
      expect(row.countedAmountCents).toBe("500");
      await expect(
        pool.query("UPDATE cash_count SET note = $1 WHERE id = $2", [
          "cambiado",
          row.id,
        ]),
      ).rejects.toThrow();
      await expect(
        pool.query("DELETE FROM cash_count WHERE id = $1", [row.id]),
      ).rejects.toThrow();
      await dialog.getByRole("button", { name: "Listo" }).click();
    } finally {
      await pool.end();
    }
  });
});
