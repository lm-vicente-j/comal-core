import { test, expect } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

test.describe("Mobile UX adversarial checks (Round 3)", () => {
    test("DebtorsTable fits at least one full mobile debtor row inside ScrollArea on 320x480 when MobilePagination and JornadaBanner are visible", async ({ page }) => {
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

            for (let i = 1; i <= 12; i++) {
                const c = (await pool.query<{ id: number }>(
                    'INSERT INTO customer ("customerName", "alias", "currentBalanceCents", "registeredDate") VALUES ($1, $2, 1000, CURRENT_DATE) RETURNING id',
                    [`R3 Debtor Name ${String(i).padStart(2, "0")}`, `Alias ${i}`]
                )).rows[0];
                customerIds.push(c.id);

                const s = (await pool.query<{ id: number }>(
                    'INSERT INTO sales ("totalCents", source_type, "customerID", "placedBy", status) VALUES (1000, $1, $2, $3, $4) RETURNING id',
                    [`CL-R3-${i}`, c.id, admin.id, "DEBT"]
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

            const nav = page.getByRole("navigation", { name: "Paginación de deudores" });
            await expect(nav).toBeVisible({ timeout: 15_000 });

            const scrollArea = page.locator('[data-slot="scroll-area"]');
            const scrollAreaBox = await scrollArea.boundingBox();
            const firstRowBox = await scrollArea.locator("tbody tr").first().boundingBox();
            expect(scrollAreaBox).not.toBeNull();
            expect(firstRowBox).not.toBeNull();

            // At least one full mobile debtor row (below the 40px header) must fit inside ScrollArea
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

    test("MobilePosManager preserves chip row bounds and at least one product card height on short viewports", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        let originalOpenedBy: number | null = null;
        let openJornadaId: number | null = null;
        let otherOperatorId: number | null = null;

        try {
            const openRow = (await pool.query<{ id: number; openedBy: number }>(
                'SELECT id, "openedBy" FROM jornada WHERE status = $1 ORDER BY id DESC LIMIT 1',
                ["OPEN"]
            )).rows[0];
            expect(openRow).toBeTruthy();
            openJornadaId = openRow.id;
            originalOpenedBy = openRow.openedBy;

            const other = (await pool.query<{ id: number }>(
                "INSERT INTO users (name, email, username, password, role, active) VALUES ($1, $2, $3, $4, 'SUPERVISOR', true) RETURNING id",
                ["Administrador Principal Turno", "other-r3@e2e.local", "OTHERR3", "x"]
            )).rows[0];
            otherOperatorId = other.id;

            await pool.query('UPDATE jornada SET "openedBy" = $1 WHERE id = $2', [otherOperatorId, openJornadaId]);

            await page.setViewportSize({ width: 320, height: 480 });
            await page.goto("/pos");

            const mobilePos = page.locator("main > div.overflow-y-auto > div.lg\\:hidden");
            await mobilePos.getByRole("button", { name: "Mesas", exact: true }).click();
            await mobilePos.getByRole("button", { name: "1", exact: true }).click();
            await expect(mobilePos.getByRole("button", { name: "Abrir cuenta" })).toBeVisible({ timeout: 15_000 });

            const metrics = await mobilePos.evaluate((root) => {
                const chipWrapper = root.querySelector("div.flex.h-14");
                const chipRow = chipWrapper?.firstElementChild;
                const grid = root.querySelector("div.min-h-0.flex-1.overflow-y-auto");
                return {
                    chipWrapperHeight: chipWrapper?.getBoundingClientRect().height ?? 0,
                    chipRowHeight: chipRow?.getBoundingClientRect().height ?? 0,
                    gridHeight: grid?.getBoundingClientRect().height ?? 0,
                };
            });

            await test.info().attach("chip-layout-metrics", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
            // Chip row must fit inside its short-screen container without overflowing
            expect(metrics.chipRowHeight).toBeLessThanOrEqual(metrics.chipWrapperHeight + 1);
            // Product grid must fit at least one 96px (min-h-24) product card
            expect(metrics.gridHeight).toBeGreaterThanOrEqual(96);
        } finally {
            if (openJornadaId !== null && originalOpenedBy !== null) {
                await pool.query('UPDATE jornada SET "openedBy" = $1 WHERE id = $2', [originalOpenedBy, openJornadaId]);
            }
            if (otherOperatorId !== null) {
                await pool.query("DELETE FROM users WHERE id = $1", [otherOperatorId]);
            }
            await pool.end();
        }
    });

    test("JornadaBanner wraps long unbroken admin names without horizontal overflow on 320px viewports", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        let originalOpenedBy: number | null = null;
        let openJornadaId: number | null = null;
        let otherOperatorId: number | null = null;

        try {
            const openRow = (await pool.query<{ id: number; openedBy: number }>(
                'SELECT id, "openedBy" FROM jornada WHERE status = $1 ORDER BY id DESC LIMIT 1',
                ["OPEN"]
            )).rows[0];
            expect(openRow).toBeTruthy();
            openJornadaId = openRow.id;
            originalOpenedBy = openRow.openedBy;

            const other = (await pool.query<{ id: number }>(
                "INSERT INTO users (name, email, username, password, role, active) VALUES ($1, $2, $3, $4, 'SUPERVISOR', true) RETURNING id",
                ["A".repeat(50), "long-r3@e2e.local", "LONGR3", "x"]
            )).rows[0];
            otherOperatorId = other.id;

            await pool.query('UPDATE jornada SET "openedBy" = $1 WHERE id = $2', [otherOperatorId, openJornadaId]);

            await page.setViewportSize({ width: 320, height: 480 });
            await page.goto("/pos");

            const bannerOverflow = await page.evaluate(() => {
                const link = Array.from(document.querySelectorAll("a")).find((a) =>
                    a.textContent?.includes("Cerrar y abrir nueva")
                );
                const banner = link?.parentElement;
                return {
                    scrollWidth: banner?.scrollWidth ?? 0,
                    clientWidth: banner?.clientWidth ?? 0,
                };
            });
            expect(bannerOverflow.scrollWidth).toBeLessThanOrEqual(bannerOverflow.clientWidth + 1);

            await page.getByRole("button", { name: "Menú de usuario" }).click();
            const menu = page.getByRole("menu");
            await expect(menu).toBeVisible();
            const menuOverflow = await menu.evaluate((el) => ({
                scrollWidth: el.scrollWidth,
                clientWidth: el.clientWidth,
            }));
            await test.info().attach("operator-menu-metrics", { body: JSON.stringify(menuOverflow, null, 2), contentType: "application/json" });
            expect(menuOverflow.scrollWidth).toBeLessThanOrEqual(menuOverflow.clientWidth + 1);
        } finally {
            if (openJornadaId !== null && originalOpenedBy !== null) {
                await pool.query('UPDATE jornada SET "openedBy" = $1 WHERE id = $2', [originalOpenedBy, openJornadaId]);
            }
            if (otherOperatorId !== null) {
                await pool.query("DELETE FROM users WHERE id = $1", [otherOperatorId]);
            }
            await pool.end();
        }
    });

    test("MobilePagination closes its page selector state when totalPages drops to 1 and does not reopen unprompted", async ({ page }) => {
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const names = Array.from({ length: 11 }, (_, i) => `R3StaleDlg Prod ${String(i + 1).padStart(2, "0")}`);

        try {
            await pool.query(
                'INSERT INTO products (name, "priceCents") SELECT name, 1500 FROM unnest($1::text[]) AS name',
                [names]
            );

            await page.setViewportSize({ width: 360, height: 640 });
            await page.goto("/admin/menu");

            const mobileMenu = page.locator("main div.md\\:hidden");
            const nav = mobileMenu.getByRole("navigation", { name: "Paginación de productos" });
            await mobileMenu.getByPlaceholder("Buscar producto...").fill("R3StaleDlg Prod");
            await expect(nav).toContainText("Página 1 de 2", { timeout: 15_000 });

            await nav.getByRole("button", { name: /Seleccionar página/ }).click();
            const dialog = page.getByRole("dialog", { name: "Ir a página" });
            await expect(dialog).toBeVisible();

            // Shrink total items to <= 10 so MobilePagination unmounts on AutoRefresh
            const totalCount = Number((await pool.query<{ c: number }>("SELECT count(*)::int AS c FROM products WHERE name = ANY($1::text[])", [names])).rows[0].c);
            const toRemove = names.slice(0, totalCount - 10);
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [toRemove]);
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await expect(nav).toHaveCount(0, { timeout: 15_000 });

            // Body must not be left with pointer-events: none after the modal pagination unmounts
            await expect.poll(() => page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none");

            // Restore total items >= 11 so MobilePagination remounts; the dialog must stay closed
            await pool.query(
                'INSERT INTO products (name, "priceCents") SELECT name, 1500 FROM unnest($1::text[]) AS name',
                [toRemove]
            );
            await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
            await expect(nav).toContainText("Página 1 de 2", { timeout: 15_000 });
            await expect(dialog).toHaveCount(0);
        } finally {
            await pool.query("DELETE FROM products WHERE name = ANY($1::text[])", [names]);
            await pool.end();
        }
    });
});
