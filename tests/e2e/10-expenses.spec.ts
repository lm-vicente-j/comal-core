import { test, expect } from "@playwright/test";

test.describe("expenses", () => {
    test("creates an expense from the top dialog button and shows it in the history", async ({ page }, testInfo) => {
        const description = `Gasto e2e ${testInfo.project.name}`;
        await page.goto("/expenses");

        await page.getByRole("button", { name: "Nuevo gasto" }).click();
        const dialog = page.getByRole("dialog");
        await expect(dialog).toBeVisible();

        await dialog.locator('input[type="number"]').fill("55.5");
        await dialog.getByText("Seleccionar categoría").click();
        await page.getByRole("option", { name: "Insumos" }).click();
        await dialog.getByText("Seleccionar método").click();
        await page.getByRole("option", { name: "Transferencia" }).click();
        await dialog.getByPlaceholder("Detalle del gasto...").fill(description);
        await dialog.getByRole("button", { name: "Guardar Gasto" }).click();

        await expect(dialog).toBeHidden();
        await expect(page.getByText("Gasto guardado exitosamente.")).toBeVisible();
        await expect(page.getByText(description).first()).toBeVisible();
        await expect(page.getByText("Insumos · Transferencia").first()).toBeVisible();
    });

    test("keeps the dialog open showing validation errors on empty submit", async ({ page }) => {
        await page.goto("/expenses");
        await page.getByRole("button", { name: "Nuevo gasto" }).click();

        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "Guardar Gasto" }).click();

        await expect(dialog).toBeVisible();
        await expect(dialog.getByText("Ingrese un monto válido mayor a 0.")).toBeVisible();
        await expect(dialog.getByText("Seleccione una categoría.")).toBeVisible();
        await expect(dialog.getByText("Selecciona el método de pago.")).toBeVisible();
        await expect(dialog.getByRole("alert")).toHaveText("Ingresa una descripción del gasto.");
        await expect(dialog.getByLabel("Descripción")).toHaveAttribute("aria-invalid", "true");
    });


    test("explains a missing description even when the other fields are valid", async ({ page }, testInfo) => {
        await page.goto("/expenses");
        await page.getByRole("button", { name: "Nuevo gasto" }).click();
        const dialog = page.getByRole("dialog");
        await dialog.locator('input[type="number"]').fill("25");
        await dialog.getByText("Seleccionar categoría").click();
        await page.getByRole("option", { name: "Otros", exact: true }).click();

        for (const description of ["", "   "]) {
            await dialog.getByLabel("Descripción").fill(description);
            await dialog.getByRole("button", { name: "Guardar Gasto" }).click();
            await expect(dialog).toBeVisible();
            await expect(dialog.getByRole("alert")).toHaveText("Ingresa una descripción del gasto.");
            await expect(dialog.getByLabel("Descripción")).toHaveAttribute("aria-describedby", "expense-description-error");
        }
        await page.screenshot({ path: testInfo.outputPath("expense-description-error.png") });
        await testInfo.attach("expense-description-error", { path: testInfo.outputPath("expense-description-error.png"), contentType: "image/png" });
        await dialog.getByLabel("Descripción").fill("Compra de insumos");
        await expect(dialog.getByRole("alert")).toHaveCount(0);
        await expect(dialog.getByLabel("Descripción")).toHaveAttribute("aria-invalid", "false");
        await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
    });

    test("shows one numbered page at a time", async ({ page, isMobile }) => {
        await page.goto("/expenses");
        const rows = page.locator("tbody tr");
        await expect(rows).toHaveCount(10);
        const firstPage = await rows.allTextContents();
        const next = isMobile
            ? page.getByRole("button", { name: "Página siguiente", exact: true })
            : page.getByRole("link", { name: "Go to next page" });
        await next.click();
        await expect.poll(() => rows.allTextContents()).not.toEqual(firstPage);
        await expect(rows).toHaveCount(10);
        expect(new URL(page.url()).searchParams.has("page")).toBe(false);
    });
});
