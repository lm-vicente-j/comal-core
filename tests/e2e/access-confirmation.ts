import { expect, type Page } from "@playwright/test";

export async function confirmAccessChange(page: Page) {
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancelar", exact: true })).toBeVisible();
    await dialog.getByRole("button").last().click();
    await expect(dialog).toBeHidden();
}
