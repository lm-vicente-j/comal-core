import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { confirmAccessChange } from "./access-confirmation";

const screenshots = path.resolve("artifacts/access-screens");

test.describe("staff and browser access", () => {
    test("renders the new owner screens without horizontal overflow", async ({ page }, testInfo) => {
        await mkdir(screenshots, { recursive: true });
        await page.goto("/admin/access");
        await expect(page.getByRole("heading", { name: "Access" })).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Nombre de Staff E2E", exact: true })).toHaveValue("Staff E2E");
        for (const [tab, file] of [["Personal", "staff"], ["Permisos", "permissions"], ["Dispositivos", "devices"]]) {
            await page.getByRole("tab", { name: tab, exact: true }).click();
            if (tab === "Permisos") {
                await expect(page.getByRole("button", { name: "Guardar Supervisión", exact: true })).toBeVisible();
            }
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await page.screenshot({ path: path.join(screenshots, `${file}-${testInfo.project.name}.png`), fullPage: true, animations: "disabled" });
        }
    });

    test("requires browser approval and invalidates access after type change and revocation", async ({ browser, page, baseURL }, testInfo) => {
        test.setTimeout(120_000);
        const guestContext = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, viewport: page.viewportSize() ?? undefined });
        const guest = await guestContext.newPage();
        try {
            await guest.goto("/login");
            await expect(guest.getByRole("heading", { name: "Primera instalación" })).toHaveCount(0);
            await guest.getByRole("tab", { name: "Dispositivo fijo", exact: true }).click();
            await guest.locator('input[name="pin"]').fill("123456");
            await guest.getByRole("button", { name: "Ingresar", exact: true }).click();
            await expect(guest.getByRole("alert")).toBeVisible();
            await expect(guest).toHaveURL(/\/login/);
            await guest.screenshot({ path: path.join(screenshots, `fixed-sign-in-${testInfo.project.name}.png`), fullPage: true, animations: "disabled" });

            await guest.getByRole("button", { name: "Solicitar acceso", exact: true }).click();
            await expect(guest.getByRole("button", { name: /Esperando autorización/ })).toBeVisible();
            await page.goto("/admin/access");
            await page.getByRole("tab", { name: "Dispositivos", exact: true }).click();
            const request = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Autorizar", exact: true }) }).last();
            await expect(request).toBeVisible();
            const terminalName = `Counter ${testInfo.project.name}`;
            await request.getByLabel("Nombre del dispositivo", { exact: true }).fill(terminalName);
            await request.getByRole("button", { name: "Autorizar", exact: true }).click();
            await page.screenshot({ path: path.join(screenshots, `confirmation-authorize-${testInfo.project.name}.png`), animations: "disabled" });
            await page.getByRole("alertdialog").getByRole("button", { name: "Cancelar", exact: true }).click();
            await expect(request).toBeVisible();
            await expect(guest.getByRole("button", { name: /Esperando autorización/ })).toBeVisible();
            await request.getByRole("button", { name: "Autorizar", exact: true }).click();
            await confirmAccessChange(page);
            await expect(guest.getByText(/Dispositivo autorizado:/)).toBeVisible({ timeout: 20_000 });
            expect((await guestContext.cookies()).find(cookie => cookie.name === "comal_terminal")?.httpOnly).toBe(true);
            await guest.locator('input[name="pin"]').fill("123456");
            await guest.getByRole("button", { name: "Ingresar", exact: true }).click();
            await expect(guest).toHaveURL(/\/pos/, { timeout: 30_000 });
            await guest.goto("/admin/access");
            await expect(guest).toHaveURL(/\/pos/);

            await page.getByRole("tab", { name: "Permisos", exact: true }).click();
            const service = page.locator("section").filter({ has: page.getByRole("heading", { name: "Servicio", exact: true }) }).last();
            await service.getByRole("checkbox", { name: "Registrar gastos", exact: true }).uncheck();
            await service.getByRole("button", { name: "Guardar Servicio", exact: true }).click();
            await expect(page.getByRole("alertdialog")).toBeVisible();
            await page.screenshot({ path: path.join(screenshots, `confirmation-permissions-${testInfo.project.name}.png`), animations: "disabled" });
            await confirmAccessChange(page);
            await expect(page.getByRole("status").filter({ hasText: "Permisos guardados" })).toBeVisible();
            await guest.goto("/expenses");
            await expect(guest).toHaveURL(/\/pos/);
            await service.getByRole("checkbox", { name: "Registrar gastos", exact: true }).check();
            await service.getByRole("button", { name: "Guardar Servicio", exact: true }).click();
            await confirmAccessChange(page);
            await expect(page.getByRole("status").filter({ hasText: "Permisos guardados" })).toBeVisible();
            await guest.goto("/expenses");
            await expect(guest).toHaveURL(/\/expenses/);
            await page.getByRole("tab", { name: "Dispositivos", exact: true }).click();
            const terminal = page.getByRole("listitem").filter({ has: page.getByText(terminalName, { exact: true }) });
            await terminal.getByRole("combobox", { name: "Tipo de dispositivo", exact: true }).selectOption("MOBILE");
            await confirmAccessChange(page);
            await expect(page.getByRole("status")).toContainText("Dispositivo actualizado");
            await guest.goto("/pos");
            await expect(guest).toHaveURL(/\/login/);
            await guest.getByRole("tab", { name: "Dispositivo móvil", exact: true }).click();
            await guest.locator('input[name="username"]').fill("TEST1");
            await guest.locator('input[name="pin"]').fill("123456");
            await guest.screenshot({ path: path.join(screenshots, `mobile-sign-in-${testInfo.project.name}.png`), fullPage: true, animations: "disabled" });
            await guest.getByRole("button", { name: "Ingresar", exact: true }).click();
            await expect(guest).toHaveURL(/\/pos/, { timeout: 30_000 });

            await guest.evaluate(() => sessionStorage.setItem("previous-operator", "private draft"));
            const menu = guest.getByRole("button", { name: "Menú de usuario", exact: true }).or(guest.getByRole("button", { name: "Staff E2E", exact: true }));
            await menu.click();
            await guest.getByRole("menuitem", { name: "Cambiar operador / salir", exact: true }).click();
            await expect(guest).toHaveURL(/\/login/);
            expect(await guest.evaluate(() => sessionStorage.getItem("previous-operator"))).toBeNull();
            expect((await guestContext.cookies()).some(cookie => cookie.name === "comal_terminal")).toBe(true);
            await guest.getByRole("tab", { name: "Dispositivo móvil", exact: true }).click();
            await guest.locator('input[name="username"]').fill("TEST1");
            await guest.locator('input[name="pin"]').fill("123456");
            await guest.getByRole("button", { name: "Ingresar", exact: true }).click();
            await expect(guest).toHaveURL(/\/pos/);

            await terminal.getByRole("button", { name: `Revocar dispositivo ${terminalName}`, exact: true }).click();
            await expect(page.getByRole("alertdialog")).toBeVisible();
            await page.screenshot({ path: path.join(screenshots, `confirmation-revoke-${testInfo.project.name}.png`), animations: "disabled" });
            await confirmAccessChange(page);
            await expect(page.getByRole("status")).toContainText("revocado");
            await guest.goto("/pos");
            await expect(guest).toHaveURL(/\/login/);
            await guest.getByRole("tab", { name: "Dispositivo móvil", exact: true }).click();
            await guest.locator('input[name="username"]').fill("TEST1");
            await guest.locator('input[name="pin"]').fill("123456");
            await guest.getByRole("button", { name: "Ingresar", exact: true }).click();
            await expect(guest.getByRole("alert")).toBeVisible();
            await expect(guest).toHaveURL(/\/login/);
        } finally {
            const pool = new Pool({ connectionString: E2E_DATABASE_URL });
            try { await pool.query('DELETE FROM "rolePermission" WHERE role = $1 AND capability = $2', ["STAFF", "expenses.create"]); }
            finally { await pool.end(); }
            await guestContext.close();
        }
    });
    for (const width of [320, 800, 1440]) {
        test(`reviews Access panel geometry at ${width}px`, { tag: "@desktop-only" }, async ({ page }) => {
            await page.setViewportSize({ width, height: 1000 });
            await page.goto("/admin/access");
            for (const [tab, file] of [["Personal", "staff"], ["Permisos", "permissions"], ["Dispositivos", "devices"]]) {
                await page.getByRole("tab", { name: tab, exact: true }).click();
                if (tab === "Permisos") await expect(page.getByRole("button", { name: "Guardar Supervisión", exact: true })).toBeVisible();
                if (tab === "Personal") await expect(page.getByRole("textbox", { name: "Nombre de Staff E2E", exact: true })).toBeVisible();
                if (width === 320) {
                    const sizes = await page.getByRole("tab").evaluateAll(tabs => tabs.map(tab => getComputedStyle(tab).fontSize));
                    expect(new Set(sizes).size).toBe(1);
                }
                if (tab === "Personal" && width >= 640) {
                    const name = await page.getByRole("textbox", { name: "Nombre de Staff E2E", exact: true }).boundingBox();
                    const role = await page.getByRole("combobox", { name: "Rol de Staff E2E", exact: true }).boundingBox();
                    expect(name!.y).toBeCloseTo(role!.y, 0);
                }
                const issues = await page.getByRole("tabpanel").evaluate(panel => {
                    const controls = [...panel.querySelectorAll<HTMLElement>("input,button,select")].map(element => ({
                        label: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
                        rect: element.getBoundingClientRect(),
                    })).filter(control => control.rect.width > 0 && control.rect.height > 0);
                    const errors: string[] = [];
                    for (let index = 0; index < controls.length; index++) {
                        const current = controls[index];
                        if (current.rect.left < -1 || current.rect.right > window.innerWidth + 1) errors.push(`Outside viewport: ${current.label}`);
                        for (const other of controls.slice(index + 1)) {
                            const x = Math.min(current.rect.right, other.rect.right) - Math.max(current.rect.left, other.rect.left);
                            const y = Math.min(current.rect.bottom, other.rect.bottom) - Math.max(current.rect.top, other.rect.top);
                            if (x > 2 && y > 2) errors.push(`Overlap: ${current.label} / ${other.label}`);
                        }
                    }
                    return errors;
                });
                expect(issues).toEqual([]);
                await page.screenshot({ path: path.join(screenshots, `${file}-${width}.png`), animations: "disabled" });
            }
        });
    }

});
