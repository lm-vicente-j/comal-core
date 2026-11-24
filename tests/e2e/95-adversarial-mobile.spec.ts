import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

test.describe("Mobile UX adversarial checks", () => {
    test("MobilePagination jump input rejects decimals and scientific notation instead of misparsing or mismatching form validation", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 125 }, (_, i) => `Adv Jump Prod ${String(i + 1).padStart(3, "0")}`);

        try {
            await pool.query(
                'INSERT INTO products (name, "priceCents") SELECT name, 1000 FROM unnest($1::text[]) AS name',
                [names]
            );

            await page.setViewportSize({ width: 360, height: 640 });
            await page.goto("/admin/menu");

            const nav = page.getByRole("navigation", { name: "Paginación de productos" });
            await expect(nav).toBeVisible({ timeout: 15_000 });

            // Advance to page 2 so navigating to page 1 vs page 10 is distinguishable
            await nav.getByRole("button", { name: "Página siguiente" }).click();
            await expect(nav).toContainText("Página 2 de", { timeout: 15_000 });

            await nav.getByRole("button", { name: /Seleccionar página/ }).click();
            const dialog = page.getByRole("dialog", { name: "Ir a página" });
            await expect(dialog).toBeVisible();

            const jumpInput = dialog.getByLabel("Número de página");
            const goButton = dialog.getByRole("button", { name: "Ir", exact: true });

            // Decimal input must disable the submit button instead of enabling it while native step=1 validation blocks submit
            await jumpInput.fill("2.5");
            await expect(goButton).toBeDisabled();

            // Out-of-range scientific notation must disable the submit button
            await jumpInput.fill("1e2");
            await expect(goButton).toBeDisabled();

            // Scientific notation "1e1" must either be rejected (disabled) or navigate to page 10, never truncate to page 1
            await jumpInput.fill("1e1");
            if (await goButton.isEnabled()) {
                await goButton.click();
                await expect(dialog).toHaveCount(0);
                await expect(nav).toContainText("Página 10 de");
            } else {
                await expect(goButton).toBeDisabled();
            }
        } finally {
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });

    test("DebtorsTable keeps DataPagination visible within the viewport on short md..lg tablet screens", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
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

            for (let i = 1; i <= 12; i++) {
                const c = (await pool.query<{ id: number }>(
                    'INSERT INTO customer ("customerName", "currentBalanceCents", "registeredDate") VALUES ($1, 1000, CURRENT_DATE) RETURNING id',
                    [`Adv Tablet Debtor ${String(i).padStart(2, "0")}`]
                )).rows[0];
                customerIds.push(c.id);

                const s = (await pool.query<{ id: number }>(
                    'INSERT INTO sales ("totalCents", source_type, "customerID", "placedBy", status) VALUES (1000, $1, $2, $3, $4) RETURNING id',
                    [`CL- Adv`, c.id, admin.id, "DEBT"]
                )).rows[0];
                saleIds.push(s.id);

                await pool.query(
                    'INSERT INTO debtors ("saleID", "customerID", "amountCents", status, "createdJornadaId") VALUES ($1, $2, 1000, $3, $4)',
                    [s.id, c.id, "DEBT", jornada.id]
                );
            }

            // Short tablet viewport (md <= 800 < lg)
            await page.setViewportSize({ width: 800, height: 600 });
            await page.goto("/debtors");

            const nextLink = page.locator("div.hidden.md\\:flex").getByRole("link", { name: "Go to next page" });
            const paginationContainer = page.locator("div.hidden.md\\:flex").filter({ hasText: /Mostrando/ });
            await expect(paginationContainer).toBeAttached({ timeout: 15_000 });

            const paginationBox = await paginationContainer.boundingBox();
            const tableWrapperBox = await paginationContainer.locator("..").boundingBox();
            expect(paginationBox).not.toBeNull();
            expect(tableWrapperBox).not.toBeNull();

            // Pagination controls must not be clipped below the overflow-hidden DebtorsTable container or viewport
            expect(paginationBox!.y + paginationBox!.height).toBeLessThanOrEqual(
                tableWrapperBox!.y + tableWrapperBox!.height + 1
            );
            expect(paginationBox!.y + paginationBox!.height).toBeLessThanOrEqual(600);
            await expect(nextLink).toBeInViewport({ ratio: 1 });
        } finally {
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

    test("usePaginatedResource syncs clamped page after deletions so invalidate does not flash a phantom page in MobilePagination", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 21 }, (_, i) => `ZZ Adv Phantom ${String(i + 1).padStart(2, "0")}`);

        try {
            await pool.query(
                'INSERT INTO products (name, "priceCents") SELECT name, 2500 FROM unnest($1::text[]) AS name',
                [names]
            );

            await page.setViewportSize({ width: 360, height: 640 });
            await page.goto("/admin/menu");

            const nav = page.getByRole("navigation", { name: "Paginación de productos" });
            await expect(nav).toContainText("Página 1 de 3", { timeout: 15_000 });

            await nav.getByRole("button", { name: "Página siguiente" }).click();
            await expect(nav).toContainText("Página 2 de 3", { timeout: 15_000 });
            await nav.getByRole("button", { name: "Página siguiente" }).click();
            await expect(nav).toContainText("Página 3 de 3", { timeout: 15_000 });

            // Shrink total items so page 3 no longer exists (total drops to 21 + 2 seed - 4 = 19 -> 2 pages)
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names.slice(0, 4)]);

            // Wait for AutoRefresh (10s) to refetch page 3 and receive clamped page 2
            await expect(nav).toContainText("Página 2 de 2", { timeout: 20_000 });

            // Delay the post-save getProductPage reload to observe the intermediate loading state
            await page.route("**/admin/menu", async (route) => {
                const req = route.request();
                if (req.method() === "POST" && /"page":\s*3\b/.test(req.postData() ?? "")) {
                    await new Promise((r) => setTimeout(r, 500));
                }
                await route.continue();
            });

            // Observe every text change in MobilePagination while editing and saving an item on page 2
            await page.evaluate(() => {
                const target = document.querySelector('nav[aria-label="Paginación de productos"]');
                const texts: string[] = [];
                (window as unknown as { __observedNavTexts: string[] }).__observedNavTexts = texts;
                if (!target) return;
                const observer = new MutationObserver(() => {
                    texts.push(target.textContent ?? "");
                });
                observer.observe(target, { childList: true, subtree: true, characterData: true });
            });

            const editButton = page.locator("main div.md\\:hidden .bg-white.p-4").first().getByRole("button");
            await editButton.click();
            const dialog = page.getByRole("dialog");
            await expect(dialog).toBeVisible();
            await dialog.locator('input[name="price"]').fill("30");
            await dialog.getByRole("button", { name: "Actualizar" }).click();
            await expect(dialog.getByText("Guardado exitosamente.")).toBeVisible({ timeout: 15_000 });

            const observed = await page.evaluate(
                () => (window as unknown as { __observedNavTexts: string[] }).__observedNavTexts
            );
            expect(observed.some((t) => /Página 3 de 3/.test(t))).toBe(false);
        } finally {
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });

    test("MobilePagination keeps previous-page navigation enabled when a forward page fetch fails", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 15 }, (_, i) => `ZZ Adv FailNav ${String(i + 1).padStart(2, "0")}`);

        try {
            await pool.query(
                'INSERT INTO products (name, "priceCents") SELECT name, 2500 FROM unnest($1::text[]) AS name',
                [names]
            );

            await page.setViewportSize({ width: 360, height: 640 });
            await page.goto("/admin/menu");

            const nav = page.getByRole("navigation", { name: "Paginación de productos" });
            await expect(nav).toContainText("Página 1 de 2", { timeout: 15_000 });

            await page.route("**/admin/menu", async (route) => {
                const req = route.request();
                if (req.method() === "POST" && /"page":\s*2\b/.test(req.postData() ?? "")) {
                    await route.fulfill({ status: 503, body: "Service unavailable" });
                    return;
                }
                await route.continue();
            });

            await nav.getByRole("button", { name: "Página siguiente" }).click();
            await expect(nav).toContainText("Página 2 de 2", { timeout: 15_000 });

            // A failed load is explicit and the previous page remains reachable.
            await expect(page.getByRole("alert").filter({ hasText: "No se pudieron cargar los registros. Intenta de nuevo." })).toBeVisible();
            await expect(nav.getByRole("button", { name: "Página anterior" })).toBeEnabled();
            await nav.getByRole("button", { name: "Página anterior" }).click();
            await expect(nav).toContainText("Página 1 de 2");
        } finally {
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });

    test("POS displays an on-screen status banner on mobile and tablet viewports when no jornada is open", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        let closedJornadaId: number | null = null;

        try {
            const openRow = (await pool.query<{ id: number }>(
                'SELECT id FROM jornada WHERE status = $1 ORDER BY id DESC LIMIT 1',
                ["OPEN"]
            )).rows[0];
            if (openRow) {
                closedJornadaId = openRow.id;
                await pool.query(
                    'UPDATE jornada SET status = $1, "closedAt" = NOW() WHERE id = $2',
                    ["CLOSED", closedJornadaId]
                );
            }

            for (const viewport of [{ width: 360, height: 640 }, { width: 768, height: 1024 }]) {
                await page.setViewportSize(viewport);
                await page.goto("/pos");

                await expect(
                    page.getByText(/No hay jornada activa/i).filter({ visible: true })
                ).toBeVisible({ timeout: 15_000 });
            }
        } finally {
            if (closedJornadaId !== null) {
                await pool.query(
                    'UPDATE jornada SET status = $1, "closedAt" = NULL WHERE id = $2',
                    ["OPEN", closedJornadaId]
                );
            }
            await pool.end();
        }
    });
});
