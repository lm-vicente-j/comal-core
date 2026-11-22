import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

test.describe("crm", () => {

    for (const viewport of [{ width: 320, height: 568 }, { width: 1280, height: 720 }]) {
        test("orders and searches customers at " + viewport.width + "x" + viewport.height, async ({ page }, testInfo) => {
            test.setTimeout(120_000);
            const pool = new Pool({ connectionString: E2E_DATABASE_URL });
            const prefix = "Orden CRM E2E " + viewport.width;
            let ids: number[] = [];
            try {
                const { rows } = await pool.query<{ id: number }>(
                    'INSERT INTO customer ("customerName", "currentBalance", "registeredDate") VALUES ($1, 0, $5), ($2, 0, $6), ($3, 0, $6), ($4, 0, NULL) RETURNING id',
                    [prefix + " Alfa", prefix + " Zulu", prefix + " Bravo", prefix + " Sin fecha", "2025-01-01", "2026-01-01"]
                );
                ids = rows.map((row) => row.id);
                await page.setViewportSize(viewport);
                await page.goto("/admin/crm");

                const search = page.getByPlaceholder("Buscar cliente...").filter({ visible: true });
                const order = page.getByRole("button", { name: "Ordenar clientes" });
                await search.fill(prefix);
                const names = page.getByText(new RegExp("^" + prefix)).filter({ visible: true });
                await expect(names).toHaveText([prefix + " Bravo", prefix + " Zulu", prefix + " Alfa", prefix + " Sin fecha"]);

                const searchBox = await search.boundingBox();
                const orderBox = await order.boundingBox();
                expect(searchBox).not.toBeNull();
                expect(orderBox).not.toBeNull();
                expect(orderBox!.x + orderBox!.width).toBeLessThanOrEqual(searchBox!.x);

                await order.click();
                await expect(page.getByRole("menuitemradio", { name: "Más recientes" })).toHaveAttribute("aria-checked", "true");
                await page.getByRole("menuitemradio", { name: "Nombre A–Z" }).click();
                await expect(names).toHaveText([prefix + " Alfa", prefix + " Bravo", prefix + " Sin fecha", prefix + " Zulu"]);

                await search.fill(prefix + " Zulu");
                await expect(names).toHaveText([prefix + " Zulu"]);
                await search.fill(prefix);
                await order.click();
                await expect(page.getByRole("menuitemradio", { name: "Nombre A–Z" })).toHaveAttribute("aria-checked", "true");
                await page.screenshot({ path: testInfo.outputPath("crm-customer-order.png") });
                await testInfo.attach("crm-customer-order", { path: testInfo.outputPath("crm-customer-order.png"), contentType: "image/png" });
                await page.getByRole("menuitemradio", { name: "Más recientes" }).click();
                await expect(names).toHaveText([prefix + " Bravo", prefix + " Zulu", prefix + " Alfa", prefix + " Sin fecha"]);
                expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
            } finally {
                if (ids.length) await pool.query("DELETE FROM customer WHERE id = ANY($1::int[])", [ids]);
                await pool.end();
            }
        });
    }

    test("registers a new customer", async ({ page }) => {
        await page.goto("/admin/crm");

        await page.getByPlaceholder("Nombre Completo").fill("Cliente Playwright");
        await page.getByPlaceholder("XXXX-XXXX-XX").fill("555-111-22");
        await page.getByRole("button", { name: "Registrar Nuevo Cliente" }).click();

        await page.waitForTimeout(1000);
        await page.reload();
        // Desktop and mobile managers coexist in the DOM; use the visible one.
        await page.getByPlaceholder("Buscar cliente...").filter({ visible: true }).fill("Cliente Playwright");
        await expect(page.getByText("Cliente Playwright").first()).toBeVisible();
    });

    test("registers a new admin employee", async ({ page }) => {
        await page.goto("/admin/crm");
        await page.getByRole("tab", { name: "Empleados" }).click();

        // Both the edit and the create employee forms are in the DOM; use
        // the visible (non-hidden) one.
        const form = page.locator("form:not([hidden])").filter({ hasText: "Registrar Nuevo Empleado" });
        await form.getByPlaceholder("Nombre Completo").fill("Empleado Playwright Prueba");
        await form.getByText("Seleccionar Rol").click();
        await page.getByRole("option", { name: "Administrador" }).click();
        await form.getByPlaceholder("admin@ejemplo.com").fill("empleado.playwright@example.com");
        await form.getByPlaceholder("Contraseña...").fill("e2epass1");
        await form.getByRole("button", { name: "Registrar Nuevo Empleado" }).click();

        await page.waitForTimeout(1000);
        await page.reload();
        await page.getByRole("tab", { name: "Empleados" }).click();
        await page.getByPlaceholder("Buscar empleado...").filter({ visible: true }).fill("Empleado Playwright");
        await expect(page.getByText("Empleado Playwright Prueba").first()).toBeVisible();
    });

    test("desktop CRM exposes pagination controls for customer and staff tables", async ({ page }) => {
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 12 }, (_, index) => `ZZ CRM página ${index + 1}`);
        try {
            await pool.query('INSERT INTO customer ("customerName", "currentBalance") SELECT name, 0 FROM unnest($1::text[]) AS fixture(name)', [names]);
            await pool.query("INSERT INTO users (name, role, active) SELECT name, 'STAFF', true FROM unnest($1::text[]) AS fixture(name)", [names]);
            await page.setViewportSize({ width: 1280, height: 720 });
            await page.goto("/admin/crm");

            const desktopCRM = page.locator("div.hidden.md\\:flex");
            for (const [tab, editor] of [["Clientes", "Editar Cliente"], ["Empleados", "Editar usuario"]]) {
                await desktopCRM.getByRole("tab", { name: tab }).click();
                const table = desktopCRM.getByRole("tabpanel");
                await expect(table.getByRole("button", { name: "Anterior" })).toBeDisabled();
                await table.locator("tbody").getByRole("checkbox").first().click();
                await expect(desktopCRM.getByRole("heading", { name: editor })).toBeVisible();
                await table.getByRole("button", { name: "Siguiente" }).click();
                await expect(table.getByText(/Página 2 de/)).toBeVisible();
                await expect(desktopCRM.getByRole("heading", { name: editor })).toBeVisible();
                await desktopCRM.getByRole("button", { name: "+ Nuevo", exact: true }).click();
                await table.getByRole("button", { name: "Anterior" }).click();
                await expect(table.getByText(/Página 1 de/)).toBeVisible();
                await expect(table.locator("tbody").getByRole("checkbox").first()).not.toBeChecked();
            }

            await desktopCRM.getByRole("tab", { name: "Clientes" }).click();
            await desktopCRM.getByRole("tabpanel").locator("tbody").getByRole("checkbox").first().click();
            await desktopCRM.getByRole("button", { name: "Actualizar" }).click();
            await expect(desktopCRM.getByRole("heading", { name: "Editar Cliente" })).toHaveCount(0);
            await expect(desktopCRM.getByText("Guardado exitosamente.")).toBeVisible();
        } finally {
            await pool.query('DELETE FROM customer WHERE "customerName" = ANY($1::text[])', [names]);
            await pool.query("DELETE FROM users WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });

    test("creates, displays, edits, validates, searches and clears customer alias on desktop CRM", async ({ page }) => {
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const customerName = "Cliente Alias Desktop E2E";
        try {
            await page.setViewportSize({ width: 1280, height: 720 });
            await page.goto("/admin/crm");

            const desktopCRM = page.locator("div.hidden.md\\:flex");
            const table = desktopCRM.getByRole("tabpanel");
            await expect(table.getByRole("columnheader", { name: "Alias", exact: true })).toBeVisible();

            // Create customer with alias (with outer whitespace to test trimming).
            const createForm = desktopCRM.locator("form:not([hidden])").filter({ hasText: "Registrar Nuevo Cliente" });
            await createForm.getByPlaceholder("Nombre Completo").fill(customerName);
            await createForm.getByLabel("Alias (opcional)").fill("  El Güero  ");
            await createForm.getByPlaceholder("XXXX-XXXX-XX").fill("5550001122");
            await createForm.getByRole("button", { name: "Registrar Nuevo Cliente" }).click();
            await expect(desktopCRM.getByText("Guardado exitosamente.")).toBeVisible();

            // Search by alias and verify alias column renders trimmed value.
            const search = table.getByPlaceholder("Buscar cliente...");
            await search.fill("El Güero");
            const row = table.locator("tbody tr", { hasText: customerName });
            await expect(row).toHaveCount(1);
            await expect(row).toContainText("El Güero");

            // Select row -> Editar Cliente loads current alias.
            await row.click();
            const editForm = desktopCRM.locator("form:not([hidden])").filter({ hasText: "Editar Cliente" });
            const editAlias = editForm.getByLabel("Alias (opcional)");
            await expect(editAlias).toHaveValue("El Güero");

            // Edge case: alias exceeding 30 chars shows field validation error and blocks save.
            await editAlias.fill("A".repeat(31));
            await editForm.getByRole("button", { name: "Actualizar" }).click();
            await expect(editForm.getByText("El alias no puede superar 30 caracteres")).toBeVisible();

            // Update to a valid 30-char max-length alias.
            const maxAlias = "Alias30Chars_12345678901234567";
            expect(maxAlias.length).toBe(30);
            await editAlias.fill(maxAlias);
            await editForm.getByRole("button", { name: "Actualizar" }).click();
            await expect(desktopCRM.getByText("Guardado exitosamente.")).toBeVisible();

            await search.fill(maxAlias);
            await expect(table.locator("tbody tr", { hasText: customerName })).toContainText(maxAlias);

            // Clear alias back to empty -> table displays placeholder "—" and persists NULL.
            await table.locator("tbody tr", { hasText: customerName }).click();
            await expect(editAlias).toHaveValue(maxAlias);
            await editAlias.fill("   ");
            await editForm.getByRole("button", { name: "Actualizar" }).click();
            await expect(desktopCRM.getByText("Guardado exitosamente.")).toBeVisible();

            await search.fill(customerName);
            const clearedRow = table.locator("tbody tr", { hasText: customerName });
            await expect(clearedRow).toContainText("—");
            await expect(clearedRow).not.toContainText(maxAlias);
            const dbRow = (await pool.query<{ alias: string | null }>(
                'SELECT alias FROM customer WHERE "customerName" = $1',
                [customerName]
            )).rows[0];
            expect(dbRow?.alias).toBeNull();
        } finally {
            await pool.query('DELETE FROM customer WHERE "customerName" = $1', [customerName]);
            await pool.end();
        }
    });

    test("creates and edits customer alias on mobile CRM", async ({ page }) => {
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const customerName = "Cliente Alias Mobile E2E";
        try {
            await page.setViewportSize({ width: 375, height: 667 });
            await page.goto("/admin/crm");

            await page.getByRole("button", { name: "Nuevo" }).click();
            const dialog = page.getByRole("dialog");
            await dialog.getByPlaceholder("Nombre Completo").fill(customerName);
            await dialog.getByLabel("Alias (opcional)").fill("Compa Móvil");
            await dialog.getByRole("button", { name: "Registrar" }).click();
            await expect(dialog).toHaveCount(0, { timeout: 10_000 });

            const mobileCRM = page.locator("div.flex.md\\:hidden");
            const search = mobileCRM.getByPlaceholder("Buscar cliente...");
            await search.fill("Compa Móvil");
            await expect(mobileCRM.getByText(customerName)).toBeVisible();
            await expect(mobileCRM.getByText("Alias: Compa Móvil")).toBeVisible();

            // Edit alias on mobile
            const card = mobileCRM.locator("div.bg-white.p-4", { hasText: customerName });
            await card.getByRole("button").click();
            await expect(dialog.getByLabel("Alias (opcional)")).toHaveValue("Compa Móvil");
            await dialog.getByLabel("Alias (opcional)").fill("Alias Nuevo");
            await dialog.getByRole("button", { name: "Actualizar" }).click();
            await expect(dialog).toHaveCount(0, { timeout: 10_000 });

            await search.fill("Alias Nuevo");
            await expect(mobileCRM.getByText("Alias: Alias Nuevo")).toBeVisible();
        } finally {
            await pool.query('DELETE FROM customer WHERE "customerName" = $1', [customerName]);
            await pool.end();
        }
    });

    test("keeps existing CRM rows without loading flicker when refresh has no changes, and updates smoothly when data changes", async ({ page }) => {
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const customerName = "Cliente Sin Parpadeo E2E";
        let customerId: number | null = null;
        try {
            const { rows } = await pool.query<{ id: number }>(
                'INSERT INTO customer ("customerName", "alias", "currentBalance") VALUES ($1, $2, 0) RETURNING id',
                [customerName, "Alias Inicial"]
            );
            customerId = rows[0].id;

            await page.setViewportSize({ width: 1280, height: 720 });
            await page.goto("/admin/crm");

            const desktopCRM = page.locator("div.hidden.md\\:flex");
            const table = desktopCRM.getByRole("tabpanel");
            const search = table.getByPlaceholder("Buscar cliente...");
            await search.fill(customerName);

            const customerRow = table.locator("tbody tr", { hasText: customerName });
            await expect(customerRow).toHaveCount(1);
            await expect(customerRow).toContainText("Alias Inicial");

            // Track whether Cargando… ever appears or the rendered row DOM node is detached.
            await page.evaluate((name) => {
                const tbody = document.querySelector("div.hidden.md\\:flex [role='tabpanel'] tbody");
                const targetRow = Array.from(tbody?.querySelectorAll("tr") ?? []).find((tr) =>
                    tr.textContent?.includes(name)
                );
                const state = {
                    sawLoading: false,
                    rowDetached: false,
                    targetRow,
                };
                (window as unknown as Record<string, unknown>).__crmRefreshWatch = state;
                if (!tbody) return;
                const observer = new MutationObserver(() => {
                    if (tbody.querySelector("[role='status']") || tbody.textContent?.includes("Cargando")) {
                        state.sawLoading = true;
                    }
                    if (state.targetRow && !state.targetRow.isConnected) {
                        state.rowDetached = true;
                    }
                });
                observer.observe(tbody, { childList: true, subtree: true, characterData: true });
            }, customerName);

            // 1. Trigger AutoRefresh with NO changes in the database.
            const autoRefreshPost = page.waitForResponse(
                (res) => res.url().includes("/admin/crm") && res.request().method() === "POST"
            );
            await page.evaluate(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await autoRefreshPost;
            await page.waitForTimeout(300);

            const afterNoChangeRefresh = await page.evaluate(() => {
                const state = (window as unknown as Record<string, { sawLoading: boolean; rowDetached: boolean }>).__crmRefreshWatch;
                return { sawLoading: state.sawLoading, rowDetached: state.rowDetached };
            });
            expect(afterNoChangeRefresh.sawLoading).toBe(false);
            expect(afterNoChangeRefresh.rowDetached).toBe(false);

            // 2. Submit "Actualizar" without changing any field — still no loading flicker or row replacement.
            await customerRow.click();
            const editForm = desktopCRM.locator("form:not([hidden])").filter({ hasText: "Editar Cliente" });
            await expect(editForm).toBeVisible();
            await editForm.getByRole("button", { name: "Actualizar" }).click();
            await expect(desktopCRM.getByText("Guardado exitosamente.")).toBeVisible();
            await page.waitForTimeout(400);

            const afterNoChangeUpdate = await page.evaluate(() => {
                const state = (window as unknown as Record<string, { sawLoading: boolean; rowDetached: boolean }>).__crmRefreshWatch;
                return { sawLoading: state.sawLoading, rowDetached: state.rowDetached };
            });
            expect(afterNoChangeUpdate.sawLoading).toBe(false);
            expect(afterNoChangeUpdate.rowDetached).toBe(false);

            // 3. Apply a real external DB change and trigger AutoRefresh — updates smoothly without Cargando….
            await pool.query('UPDATE customer SET alias = $1 WHERE id = $2', ["Alias Remoto", customerId]);
            await page.evaluate(() => {
                document.dispatchEvent(new Event("visibilitychange"));
            });
            await expect(customerRow).toContainText("Alias Remoto");

            const afterRealChange = await page.evaluate(() => {
                const state = (window as unknown as Record<string, { sawLoading: boolean }>).__crmRefreshWatch;
                return { sawLoading: state.sawLoading };
            });
            expect(afterRealChange.sawLoading).toBe(false);
        } finally {
            if (customerId !== null) {
                await pool.query("DELETE FROM customer WHERE id = $1", [customerId]);
            }
            await pool.end();
        }
    });
});
