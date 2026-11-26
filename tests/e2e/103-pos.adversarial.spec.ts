import { expect, type Route } from "@playwright/test";
import {
    test, viewports, withTerminals, selectCustomer, addProduct, sendToDebt, cashCollection,
    account, startDebt, closeShift, openShift, actionRequest, stock, isMobile, holdAction,
} from "../helpers/pos-browser";

for (const viewport of viewports) {
    test.describe(`${viewport.width}x${viewport.height}`, () => {
        test.setTimeout(120_000);

        test("POS debt collected in the next jornada preserves attribution", async ({ browser, scenario }) => {
            await withTerminals(browser, viewport, async (a, b) => {
                await selectCustomer(a, scenario);
                await addProduct(a, scenario);
                await sendToDebt(a, scenario);
                await closeShift(b);
                await openShift(b);
                const next = (await scenario.pool.query<{ id: number }>("SELECT id FROM jornada WHERE status='OPEN'")).rows[0].id;
                expect(next).not.toBe(scenario.jornada);
                await (await cashCollection(a, scenario)).click();
                await expect.poll(async () => (await scenario.pool.query('SELECT "currentBalanceCents" FROM customer WHERE id=$1', [scenario.customer])).rows[0].currentBalanceCents).toBe("0");
                const debts = (await scenario.pool.query('SELECT "createdJornadaId","paidJornadaId","collectedBy",status FROM debtors WHERE "customerID"=$1', [scenario.customer])).rows;
                expect(debts).toEqual([{ createdJornadaId: scenario.jornada, paidJornadaId: next, collectedBy: scenario.owner, status: "PAID" }]);
            });
        });

        for (const operation of ["sale", "debt", "payment"] as const) {
            for (const failure of ["before-commit", "response-lost"] as const) {
                test(`${operation} recovers after ${failure} without duplicate confirmation`, async ({ browser, scenario }) => {
                    await withTerminals(browser, viewport, async a => {
                        await selectCustomer(a, scenario);
                        if (operation !== "sale") await addProduct(a, scenario);
                        if (operation === "payment") await sendToDebt(a, scenario);
                        const submit = operation === "debt" ? await startDebt(a)
                            : operation === "payment" ? await cashCollection(a, scenario) : a.getByRole("button", { name: new RegExp(scenario.productName) }).first();
                        let intercepted = false;
                        let finish!: () => void;
                        let reject!: (error: unknown) => void;
                        const injected = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
                        void injected.catch(() => {});
                        const intercept = async (route: Route) => {
                            const request = route.request();
                            const body = request.postData() ?? "";
                            const matches = operation === "sale" ? body.includes('"productID"') && body.includes('"UNPAID"')
                                : operation === "debt" ? body.startsWith(`[${scenario.customer},`) && !body.includes('"CASH"')
                                    : body.startsWith(`[${scenario.customer},`) && body.includes('"CASH"');
                            if (!actionRequest(request) || !matches || intercepted) return route.continue();
                            intercepted = true;
                            try {
                                if (failure === "response-lost") await route.fetch();
                                await route.abort("connectionfailed");
                                finish();
                            } catch (error) { reject(error); }
                        };
                        await a.route("**/*", intercept);
                        try {
                            await submit.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
                            await expect.poll(() => intercepted).toBe(true);
                            await injected;
                            const expectedStatus = failure === "before-commit" ? (operation === "payment" ? "DEBT" : "UNPAID")
                                : operation === "sale" ? "UNPAID" : operation === "debt" ? "DEBT" : "PAID";
                            const expectedCount = operation === "sale" && failure === "before-commit" ? 0 : 1;
                            await expect.poll(async () => (await scenario.pool.query<{ count: number }>('SELECT count(*)::int AS count FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows[0].count).toBe(expectedCount);
                            if (expectedCount) await expect.poll(async () => (await scenario.pool.query('SELECT status FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows[0].status).toBe(expectedStatus);
                            // Recovery must release the in-flight controls before navigation.
                            await expect(submit).toBeEnabled();
                        } finally { await a.unrouteAll({ behavior: "wait" }); }
                        if (failure === "before-commit") {
                            await submit.click();
                            await expect.poll(async () => (await scenario.pool.query('SELECT status FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows[0]?.status)
                                .toBe(operation === "sale" ? "UNPAID" : operation === "debt" ? "DEBT" : "PAID");
                        }
                        if (failure === "response-lost" && operation !== "sale") {
                            const retry = a.waitForResponse(r => actionRequest(r.request()) && (r.request().postData() ?? "").startsWith(`[${scenario.customer},`));
                            await submit.click();
                            await retry;
                        }
                        await a.reload();
                        expect((await scenario.pool.query('SELECT id FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows).toHaveLength(1);
                        const balance = operation === "debt" ? "2500" : "0";
                        expect((await scenario.pool.query('SELECT "currentBalanceCents" FROM customer WHERE id=$1', [scenario.customer])).rows[0].currentBalanceCents).toBe(balance);
                        expect(await stock(scenario)).toBe("99875");
                    });
                });
            }
        }

        test("quantity edit and cancellation restore recorded ingredient consumption", async ({ browser, scenario }) => {
            await withTerminals(browser, viewport, async a => {
                await selectCustomer(a, scenario);
                await addProduct(a, scenario);
                expect(await stock(scenario)).toBe("99875");
                const root = await account(a);
                const line = isMobile(a) ? root.getByRole("listitem").first() : a.locator("tbody tr").first();
                await (isMobile(a) ? line.getByRole("button", { name: "Aumentar cantidad" }) : line.getByRole("button").nth(0)).click();
                await expect.poll(() => stock(scenario)).toBe("99750");
                const consumption = await scenario.pool.query('SELECT c."quantityUsedMilliunits",i.quantity FROM sale_item_consumptions c JOIN sale_items i ON i.id=c."saleItemID" JOIN sales s ON s.id=i."saleID" WHERE s."jornadaId"=$1', [scenario.jornada]);
                expect(consumption.rows).toEqual([{ quantityUsedMilliunits: "125", quantity: 2 }]);
                await (isMobile(a) ? line.getByRole("button", { name: "Eliminar línea" }) : line.getByRole("button").nth(2)).click();
                await expect.poll(() => stock(scenario)).toBe("100000");
                expect((await scenario.pool.query('SELECT status FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows[0].status).toBe("CANCELLED");
            });
        });

        for (const target of ["product", "supply"] as const) {
            test(`deactivating a ${target} rejects an already displayed POS product`, async ({ browser, scenario }) => {
                await withTerminals(browser, viewport, async a => {
                    await selectCustomer(a, scenario);
                    const button = a.getByRole("button", { name: new RegExp(scenario.productName) }).first();
                    await expect(button).toBeEnabled();
                    const held = await holdAction(a, body => body.includes('"productID"'));
                    try {
                        await button.click();
                        await held.arrived;
                        if (target === "product") await scenario.pool.query('UPDATE products SET active=false WHERE id=$1', [scenario.product]);
                        else await scenario.pool.query('UPDATE supplies SET active=false WHERE id=$1', [scenario.supply]);
                        held.release();
                        await held.response;
                    } finally { await held.dispose(); }
                    expect((await scenario.pool.query('SELECT id FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows).toHaveLength(0);
                    expect(await stock(scenario)).toBe("100000");
                });
            });
        }

        test("two terminals reserve distinct tickets and reject an expired stale selection", async ({ browser, scenario }) => {
            await withTerminals(browser, viewport, async (a, b) => {
                await Promise.all([a.goto("/pos"), b.goto("/pos")]);
                if (isMobile(a)) await Promise.all([a.getByRole("button", { name: "De paso", exact: true }).click(), b.getByRole("button", { name: "De paso", exact: true }).click()]);
                await Promise.all([a.getByRole("button", { name: "Nuevo", exact: true }).click(), b.getByRole("button", { name: "Nuevo", exact: true }).click()]);
                await expect.poll(async () => (await scenario.pool.query("SELECT key FROM setting WHERE key LIKE $1", [`TICKET_RES:${scenario.jornada}:%`])).rowCount).toBe(2);
                await expect(a.getByRole("button", { name: "Nuevo", exact: true })).toBeEnabled();
                await expect(b.getByRole("button", { name: "Nuevo", exact: true })).toBeEnabled();
                const reservations = (await scenario.pool.query<{ key: string; value: string }>("SELECT key,value FROM setting WHERE key LIKE $1 ORDER BY key", [`TICKET_RES:${scenario.jornada}:%`])).rows;
                expect(reservations).toHaveLength(2);
                expect(new Set(reservations.map(row => JSON.parse(row.value).token)).size).toBe(2);
                // Expire both tokens without waiting fifteen minutes; both terminal selections stay open.
                for (const row of reservations) await scenario.pool.query('UPDATE setting SET value=$1 WHERE key=$2', [JSON.stringify({ ...JSON.parse(row.value), expiresAt: Date.now() - 1 }), row.key]);
                const reserved = b.waitForResponse(r => actionRequest(r.request()) && r.request().postData() === "[]");
                await b.getByRole("button", { name: "Nuevo", exact: true }).click();
                await reserved;
                await expect(b.getByRole("button", { name: "Nuevo", exact: true })).toBeEnabled();
                const response = a.waitForResponse(r => actionRequest(r.request()) && (r.request().postData() ?? "").includes('"productID"'));
                await a.getByRole("button", { name: new RegExp(scenario.productName) }).first().click();
                await response;
                expect((await scenario.pool.query('SELECT id FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows).toHaveLength(0);
                await addProduct(b, scenario);
                expect((await scenario.pool.query('SELECT id FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows).toHaveLength(1);
                expect(await stock(scenario)).toBe("99875");
            });
        });

        for (const operation of ["create", "edit", "collect"] as const) {
            test(`another terminal closes the shift before POS ${operation}`, async ({ browser, scenario }) => {
                await withTerminals(browser, viewport, async (a, b) => {
                    await selectCustomer(a, scenario);
                    if (operation !== "create") await addProduct(a, scenario);
                    if (operation === "collect") await sendToDebt(a, scenario);
                    const confirm = operation === "collect" ? await cashCollection(a, scenario) : undefined;
                    if (operation === "collect") {
                        const held = await holdAction(a, body => body.startsWith(`[${scenario.customer},`) && body.includes('"CASH"'));
                        try {
                            await confirm!.click();
                            await held.arrived;
                            await closeShift(b);
                            held.release();
                            await held.response;
                            await expect(a.getByRole("dialog", { name: "Cobrar en efectivo", exact: true }).getByRole("alert")).toBeVisible();
                            expect((await scenario.pool.query('SELECT "currentBalanceCents" FROM customer WHERE id=$1', [scenario.customer])).rows[0].currentBalanceCents).toBe("2500");
                        } finally { await held.dispose(); }
                    } else {
                        const sale = (await scenario.pool.query<{ id: number }>('SELECT id FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows[0];
                        const held = await holdAction(a, body => operation === "create" ? body.includes('"productID"') : body === JSON.stringify([sale.id, 2, scenario.product]));
                        try {
                            if (operation === "create") await a.getByRole("button", { name: new RegExp(scenario.productName) }).first().click();
                            else {
                                const root = await account(a);
                                const line = isMobile(a) ? root.getByRole("listitem").first() : a.locator("tbody tr").first();
                                await (isMobile(a) ? line.getByRole("button", { name: "Aumentar cantidad" }) : line.getByRole("button").nth(0)).click();
                            }
                            await held.arrived;
                            if (operation === "edit") {
                                // ADMIN can edit DEBT in an open shift. Convert to debt before closure to isolate the CLOSED guard.
                                await selectCustomer(b, scenario);
                                await sendToDebt(b, scenario);
                            }
                            await closeShift(b);
                            held.release();
                            const result = await held.response;
                            if (operation === "edit") expect(await result.text()).toContain("JORNADA_CLOSED");
                            if (operation === "create") expect((await scenario.pool.query('SELECT id FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows).toHaveLength(0);
                            else expect((await scenario.pool.query('SELECT quantity FROM sale_items WHERE "productID"=$1', [scenario.product])).rows[0].quantity).toBe(1);
                        } finally { await held.dispose(); }
                    }
                    expect((await scenario.pool.query('SELECT status FROM jornada WHERE id=$1', [scenario.jornada])).rows[0].status).toBe("CLOSED");
                });
            });
        }
    });
}
