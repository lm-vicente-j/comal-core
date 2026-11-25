import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

test.describe("Mobile UX adversarial checks (Round 2)", () => {
    test("usePaginatedResource clears stale failedRequest so revisiting a failed page shows loading state and locks navigation", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 15 }, (_, i) => `ZZ R2Retry Prod ${String(i + 1).padStart(2, "0")}`);

        try {
            await pool.query(
                'INSERT INTO products (name, "priceCents") SELECT name, 1500 FROM unnest($1::text[]) AS name',
                [names]
            );

            await page.setViewportSize({ width: 360, height: 640 });
            await page.goto("/admin/menu");

            const mobileMenu = page.locator("main div.md\\:hidden");
            const nav = mobileMenu.getByRole("navigation", { name: "Paginación de productos" });
            await expect(nav).toContainText("Página 1 de 2", { timeout: 15_000 });

            let failPage2 = true;
            let delayPage2Ms = 0;
            await page.route("**/admin/menu", async (route) => {
                const req = route.request();
                if (req.method() === "POST" && /"page":\s*2\b/.test(req.postData() ?? "")) {
                    if (failPage2) {
                        await route.fulfill({ status: 503, body: "Service unavailable" });
                        return;
                    }
                    if (delayPage2Ms > 0) {
                        await new Promise((r) => setTimeout(r, delayPage2Ms));
                    }
                }
                await route.continue();
            });

            // Trigger an initial failure on page 2, then navigate back to page 1
            await nav.getByRole("button", { name: "Página siguiente" }).click();
            await expect(mobileMenu.getByText("No se pudieron cargar los registros. Intenta de nuevo.")).toBeVisible({ timeout: 10_000 });

            await nav.getByRole("button", { name: "Página anterior" }).click();
            await expect(mobileMenu.getByText(names[0])).toBeVisible({ timeout: 10_000 });

            // Revisit page 2 with a slow successful response; must show loading state and disable navigation until settled
            failPage2 = false;
            delayPage2Ms = 1000;
            await nav.getByRole("button", { name: "Página siguiente" }).click();

            await expect(mobileMenu.getByText("No se pudieron cargar los registros. Intenta de nuevo.")).toHaveCount(0);
            await expect(mobileMenu.getByText("Cargando…")).toBeVisible();
            await expect(nav.getByRole("button", { name: "Página anterior" })).toBeDisabled();
            await expect(nav).toContainText("Página 2 de 2", { timeout: 10_000 });
            await expect(mobileMenu.getByText(names[14])).toBeVisible({ timeout: 10_000 });
        } finally {
            await page.unroute("**/admin/menu");
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });

    test("usePaginatedResource does not issue a redundant loadPage request when the server clamps resolvedPage", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 25 }, (_, i) => `R2Clamp Prod ${String(i + 1).padStart(2, "0")}`);

        try {
            await pool.query(
                'INSERT INTO products (name, "priceCents") SELECT name, 2000 FROM unnest($1::text[]) AS name',
                [names]
            );

            await page.setViewportSize({ width: 360, height: 640 });
            await page.goto("/admin/menu");

            const mobileMenu = page.locator("main div.md\\:hidden");
            const nav = mobileMenu.getByRole("navigation", { name: "Paginación de productos" });

            await mobileMenu.getByPlaceholder("Buscar producto...").fill("R2Clamp Prod");
            await expect(nav).toContainText("Página 1 de 3", { timeout: 15_000 });

            await nav.getByRole("button", { name: "Página siguiente" }).click();
            await expect(nav).toContainText("Página 2 de 3", { timeout: 15_000 });
            await nav.getByRole("button", { name: "Página siguiente" }).click();
            await expect(nav).toContainText("Página 3 de 3", { timeout: 15_000 });
            await expect(mobileMenu.getByText(names[20])).toBeVisible({ timeout: 15_000 });

            // Shrink matching results from 25 (3 pages) to 11 (2 pages) while keeping item 21 visible for edit
            const toDelete = [...names.slice(11, 20), ...names.slice(21)];
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [toDelete]);

            // Save item 21 so invalidate() runs, then count getProductPage POST calls triggered by clamping 3 -> 2
            const editBtn = mobileMenu.locator(".bg-white.p-4").first().getByRole("button");
            await editBtn.click();
            const dialog = page.getByRole("dialog");
            await expect(dialog).toBeVisible();
            await dialog.locator('input[name="price"]').fill("25");

            const pageRequests: string[] = [];
            await page.route("**/admin/menu", async (route) => {
                const req = route.request();
                if (req.method() === "POST") {
                    const body = req.postData() ?? "";
                    if (/"search":"R2Clamp Prod"/.test(body)) {
                        pageRequests.push(body);
                    }
                }
                await route.continue();
            });

            await dialog.getByRole("button", { name: "Actualizar" }).click();
            await expect(dialog.getByText("Guardado exitosamente.")).toBeVisible({ timeout: 15_000 });
            await expect(nav).toContainText("Página 2 de 2", { timeout: 15_000 });

            // Allow time for any redundant debounced follow-up request to fire
            await page.waitForTimeout(500);

            expect(pageRequests).toHaveLength(1);
        } finally {
            await page.unroute("**/admin/menu");
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });

    test("MobilePosManager keeps OTHER_OPEN Jornada only in the user menu and the product grid usable on 320x480", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        let originalOpenedBy: number | null = null;
        let openJornadaId: number | null = null;
        let otherAdminId: number | null = null;

        try {
            const openRow = (await pool.query<{ id: number; openedBy: number }>(
                'SELECT id, "openedBy" FROM jornada WHERE status = $1 ORDER BY id DESC LIMIT 1',
                ["OPEN"]
            )).rows[0];
            expect(openRow).toBeTruthy();
            openJornadaId = openRow.id;
            originalOpenedBy = openRow.openedBy;

            const other = (await pool.query<{ id: number }>(
                "INSERT INTO users (name, email, username, password, role, active) VALUES ($1, $2, $3, $4, 'ADMIN', true) RETURNING id",
                ["Other Admin R2", "other-r2@e2e.local", "OTHERR2", "x"]
            )).rows[0];
            otherAdminId = other.id;

            await pool.query('UPDATE jornada SET "openedBy" = $1 WHERE id = $2', [otherAdminId, openJornadaId]);

            await page.setViewportSize({ width: 320, height: 480 });
            await page.goto("/pos");

            await expect(page.getByRole("link", { name: "Cerrar y abrir nueva" })).toBeHidden();
            await page.getByRole("button", { name: "Menú de usuario" }).click();
            await expect(page.getByRole("menuitem", { name: new RegExp(`Jornada #${openJornadaId}`) })).toContainText("De Other Admin R2 · pendiente");
            await page.keyboard.press("Escape");

            const mobilePos = page.locator("main > div.overflow-y-auto > div.lg\\:hidden");
            await mobilePos.getByRole("button", { name: "Mesas", exact: true }).click();
            await mobilePos.getByRole("button", { name: "1", exact: true }).click();
            await expect(mobilePos.getByRole("button", { name: "Abrir cuenta" })).toBeVisible({ timeout: 15_000 });

            const gridBox = await mobilePos
                .locator("div.min-h-0.flex-1.overflow-y-auto.overscroll-y-contain")
                .boundingBox();
            expect(gridBox).not.toBeNull();
            // Product grid must remain tall enough to display at least a single 96px (min-h-24) product card
            expect(gridBox!.height).toBeGreaterThanOrEqual(96);
        } finally {
            if (openJornadaId !== null && originalOpenedBy !== null) {
                await pool.query('UPDATE jornada SET "openedBy" = $1 WHERE id = $2', [originalOpenedBy, openJornadaId]);
            }
            if (otherAdminId !== null) {
                await pool.query("DELETE FROM users WHERE id = $1", [otherAdminId]);
            }
            await pool.end();
        }
    });

    test("DebtorsTable preserves readable table scroll height on 320x480 when no Jornada is open", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        let closedJornadaId: number | null = null;
        const customerIds: number[] = [];
        const saleIds: number[] = [];

        try {
            const admin = (await pool.query<{ id: number }>(
                "SELECT id FROM users WHERE email = $1 LIMIT 1",
                ["admin@e2e.local"]
            )).rows[0];
            const jornada = (await pool.query<{ id: number }>(
                'SELECT id FROM jornada WHERE status = $1 ORDER BY "openedAt" DESC LIMIT 1',
                ["OPEN"]
            )).rows[0];

            for (let i = 1; i <= 5; i++) {
                const c = (await pool.query<{ id: number }>(
                    'INSERT INTO customer ("customerName", "currentBalanceCents", "registeredDate") VALUES ($1, 1000, CURRENT_DATE) RETURNING id',
                    [`R2 Compact Debtor ${i}`]
                )).rows[0];
                customerIds.push(c.id);

                const s = (await pool.query<{ id: number }>(
                    'INSERT INTO sales ("totalCents", source_type, "customerID", "placedBy", status) VALUES (1000, $1, $2, $3, $4) RETURNING id',
                    ["CL- R2", c.id, admin.id, "DEBT"]
                )).rows[0];
                saleIds.push(s.id);

                await pool.query(
                    'INSERT INTO debtors ("saleID", "customerID", "amountCents", status, "createdJornadaId") VALUES ($1, $2, 1000, $3, $4)',
                    [s.id, c.id, "DEBT", jornada.id]
                );
            }

            closedJornadaId = jornada.id;
            await pool.query('UPDATE jornada SET status = $1, "closedAt" = NOW() WHERE id = $2', ["CLOSED", closedJornadaId]);

            await page.setViewportSize({ width: 320, height: 480 });
            await page.goto("/debtors");

            const scrollArea = page.locator('[data-slot="scroll-area"]');
            await expect(scrollArea).toBeVisible({ timeout: 15_000 });

            const scrollAreaBox = await scrollArea.boundingBox();
            const firstRowBox = await scrollArea.locator("tbody tr").first().boundingBox();
            expect(scrollAreaBox).not.toBeNull();
            expect(firstRowBox).not.toBeNull();

            // Table scroll region must fit both its 40px header and at least one visible debtor row
            expect(scrollAreaBox!.height).toBeGreaterThanOrEqual(80);
            expect(firstRowBox!.y + firstRowBox!.height).toBeLessThanOrEqual(scrollAreaBox!.y + scrollAreaBox!.height + 1);
        } finally {
            if (closedJornadaId !== null) {
                await pool.query(
                    'UPDATE jornada SET status = $1, "closedAt" = NULL WHERE id = $2',
                    ["OPEN", closedJornadaId]
                );
            }
            if (saleIds.length) {
                await pool.query('DELETE FROM debtors WHERE "saleID" = ANY($1::int[])', [saleIds]);
                await pool.query("DELETE FROM sales WHERE id = ANY($1::int[])", [saleIds]);
            }
            if (customerIds.length) {
                await pool.query("DELETE FROM customer WHERE id = ANY($1::int[])", [customerIds]);
            }
            await pool.end();
        }
    });

    test("MobilePagination page selector dialog stays bounded and scrollable on short viewports", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 130 }, (_, i) => `R2Dlg Prod ${String(i + 1).padStart(3, "0")}`);

        try {
            await pool.query(
                'INSERT INTO products (name, "priceCents") SELECT name, 1000 FROM unnest($1::text[]) AS name',
                [names]
            );

            await page.setViewportSize({ width: 360, height: 200 });
            await page.goto("/admin/menu");

            const nav = page.locator("main div.md\\:hidden").getByRole("navigation", { name: "Paginación de productos" });
            await expect(nav).toBeVisible({ timeout: 15_000 });
            await nav.getByRole("button", { name: /Seleccionar página/ }).click();

            const dialog = page.getByRole("dialog", { name: "Ir a página" });
            await expect(dialog).toBeVisible();

            const dlgBox = await dialog.boundingBox();
            const titleBox = await dialog.getByRole("heading", { name: "Ir a página" }).boundingBox();
            expect(dlgBox).not.toBeNull();
            expect(titleBox).not.toBeNull();

            // Dialog and its header must stay within the short viewport rather than overflowing off-screen
            expect(dlgBox!.y).toBeGreaterThanOrEqual(0);
            expect(dlgBox!.y + dlgBox!.height).toBeLessThanOrEqual(200);
            expect(titleBox!.y).toBeGreaterThanOrEqual(0);
        } finally {
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });
});
