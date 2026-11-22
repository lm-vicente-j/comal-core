import { test, expect, type Page, type Request } from "@playwright/test";
import { Pool } from "pg";
import { E2E_DATABASE_URL } from "../../playwright.config";

// Every sale now lands in an account and waits there as UNPAID until it is
// charged, so each test settles what it opens: an unpaid leftover would make
// 90-jornada.spec.ts fail to close the shared jornada (OPEN_ACCOUNTS).
//
// The order list shows only the selected account: once the account is
// charged the list goes back to empty, so a settled sale never keeps showing
// its products as if it were still open. Wait for the account total and
// for the product buttons to finish their pending sale before the next tap;
// the optimistic total can appear before the "one sale in flight" guard clears.
//
// The suite runs in both projects. The desktop POS keeps the open account in
// the order table and charges every account kind from "Cerrar cuenta"; the
// mobile POS keeps it in a bottom sheet that opens from the account bar
// ("Abrir cuenta") and charges from the sheet's "Cobrar $…" button. The
// helpers below branch on the project so each test asserts the same behavior
// on both layouts.
test.describe("pos", () => {
    // Desktop: rows of the order table. Mobile: lines of the account sheet.
    const accountLines = (page: Page, isMobile: boolean) =>
        isMobile
            ? page.getByRole("dialog").getByRole("listitem")
            : page.locator("tbody tr");

    // Ticket chips read "#1 $25.00": number plus running total.
    const ticketChip = (page: Page, total: string) =>
        page.getByRole("button", { name: new RegExp(`^#\\d+\\s*\\$${total}$`) });

    // Asserts the running total of the walk-in ticket being served. Desktop
    // shows it on the selected ticket chip ("#1 $25.00"); mobile shows it on
    // the account bar (labelled "Abrir cuenta").
    const expectTicketTotal = async (page: Page, isMobile: boolean, total: string) => {
        if (isMobile) {
            await expect(page.getByRole("button", { name: "Abrir cuenta" }))
                .toContainText(`$${total}`, { timeout: 15_000 });
            await expect(page.getByRole("button", { name: "Abrir cuenta" }))
                .toBeEnabled({ timeout: 15_000 });
        } else {
            await expect(ticketChip(page, total.replace(".", "\\."))).toBeVisible({ timeout: 15_000 });
            await expect(page.getByRole("button", { name: /Cerrar cuenta/ }))
                .toBeEnabled({ timeout: 15_000 });
        }
        await expect(page.getByRole("button", { name: /Taco Pastor|Quesadilla Grande/ })
            .and(page.locator(":disabled"))).toHaveCount(0, { timeout: 15_000 });
    };

    const openAccountSheet = async (page: Page) => {
        await page.getByRole("button", { name: "Abrir cuenta" }).click();
    };

    const openCashDialog = async (page: Page) => {
        const sheet = page.getByRole("dialog", { name: /^Cuenta/ });
        await sheet.getByRole("button", { name: /^Cobrar \$/ }).click();
        const cashDialog = page.getByRole("dialog", { name: "Cobrar en efectivo", exact: true });
        await expect(cashDialog).toBeVisible();
        await expect(sheet).toHaveCount(0);
        return cashDialog;
    };

    const closeSheet = async (page: Page) => {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
    };

    // Charges whatever account is open. Desktop goes through the shared
    // "Cerrar cuenta" dialog (tables, walk-ins and customers alike); mobile
    // opens the account sheet, then confirms cash in its required-amount dialog.
    const chargeAccount = async (page: Page, isMobile: boolean, total: string) => {
        if (isMobile) {
            const cashDialog = page.getByRole("dialog", { name: "Cobrar en efectivo", exact: true });
            if ((await cashDialog.count()) === 0) {
                if ((await page.getByRole("dialog").count()) === 0) await openAccountSheet(page);
                const sheet = page.getByRole("dialog", { name: /^Cuenta/ });
                await expect(sheet).toContainText(total);
                const isCash = await sheet.getByRole("button", { name: "Efectivo", exact: true }).getAttribute("aria-pressed") === "true";
                await sheet.getByRole("button", { name: /^Cobrar \$/ }).click();
                if (isCash) await expect(cashDialog).toBeVisible();
            }
            if ((await cashDialog.count()) > 0) {
                await cashDialog.getByLabel("Efectivo recibido", { exact: true }).fill(total.replace("$", ""));
                await cashDialog.getByRole("button", { name: /^Cobrar \$/ }).click();
            }
            const transfer = page.getByRole("dialog", { name: "Confirmar transferencia recibida", exact: true });
            if ((await transfer.count()) > 0) {
                await transfer.getByRole("button", { name: "Confirmar transferencia recibida", exact: true }).click();
            }
            await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
        } else {
            await page.getByRole("button", { name: /Cerrar cuenta/ }).click();
            await expect(page.getByRole("dialog")).toContainText(total);
            await page.getByRole("button", { name: "Confirmar y Cerrar" }).click();
            // The desktop dialog closes immediately; wait for the async
            // settlement to clear the selection before choosing another ticket.
            await expect(page.getByRole("button", { name: /Cerrar cuenta/ })).toBeDisabled({ timeout: 15_000 });
            await expect(accountLines(page, false)).toHaveCount(0, { timeout: 15_000 });
        }
    };

    test.beforeEach(async ({ page }) => {
        // createSale surfaces failures via alert(); never leave one hanging.
        page.on("dialog", (d) => d.dismiss().catch(() => {}));
        await page.goto("/pos");
    });


    for (const account of ["ticket", "table", "customer", "no-clabe"]) {
        test("requires received-transfer confirmation for " + account, async ({ page }) => {
            test.setTimeout(120_000);
            const isMobile = test.info().project.name === "mobile";
            if (isMobile) await page.setViewportSize({ width: 320, height: 480 });
            const pool = new Pool({ connectionString: E2E_DATABASE_URL });
            const previous = (await pool.query<{ value: string | null }>("SELECT value FROM setting WHERE key = $1", ["CLABE"])).rows[0];
            const clabe = account === "no-clabe" ? "" : "123456789012345678";
            try {
                await pool.query('INSERT INTO setting (key, value, "updatedAt") VALUES ($1, $2, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', ["CLABE", clabe]);
                if (account === "table") {
                    if (isMobile) await page.getByRole("button", { name: "Mesas", exact: true }).click();
                    await page.getByRole("button", { name: "9", exact: true }).click();
                } else if (account === "customer") {
                    if (isMobile) await page.getByRole("button", { name: "Cliente", exact: true }).click();
                    await page.getByRole("combobox").filter({ hasText: "Nombre de cliente" }).click();
                    await page.getByRole("option", { name: /Cliente Uno E2E/ }).click();
                }
                const lastId = (await pool.query<{ id: number }>("SELECT COALESCE(MAX(id), 0) AS id FROM sales")).rows[0].id;
                await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
                await expect(page.getByRole("button", { name: /Taco Pastor/ }).first()).toBeEnabled();
                if (isMobile) await openAccountSheet(page);
                else await page.getByRole("button", { name: /Cerrar cuenta/ }).click();
                const summary = page.getByRole("dialog", { name: isMobile ? /^Cuenta/ : /^Pago de cuenta/ });
                await expect(summary).toContainText("$25.00");
                const sale = (await pool.query<{ id: number; source_type: string }>("SELECT id, source_type FROM sales WHERE id > $1 ORDER BY id LIMIT 1", [lastId])).rows[0];
                const payments: Request[] = [];
                page.on("request", request => {
                    if (request.method() === "POST" && request.headers()["next-action"] && request.postData()?.includes('"TRANSFER"') && request.postData()?.includes(sale.source_type)) payments.push(request);
                });
                await summary.getByRole("button", { name: "Transferencia", exact: true }).click();
                const start = summary.getByRole("button", { name: isMobile ? /^Cobrar \$/ : "Confirmar y Cerrar", exact: !isMobile });
                await start.click();
                const transfer = page.getByRole("dialog", { name: "Confirmar transferencia recibida", exact: true });
                const confirm = transfer.getByRole("button", { name: "Confirmar transferencia recibida", exact: true });
                await expect(transfer).toBeVisible();
                if (clabe) await expect(transfer.getByLabel("CLABE de transferencia", { exact: true })).toHaveText("1234 5678 9012 3456 78");
                else await expect(transfer.getByRole("status")).toHaveText("No hay una CLABE configurada.");
                await expect(transfer).toContainText("$25.00");
                await expect(confirm).toBeEnabled();
                await expect(confirm).toBeInViewport({ ratio: 1 });
                await expect(transfer.getByRole("button", { name: "Cancelar", exact: true })).toBeInViewport({ ratio: 1 });
                await expect(page.getByLabel("Efectivo recibido", { exact: true })).toHaveCount(0);
                expect(payments).toHaveLength(0);
                expect((await pool.query<{ status: string }>("SELECT status FROM sales WHERE id = $1", [sale.id])).rows[0].status).toBe("UNPAID");
                if (account === "ticket" || account === "no-clabe") {
                    const screenshot = test.info().outputPath("transfer-" + account + ".png");
                    await page.screenshot({ path: screenshot, animations: "disabled" });
                    await test.info().attach("transfer-" + account, { path: screenshot, contentType: "image/png" });
                }
                await transfer.getByRole("button", { name: "Cancelar", exact: true }).click();
                await expect(summary).toBeVisible();
                expect(payments).toHaveLength(0);
                expect((await pool.query<{ status: string }>("SELECT status FROM sales WHERE id = $1", [sale.id])).rows[0].status).toBe("UNPAID");
                if (clabe) await pool.query("UPDATE setting SET value = $1 WHERE key = $2", ["876543210987654321", "CLABE"]);
                await start.click();
                if (clabe) await expect(transfer.getByLabel("CLABE de transferencia", { exact: true })).toHaveText("8765 4321 0987 6543 21");
                else await expect(transfer.getByRole("status")).toHaveText("No hay una CLABE configurada.");
                await confirm.click();
                await expect(transfer).toHaveCount(0, { timeout: 30_000 });
                if (isMobile) await expect(page.getByRole("button", { name: "Abrir cuenta" })).toHaveCount(0);
                else await expect(page.getByRole("button", { name: /Cerrar cuenta/ })).toBeDisabled();
                expect(payments).toHaveLength(1);
                expect(payments[0].postData()).not.toContain("clabe");
                const paid = (await pool.query<{ status: string; payment_method: string }>("SELECT status, payment_method FROM sales WHERE id = $1", [sale.id])).rows[0];
                expect(paid.status).toBe("PAID");
                expect(paid.payment_method).toBe("TRANSFER");
            } finally {
                if (previous) await pool.query("UPDATE setting SET value = $1 WHERE key = $2", [previous.value, "CLABE"]);
                else await pool.query("DELETE FROM setting WHERE key = $1", ["CLABE"]);
                await pool.end();
            }
        });
    }

    test("keeps the original transfer receipt after the ticket was closed elsewhere", async ({ page }) => {
        test.skip(test.info().project.name !== "desktop", "Desktop receipt state");
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        try {
            const [{ id: previousSaleId }] = (await pool.query<{ id: number }>(
                "SELECT COALESCE(MAX(id), 0) AS id FROM sales",
            )).rows;
            await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
            await page.getByRole("button", { name: /Cerrar cuenta/ }).click();
            const summary = page.getByRole("dialog", { name: /^Pago de cuenta/ });
            await summary.getByRole("button", { name: "Transferencia", exact: true }).click();
            await summary.getByRole("button", { name: "Confirmar y Cerrar" }).click();
            const transfer = page.getByRole("dialog", { name: "Confirmar transferencia recibida", exact: true });
            const confirm = transfer.getByRole("button", { name: "Confirmar transferencia recibida", exact: true });
            await expect(confirm).toBeEnabled();

            const [{ id: saleId }] = (await pool.query<{ id: number }>(
                "SELECT id FROM sales WHERE id > $1 AND status = 'UNPAID' ORDER BY id LIMIT 1",
                [previousSaleId],
            )).rows;
            await pool.query(
                "UPDATE sales SET status = 'PAID', payment_method = 'CASH', source_type = 'VENTA_LIBRE' WHERE id = $1",
                [saleId],
            );
            await expect(page.locator("tbody tr")).toHaveCount(0, { timeout: 20_000 });
            await expect(transfer).toContainText(/de Venta libre #\d+/);
            await expect(transfer).toContainText("$25.00");
            await confirm.click();
            await expect(transfer.getByRole("alert")).toContainText("La cuenta cambió");
        } finally {
            await pool.end();
        }
    });

    test("updates the open Cerrar cuenta dialog when another terminal adds an item to the same table", async ({ page, context }) => {
        test.skip(test.info().project.name !== "desktop", "Desktop Cerrar cuenta dialog");
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const terminalB = await context.newPage();
        terminalB.on("dialog", (d) => d.dismiss().catch(() => {}));
        let previousSaleId = 0;
        try {
            previousSaleId = (await pool.query<{ id: number }>(
                "SELECT COALESCE(MAX(id), 0) AS id FROM sales",
            )).rows[0].id;

            // Terminal A selects Mesa 4, adds Taco Pastor ($25), and opens Cerrar cuenta.
            await page.getByRole("button", { name: "4", exact: true }).click();
            await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
            await expect(page.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 });
            await expect(page.getByRole("button", { name: /Cerrar cuenta/ })).toBeEnabled({ timeout: 15_000 });
            await page.getByRole("button", { name: /Cerrar cuenta/ }).click();

            const summary = page.getByRole("dialog", { name: /^Pago de cuenta Mesa 4$/ });
            await expect(summary).toBeVisible();
            await expect(summary).toContainText("Taco Pastor");
            await expect(summary).toContainText("$25.00");
            await summary.getByLabel("Efectivo recibido", { exact: true }).fill("100");
            await expect(summary.locator("#desktop-cash-change")).toContainText("$75.00");

            // Terminal B opens the same table and adds Quesadilla Grande ($35).
            await terminalB.goto("/pos");
            await terminalB.getByRole("button", { name: "4", exact: true }).click();
            await expect(terminalB.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 });
            await terminalB.getByRole("button", { name: /Quesadilla Grande/ }).first().click();
            await expect(terminalB.locator("tbody tr")).toHaveCount(2, { timeout: 15_000 });
            await expect(terminalB.getByRole("button", { name: /Cerrar cuenta/ })).toBeEnabled({ timeout: 15_000 });

            // Wait for Terminal A's AutoRefresh to update the order table behind the dialog.
            await expect(page.locator("tbody tr")).toHaveCount(2, { timeout: 20_000 });

            // The already-open Cerrar cuenta dialog must reflect the new product, updated total, and updated change.
            await expect(summary).toContainText("Quesadilla Grande", { timeout: 3_000 });
            await expect(summary).toContainText("$60.00", { timeout: 3_000 });
            await expect(summary.locator("#desktop-cash-change")).toContainText("$40.00", { timeout: 3_000 });

            // Confirming closes both items matching the updated $60.00 total.
            await summary.getByRole("button", { name: "Confirmar y Cerrar" }).click();
            await expect(summary).toHaveCount(0, { timeout: 15_000 });
            await expect(page.getByRole("button", { name: /Cerrar cuenta/ })).toBeDisabled({ timeout: 15_000 });

            const sales = (await pool.query<{ status: string; totalCents: string }>(
                'SELECT status, "totalCents" FROM sales WHERE id > $1 AND source_type = \'MESA_4\' ORDER BY id',
                [previousSaleId],
            )).rows;
            expect(sales).toHaveLength(2);
            expect(sales.every((s) => s.status === "PAID")).toBe(true);
            expect(sales.reduce((sum, s) => sum + Number(s.totalCents), 0)).toBe(6000);
        } finally {
            await terminalB.close().catch(() => {});
            await pool.query(
                "UPDATE sales SET status = 'CANCELLED' WHERE id > $1 AND source_type = 'MESA_4' AND status = 'UNPAID'",
                [previousSaleId],
            ).catch(() => {});
            await pool.end();
        }
    });

    test("a free sale opens a walk-in ticket and is charged from it", async ({ page }) => {
        const isMobile = test.info().project.name === "mobile";

        // No table and no customer selected: the tap opens a ticket by itself.
        await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
        await expectTicketTotal(page, isMobile, "25.00");

        if (isMobile) await openAccountSheet(page);
        await expect(accountLines(page, isMobile)).toHaveCount(1);

        await chargeAccount(page, isMobile, "$25.00");

        // Settled: no open ticket left, and the order list is clean again —
        // nothing of the charged ticket keeps showing as an open sale.
        await expect(ticketChip(page, "25\\.00")).toHaveCount(0, { timeout: 15_000 });
        if (isMobile) {
            // The bottom bar falls back to the jornada summary once nothing
            // is selected anymore.
            await expect(page.getByRole("button", { name: "Ver resumen de jornada" })).toBeVisible({ timeout: 15_000 });
        } else {
            await expect(accountLines(page, false)).toHaveCount(0, { timeout: 15_000 });
        }
    });

    test("a walk-in ticket adds up several products before charging", async ({ page }) => {
        const isMobile = test.info().project.name === "mobile";

        await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
        await expectTicketTotal(page, isMobile, "25.00");

        // 25 + 35: the running sum the walk-in customer has to pay, which the
        // free sale had no way of showing before.
        await page.getByRole("button", { name: /Quesadilla Grande/ }).first().click();
        await expectTicketTotal(page, isMobile, "60.00");

        if (isMobile) {
            await openAccountSheet(page);
            await expect(accountLines(page, true)).toHaveCount(2);
        } else {
            await expect(accountLines(page, false)).toHaveCount(2);
        }

        await chargeAccount(page, isMobile, "$60.00");
        await expect(ticketChip(page, "60\\.00")).toHaveCount(0, { timeout: 15_000 });
    });

    test("keeps two walk-in tickets open at the same time", async ({ page }) => {
        const isMobile = test.info().project.name === "mobile";

        // First walk-in customer.
        await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
        await expectTicketTotal(page, isMobile, "25.00");
        const firstTicket = ticketChip(page, "25\\.00");

        // A second one starts ordering before the first has paid.
        await page.getByRole("button", { name: "Nuevo", exact: true }).click();
        await expect(ticketChip(page, "0\\.00")).toBeVisible({ timeout: 15_000 });

        if (isMobile) {
            await openAccountSheet(page);
            await expect(accountLines(page, true)).toHaveCount(0);
            await closeSheet(page);
        } else {
            await expect(accountLines(page, false)).toHaveCount(0);
        }

        await page.getByRole("button", { name: /Quesadilla Grande/ }).first().click();
        await expectTicketTotal(page, isMobile, "35.00");

        // Each ticket keeps its own total: the first one is untouched.
        if (isMobile) {
            await openAccountSheet(page);
            await expect(accountLines(page, true)).toHaveCount(1);
            await closeSheet(page);
        } else {
            await expect(accountLines(page, false)).toHaveCount(1);
        }
        await expect(firstTicket).toBeVisible();

        // Charging the second one doesn't settle the first.
        await chargeAccount(page, isMobile, "$35.00");
        await expect(firstTicket).toBeVisible({ timeout: 15_000 });

        // Back to the first customer, who now pays too.
        await firstTicket.click();
        await expectTicketTotal(page, isMobile, "25.00");
        await chargeAccount(page, isMobile, "$25.00");

        await expect(firstTicket).toHaveCount(0, { timeout: 15_000 });
    });

    test("the quantity buttons update the order line", async ({ page }) => {
        const isMobile = test.info().project.name === "mobile";

        await page.getByRole("button", { name: /Quesadilla Grande/ }).first().click();
        await expectTicketTotal(page, isMobile, "35.00");

        if (isMobile) {
            // Stepper buttons carry explicit labels on the phone; the line's
            // subtotal is what proves the update landed.
            await openAccountSheet(page);
            const line = page.getByRole("dialog").getByRole("listitem").first();
            await line.getByRole("button", { name: "Aumentar cantidad" }).click();
            await expect(line).toContainText("$70.00", { timeout: 15_000 });
            await line.getByRole("button", { name: "Reducir cantidad" }).click();
            await expect(line).toContainText("$35.00", { timeout: 15_000 });
        } else {
            // Buttons in the row: [0] plus, [1] minus, [2] cancel.
            const row = page.locator("tbody tr").first();
            await row.getByRole("button").nth(0).click();
            await expect(row.getByRole("cell", { name: "2", exact: true })).toBeVisible();

            await row.getByRole("button").nth(1).click();
            await expect(row.getByRole("cell", { name: "1", exact: true })).toBeVisible();
        }

        await chargeAccount(page, isMobile, "$35.00");
        await expect(ticketChip(page, "35\\.00")).toHaveCount(0, { timeout: 15_000 });
    });

    test("cancelling a sale removes it from the recent orders list", async ({ page }) => {
        const isMobile = test.info().project.name === "mobile";
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        try {
            const lastId = (await pool.query<{ id: number }>("SELECT COALESCE(MAX(id), 0) AS id FROM sales")).rows[0].id;
            await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
            await expectTicketTotal(page, isMobile, "25.00");
            const sale = (await pool.query<{ id: number }>("SELECT id FROM sales WHERE id > $1 ORDER BY id LIMIT 1", [lastId])).rows[0];
            const cancellation = page.waitForResponse(response =>
                response.request().method() === "POST" &&
                Boolean(response.request().headers()["next-action"]) &&
                response.request().postData() === JSON.stringify([sale.id]));

            if (isMobile) {
                await openAccountSheet(page);
                const lines = accountLines(page, true);
                await expect(lines).toHaveCount(1);
                await lines.first().getByRole("button", { name: "Eliminar línea" }).click();
            } else {
                const rows = accountLines(page, false);
                await expect(rows).toHaveCount(1);
                await rows.first().getByRole("button").nth(2).click();
            }

            // Wait for the persisted cancellation, not only the optimistic UI.
            await cancellation;
            await expect.poll(async () =>
                (await pool.query<{ status: string }>("SELECT status FROM sales WHERE id = $1", [sale.id])).rows[0].status
            ).toBe("CANCELLED");
            await expect(accountLines(page, isMobile)).toHaveCount(0, { timeout: 15_000 });
        } finally {
            await pool.end();
        }
    });

    test("closing a table returns to venta libre and clears its history", async ({ page }) => {
        const isMobile = test.info().project.name === "mobile";

        // On the phone the tables live behind their own tab.
        if (isMobile) await page.getByRole("button", { name: "Mesas", exact: true }).click();

        // A fresh table starts with an empty account view.
        await page.getByRole("button", { name: "3", exact: true }).click();
        if (isMobile) {
            await openAccountSheet(page);
            await expect(accountLines(page, true)).toHaveCount(0);
            await closeSheet(page);
        } else {
            await expect(accountLines(page, false)).toHaveCount(0);
        }

        // Order one product on the table: it shows as the open account.
        await page.getByRole("button", { name: /Quesadilla Grande/ }).first().click();
        if (isMobile) {
            await openAccountSheet(page);
            await expect(accountLines(page, true)).toHaveCount(1, { timeout: 15_000 });
        } else {
            await expect(accountLines(page, false)).toHaveCount(1, { timeout: 15_000 });
        }

        // Close the table (pay the account) through the same "Cerrar cuenta"
        // dialog as every other account kind.
        await chargeAccount(page, isMobile, "$35.00");

        // Reselecting the table shows a clean slate: its settled history is
        // gone from the POS, ready for the next customers.
        if (isMobile) await page.getByRole("button", { name: "Mesas", exact: true }).click();
        await page.getByRole("button", { name: "3", exact: true }).click();
        if (isMobile) {
            await openAccountSheet(page);
            await expect(accountLines(page, true)).toHaveCount(0, { timeout: 15_000 });
        } else {
            await expect(accountLines(page, false)).toHaveCount(0, { timeout: 15_000 });
        }
    });


    test("mobile cash requires clicking charge and Enter only dismisses the keyboard", async ({ page }) => {
        test.skip(test.info().project.name !== "mobile", "Mobile-only cash dialog");
        await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
        await expectTicketTotal(page, true, "25.00");
        await openAccountSheet(page);
        const cashDialog = await openCashDialog(page);
        const received = cashDialog.getByLabel("Efectivo recibido", { exact: true });
        const confirm = cashDialog.getByRole("button", { name: "Cobrar $25.00", exact: true });
        await expect(received).toHaveAttribute("enterkeyhint", "done");

        for (const value of ["25", "50"]) {
            await received.fill(value);
            await expect(received).toBeFocused();
            await expect(confirm).toBeEnabled();
            const unexpectedPost = page.waitForRequest(
                request => request.method() === "POST" && new URL(request.url()).pathname === "/pos",
                { timeout: 1_500 }
            ).then(() => true, () => false);
            await received.press("Enter");
            await expect(received).not.toBeFocused();
            expect(await unexpectedPost).toBe(false);
            await expect(cashDialog).toBeVisible();
            await expect(received).toHaveValue(value);
            await expect(confirm).toBeEnabled();
        }

        const chargeRequest = page.waitForRequest(
            request => request.method() === "POST" && new URL(request.url()).pathname === "/pos"
        );
        await confirm.click();
        await chargeRequest;
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
        await expect(page.getByRole("button", { name: "Ver resumen de jornada" })).toBeVisible();
    });

    test("mobile cash dialog requires a valid sufficient amount and accepts decimals", async ({ page }) => {
        test.skip(test.info().project.name !== "mobile", "Mobile-only cash dialog");
        const product = page.getByRole("button", { name: /Taco Pastor/ }).first();
        await product.click();
        await expectTicketTotal(page, true, "25.00");
        await openAccountSheet(page);

        const sheet = page.getByRole("dialog", { name: /^Cuenta/ });
        await expect(sheet.getByLabel("Efectivo recibido", { exact: true })).toHaveCount(0);
        const cashDialog = await openCashDialog(page);
        const received = cashDialog.getByLabel("Efectivo recibido", { exact: true });
        const change = cashDialog.locator("#mobile-cash-change");
        const confirm = cashDialog.getByRole("button", { name: /^Cobrar \$/ });
        await expect(received).toHaveAttribute("inputmode", "decimal");
        await expect(received).toHaveJSProperty("required", true);
        await expect(received).toBeFocused();
        await expect(received).toHaveValue("");
        for (const [value, result, canCharge] of [
            ["", "Cambio a entregar: —", false],
            ["25", "Cambio a entregar: $0.00", true],
            ["30", "Cambio a entregar: $5.00", true],
            ["24", "Faltan $1.00", false],
            ["25.05", "Cambio a entregar: $0.05", true],
            ["25,05", "Cambio a entregar: $0.05", true],
            ["25.1", "Cambio a entregar: $0.10", true],
            ["25,1", "Cambio a entregar: $0.10", true],
            ["0", "Faltan $25.00", false],
            [".50", "Faltan $24.50", false],
            [" ,50 ", "Faltan $24.50", false],
            ["   ", "Cambio a entregar: —", false],
        ] as const) {
            await received.fill(value);
            await expect(change).toHaveText(result);
            const insufficient = result.startsWith("Faltan");
            await expect(received).toHaveAttribute("aria-invalid", String(insufficient));
            if (insufficient) {
                await expect(cashDialog.getByRole("alert")).toHaveText("El monto recibido es menor al total del cobro. Ingresa un monto igual o mayor.");
                await expect(received).toHaveAttribute("aria-describedby", "mobile-cash-change mobile-cash-error");
            } else {
                await expect(cashDialog.getByRole("alert")).toHaveCount(0);
            }
            if (canCharge) await expect(confirm).toBeEnabled();
            else await expect(confirm).toBeDisabled();
        }

        for (const value of ["abc", "-1", "25.001", "25,001", "25,0.1", "1e3", "Infinity", "90071992547409.92"]) {
            await received.fill(value);
            await expect(received).toHaveAttribute("aria-invalid", "true");
            await expect(cashDialog.getByRole("alert")).toContainText("hasta dos decimales");
            await expect(change).toHaveText("Cambio a entregar: —");
            await expect(confirm).toBeDisabled();
        }
        await received.press("Enter");
        await expect(received).not.toBeFocused();
        await expect(cashDialog).toBeVisible();

        // Cancelling returns to the same account; its changed total is used
        // when the cash dialog is opened again.
        await received.fill("50.05");
        await page.keyboard.press("Escape");
        await expect(cashDialog).toHaveCount(0);
        await expect(sheet).toBeVisible();
        await expect(sheet.getByLabel("Efectivo recibido", { exact: true })).toHaveCount(0);
        await sheet.getByRole("button", { name: "Aumentar cantidad" }).click();
        await expect(sheet.getByRole("button", { name: "Cobrar $50.00", exact: true })).toBeVisible();
        await openCashDialog(page);
        await expect(received).toHaveValue("50.05");
        await expect(change).toHaveText("Cambio a entregar: $0.05");
        await confirm.click();
        await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });

        await expect(product).toBeEnabled();
        await product.click();
        await expectTicketTotal(page, true, "25.00");
        await openAccountSheet(page);
        await openCashDialog(page);
        await expect(received).toHaveValue("");
        await expect(change).toHaveText("Cambio a entregar: —");
        await expect(confirm).toBeDisabled();
        await chargeAccount(page, true, "$25.00");
    });

    for (const [value, result] of [["", "Cambio a entregar: —"], ["1", "Faltan $24.00"]]) {
        test(`mobile cash blocks charging when received is ${value === "" ? "empty" : "insufficient"}`, async ({ page }) => {
            test.skip(test.info().project.name !== "mobile", "Mobile-only cash dialog");
            await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
            await expectTicketTotal(page, true, "25.00");
            await openAccountSheet(page);
            const cashDialog = await openCashDialog(page);
            const received = cashDialog.getByLabel("Efectivo recibido", { exact: true });
            await received.fill(value);
            await expect(cashDialog.locator("#mobile-cash-change")).toHaveText(result);
            if (value === "") await expect(cashDialog.getByRole("alert")).toHaveCount(0);
            else await expect(cashDialog.getByRole("alert")).toHaveText("El monto recibido es menor al total del cobro. Ingresa un monto igual o mayor.");
            await expect(cashDialog.getByRole("button", { name: /^Cobrar \$/ })).toBeDisabled();
            await received.press("Enter");
            await expect(received).not.toBeFocused();
            await expect(cashDialog).toBeVisible();
            await received.fill("25");
            await expect(cashDialog.getByRole("alert")).toHaveCount(0);
            await expect(received).toHaveAttribute("aria-invalid", "false");
            await chargeAccount(page, true, "$25.00");
            await expect(page.getByRole("button", { name: "Ver resumen de jornada" })).toBeVisible();
        });
    }

    test("mobile cash resets on account and payment changes and transfers charge without the cash dialog", async ({ page }) => {
        test.skip(test.info().project.name !== "mobile", "Mobile-only cash dialog");
        await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
        await expectTicketTotal(page, true, "25.00");
        const firstTicket = ticketChip(page, "25\\.00");
        await openAccountSheet(page);
        const sheet = page.getByRole("dialog", { name: /^Cuenta/ });
        const cashDialog = await openCashDialog(page);
        const received = cashDialog.getByLabel("Efectivo recibido", { exact: true });
        const back = cashDialog.getByRole("button", { name: "Volver a la cuenta", exact: true });
        await received.fill("50");
        await back.click();
        await expect(cashDialog).toHaveCount(0);
        await expect(sheet).toBeVisible();
        await closeSheet(page);

        await page.getByRole("button", { name: "Nuevo", exact: true }).click();
        await expect(ticketChip(page, "0\\.00")).toBeVisible();
        await page.getByRole("button", { name: /Quesadilla Grande/ }).first().click();
        await expectTicketTotal(page, true, "35.00");
        const secondTicket = ticketChip(page, "35\\.00");
        await openAccountSheet(page);
        await openCashDialog(page);
        await expect(received).toHaveValue("");
        await received.fill("100");
        await back.click();
        await expect(sheet).toBeVisible();
        await sheet.getByRole("button", { name: "Transferencia", exact: true }).click();
        await expect(sheet.getByLabel("Efectivo recibido", { exact: true })).toHaveCount(0);
        await sheet.getByRole("button", { name: "Efectivo", exact: true }).click();
        await openCashDialog(page);
        await expect(received).toHaveValue("");
        await received.fill("100");
        await back.click();
        await expect(sheet).toBeVisible();
        await closeSheet(page);

        await firstTicket.click();
        await openAccountSheet(page);
        await openCashDialog(page);
        await expect(received).toHaveValue("");
        await chargeAccount(page, true, "$25.00");
        await secondTicket.click();
        await openAccountSheet(page);
        await openCashDialog(page);
        await expect(received).toHaveValue("");
        await back.click();
        await expect(sheet).toBeVisible();
        await sheet.getByRole("button", { name: "Transferencia", exact: true }).click();
        await chargeAccount(page, true, "$35.00");
        await expect(cashDialog).toHaveCount(0);
        await expect(secondTicket).toHaveCount(0);
    });

    for (const viewport of [{ width: 320, height: 480 }, { width: 360, height: 640 }]) {
        test(`mobile charging stays visible with a long account at ${viewport.width}x${viewport.height}`, async ({ page }) => {
            test.skip(test.info().project.name !== "mobile", "Mobile-only fixed charging controls");
            test.setTimeout(120_000);
            await page.setViewportSize(viewport);
            const capture = async (name: string) => {
                const path = test.info().outputPath(`${name}.png`);
                await page.screenshot({ path });
                await test.info().attach(name, { path, contentType: "image/png" });
            };
            const product = page.getByRole("button", { name: /Taco Pastor/ }).first();
            for (let i = 1; i <= 10; i++) {
                await expect(product).toBeEnabled();
                await product.click();
                await expectTicketTotal(page, true, (i * 25).toFixed(2));
            }

            const openAccount = page.getByRole("button", { name: "Abrir cuenta" });
            const charge = page.getByRole("button", { name: "Cobrar", exact: true });
            const nav = page.getByRole("navigation").filter({ has: page.getByRole("link", { name: "POS", exact: true }) });
            await expect(charge).toBeInViewport({ ratio: 1 });
            const barBox = await openAccount.locator("..").locator("..").boundingBox();
            const navBox = await nav.boundingBox();
            expect(barBox).not.toBeNull();
            expect(navBox).not.toBeNull();
            expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(navBox!.y);
            const catalog = product.locator("..").locator("..");
            await catalog.evaluate(element => { element.scrollTop = element.scrollHeight; });
            const catalogBox = await catalog.boundingBox();
            const productBox = await product.boundingBox();
            expect(catalogBox!.y + catalogBox!.height).toBeLessThanOrEqual(barBox!.y);
            expect(productBox!.y + productBox!.height).toBeLessThanOrEqual(catalogBox!.y + catalogBox!.height);
            await expect(product).toBeInViewport();
            await capture("catalog-and-fixed-charge");

            // The bottom bar still opens the summary, with no cash field.
            await charge.click();
            const sheet = page.getByRole("dialog", { name: /^Cuenta/ });
            const content = sheet.getByRole("region", { name: "Contenido de la cuenta" });
            const confirm = sheet.getByRole("button", { name: "Cobrar $250.00", exact: true });
            await expect(accountLines(page, true)).toHaveCount(10);
            await expect(confirm).toBeInViewport({ ratio: 1 });
            await expect(confirm).toBeEnabled();
            await expect(sheet.getByLabel("Efectivo recibido", { exact: true })).toHaveCount(0);
            await expect(content.getByText("Total", { exact: true })).toHaveCount(0);
            await expect(content.getByRole("button", { name: /^Cobrar \$/ })).toHaveCount(0);
            await expect(content.getByRole("button", { name: "Efectivo", exact: true })).toBeInViewport({ ratio: 1 });
            await expect.poll(async () => {
                const box = await confirm.boundingBox();
                return box ? Math.round(box.y + box.height) : -1;
            }).toBe(viewport.height - 24);
            const confirmBox = await confirm.boundingBox();
            const contentBox = await content.boundingBox();
            const methodBox = await content.getByRole("button", { name: "Efectivo", exact: true }).boundingBox();
            const firstLineBox = await accountLines(page, true).first().boundingBox();
            const footerBox = await confirm.locator("..").boundingBox();
            expect(methodBox!.y + methodBox!.height).toBeLessThanOrEqual(firstLineBox!.y);
            expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(footerBox!.y);
            await capture("account-summary");

            await content.getByRole("button", { name: "Salir de la cuenta", exact: true }).scrollIntoViewIfNeeded();
            await expect.poll(() => content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
            await expect(confirm).toBeInViewport({ ratio: 1 });
            expect((await confirm.boundingBox())!.y).toBe(confirmBox!.y);
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await capture("long-account-scrolled");

            // Only the summary's charge button opens the separate cash dialog.
            const cashDialog = await openCashDialog(page);
            await expect(accountLines(page, true)).toHaveCount(0);
            const received = cashDialog.getByLabel("Efectivo recibido", { exact: true });
            const cashConfirm = cashDialog.getByRole("button", { name: "Cobrar $250.00", exact: true });
            await expect(received).toBeInViewport({ ratio: 1 });
            await expect(received).toHaveJSProperty("required", true);
            await expect(cashConfirm).toBeInViewport({ ratio: 1 });
            await expect(cashConfirm).toBeDisabled();
            await received.fill("249");
            await cashDialog.getByRole("alert").scrollIntoViewIfNeeded();
            await expect(cashDialog.getByRole("alert")).toHaveText("El monto recibido es menor al total del cobro. Ingresa un monto igual o mayor.");
            await expect(cashDialog.getByRole("alert")).toBeInViewport({ ratio: 1 });
            await expect(cashDialog.locator("#mobile-cash-change")).toHaveText("Faltan $1.00");
            await expect(cashConfirm).toBeInViewport({ ratio: 1 });
            await expect(cashConfirm).toBeDisabled();
            await capture("cash-dialog-insufficient");
            await received.fill("250.001");
            await cashDialog.getByRole("alert").scrollIntoViewIfNeeded();
            await expect(cashDialog.getByRole("alert")).toBeInViewport({ ratio: 1 });
            await expect(cashConfirm).toBeInViewport({ ratio: 1 });
            await expect(cashConfirm).toBeDisabled();
            await capture("cash-dialog-invalid");
            await received.fill("250,05");
            await expect(cashDialog.locator("#mobile-cash-change")).toHaveText("Cambio a entregar: $0.05");
            await expect(cashConfirm).toBeEnabled();
            await expect(cashConfirm).toBeInViewport({ ratio: 1 });
            await expect(cashDialog.getByRole("button", { name: "Volver a la cuenta", exact: true })).toBeInViewport({ ratio: 1 });
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
            await capture("cash-dialog-valid");
            await cashConfirm.click();
            await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 15_000 });
        });
    }

    test("desktop Cerrar cuenta shows informational cash received and change without blocking settlement", async ({ page }) => {
        test.skip(test.info().project.name !== "desktop", "Desktop Cerrar cuenta dialog");
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        let previousSaleId = 0;
        try {
            previousSaleId = (await pool.query<{ id: number }>(
                "SELECT COALESCE(MAX(id), 0) AS id FROM sales",
            )).rows[0].id;

            await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
            await expectTicketTotal(page, false, "25.00");
            await page.getByRole("button", { name: /Cerrar cuenta/ }).click();

            const dialog = page.getByRole("dialog", { name: /^Pago de cuenta/ });
            const received = dialog.getByLabel("Efectivo recibido", { exact: true });
            const change = dialog.locator("#desktop-cash-change");
            const confirm = dialog.getByRole("button", { name: "Confirmar y Cerrar", exact: true });

            await expect(dialog).toContainText("Solo informativo");
            await expect(received).toHaveValue("");
            await expect(change).toContainText("Cambio a devolver");
            await expect(change).toContainText("—");
            await expect(confirm).toBeEnabled();

            // Minimal and boundary cases
            for (const [value, expectedText] of [
                ["25", "$0.00"],
                ["100", "$75.00"],
                ["25.5", "$0.50"],
                ["25,05", "$0.05"],
                ["10", "Faltan $15.00"],
                ["0", "Faltan $25.00"],
                ["   ", "—"],
            ] as const) {
                await received.fill(value);
                await expect(change).toContainText(expectedText);
                // Strictly informational: Confirmar y Cerrar stays enabled
                await expect(confirm).toBeEnabled();
            }

            // Invalid input edge cases show hint without blocking settlement
            for (const invalid of ["abc", "-5", "25.001", "1e3"]) {
                await received.fill(invalid);
                await expect(received).toHaveAttribute("aria-invalid", "true");
                await expect(change).toContainText("—");
                await expect(dialog.locator("#desktop-cash-hint")).toBeVisible();
                await expect(confirm).toBeEnabled();
            }

            // Switching to Transferencia hides the cash input and resets its value
            await received.fill("50");
            await expect(change).toContainText("$25.00");
            await dialog.getByRole("button", { name: "Transferencia", exact: true }).click();
            await expect(dialog.getByLabel("Efectivo recibido", { exact: true })).toHaveCount(0);
            await dialog.getByRole("button", { name: "Efectivo", exact: true }).click();
            await expect(received).toHaveValue("");
            await expect(change).toContainText("—");

            // Closing and reopening the dialog resets the input
            await received.fill("80");
            await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
            await expect(dialog).toHaveCount(0);
            await page.getByRole("button", { name: /Cerrar cuenta/ }).click();
            await expect(received).toHaveValue("");

            // Confirming with cash entered settles the sale cleanly
            await received.fill("50");
            await expect(change).toContainText("$25.00");
            await confirm.click();
            await expect(dialog).toHaveCount(0, { timeout: 15_000 });
            await expect(page.getByRole("button", { name: /Cerrar cuenta/ })).toBeDisabled({ timeout: 15_000 });

            const settled = (await pool.query<{ status: string; payment_method: string }>(
                "SELECT status, payment_method FROM sales WHERE id > $1 ORDER BY id DESC LIMIT 1",
                [previousSaleId],
            )).rows[0];
            expect(settled).toEqual({ status: "PAID", payment_method: "CASH" });
        } finally {
            await pool.query(
                "UPDATE sales SET status = 'CANCELLED' WHERE id > $1 AND status = 'UNPAID'",
                [previousSaleId],
            ).catch(() => {});
            await pool.end();
        }
    });

    test("staff deleting a customer item with minus during live Cerrar cuenta never resurrects gray rows or locks POS", async ({ page, browser }) => {
        test.skip(test.info().project.name !== "desktop", "Desktop multi-terminal POS test");
        test.setTimeout(120_000);
        const pool = new Pool({ connectionString: E2E_DATABASE_URL });
        const staffContext = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const terminalB = await staffContext.newPage();
        terminalB.on("dialog", (d) => d.dismiss().catch(() => {}));
        let previousSaleId = 0;
        try {
            previousSaleId = (await pool.query<{ id: number }>(
                "SELECT COALESCE(MAX(id), 0) AS id FROM sales",
            )).rows[0].id;

            // Terminal A (Admin) selects Cliente Uno E2E, adds Taco Pastor ($25), opens Cerrar cuenta.
            await page.getByRole("combobox").filter({ hasText: "Nombre de cliente" }).click();
            await page.getByRole("option", { name: /Cliente Uno E2E/ }).click();
            await page.getByRole("button", { name: /Taco Pastor/ }).first().click();
            await expect(page.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 });
            await expect(page.getByRole("button", { name: /Cerrar cuenta/ })).toBeEnabled({ timeout: 15_000 });
            await page.getByRole("button", { name: /Cerrar cuenta/ }).click();
            const summary = page.getByRole("dialog", { name: /^Pago de cuenta Cliente Cliente Uno E2E$/ });
            await expect(summary).toBeVisible();
            await expect(summary).toContainText("$25.00");

            // Terminal B logs in as STAFF, selects the same customer, adds Quesadilla Grande ($35).
            await terminalB.goto("/login");
            await terminalB.getByRole("tab", { name: "Staff" }).click();
            await terminalB.locator('input[name="username"]').fill("TEST1");
            await terminalB.getByLabel("PIN", { exact: true }).fill("1234");
            await terminalB.getByRole("button", { name: "Entrar al Sistema" }).click();
            await terminalB.waitForURL("**/pos", { timeout: 20_000 });

            await terminalB.getByRole("combobox").filter({ hasText: "Nombre de cliente" }).click();
            await terminalB.getByRole("option", { name: /Cliente Uno E2E/ }).click();
            await expect(terminalB.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 });

            await terminalB.getByRole("button", { name: /Quesadilla Grande/ }).first().click();
            await expect(terminalB.locator("tbody tr")).toHaveCount(2, { timeout: 15_000 });
            await expect(terminalB.locator("tbody tr.opacity-60")).toHaveCount(0, { timeout: 15_000 });
            await expect(terminalB.getByRole("button", { name: /Cerrar cuenta/ })).toBeEnabled({ timeout: 15_000 });

            // Terminal A's open dialog reflects the new Quesadilla ($60.00).
            await expect(summary).toContainText("$60.00", { timeout: 20_000 });

            // Staff on Terminal B uses the minus (-) button on Quesadilla Grande (qty 1 -> 0 -> delete).
            const quesadillaRow = terminalB.locator("tbody tr", { hasText: "Quesadilla Grande" });
            await quesadillaRow.getByRole("button").nth(1).click();

            // Must NOT leave a gray (opacity-60) resurrected row and must NOT lock Terminal B's UI.
            await expect(terminalB.locator("tbody tr")).toHaveCount(1, { timeout: 15_000 });
            await expect(terminalB.locator("tbody tr.opacity-60")).toHaveCount(0);
            await expect(terminalB.getByRole("button", { name: /Cerrar cuenta/ })).toBeEnabled({ timeout: 15_000 });
            await expect(terminalB.locator("tbody tr").first().getByRole("button").nth(0)).toBeEnabled();

            // Terminal A's open dialog reflects the removal (Quesadilla gone, Total back to $25.00) and closes the account.
            await expect(summary).not.toContainText("Quesadilla Grande", { timeout: 20_000 });
            await expect(summary).not.toContainText("$60.00");
            await expect(summary).toContainText("$25.00");
            await summary.getByRole("button", { name: "Confirmar y Cerrar", exact: true }).click();
            await expect(summary).toHaveCount(0, { timeout: 15_000 });

            // After Terminal A settles, Terminal B refreshes to 0 rows, NO gray rows, and stays unlocked.
            await expect(terminalB.locator("tbody tr")).toHaveCount(0, { timeout: 20_000 });
            await expect(terminalB.locator("tbody tr.opacity-60")).toHaveCount(0);
            await expect(terminalB.getByRole("button", { name: /Cambiar a venta libre/ })).toBeEnabled();
        } finally {
            await staffContext.close().catch(() => {});
            await pool.query(
                "UPDATE sales SET status = 'CANCELLED' WHERE id > $1 AND status = 'UNPAID'",
                [previousSaleId],
            ).catch(() => {});
            await pool.end();
        }
    });
});
