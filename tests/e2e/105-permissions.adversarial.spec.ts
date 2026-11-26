import { expect } from "@playwright/test";
import {
    test, terminal, viewports, withTerminals, selectCustomer, addProduct,
    sendToDebt, cashCollection, account, checkout, isMobile, holdAction,
} from "../helpers/pos-browser";

for (const viewport of viewports) {
    for (const role of ["STAFF", "SUPERVISOR"] as const) {
        for (const capability of ["sales.managePending", "debts.collect"] as const) {
            test(`${role} revocation of ${capability} with an open account at ${viewport.width}`, async ({ browser, scenario }) => {
                test.setTimeout(120_000);
                const { context, page } = await terminal(browser, viewport, role);
                try {
                    await selectCustomer(page, scenario);
                    await addProduct(page, scenario);
                    if (capability === "debts.collect") await sendToDebt(page, scenario);
                    const sale = (await scenario.pool.query<{ id: number }>('SELECT id FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows[0].id;
                    const held = await holdAction(page, body => capability === "debts.collect" ? body.startsWith(`[${scenario.customer},`) && body.includes('"CASH"') : body === JSON.stringify([sale, 2, scenario.product]));
                    try {
                        if (capability === "debts.collect") await (await cashCollection(page, scenario)).click();
                        else {
                            const root = await account(page);
                            const line = isMobile(page) ? root.getByRole("listitem").first() : page.locator("tbody tr").first();
                            await (isMobile(page) ? line.getByRole("button", { name: "Aumentar cantidad" }) : line.getByRole("button").nth(0)).click();
                        }
                        await held.arrived;
                        await scenario.permission(role, capability, false);
                        held.release();
                        const response = await held.response;
                        expect(await response.text()).toContain("FORBIDDEN");
                        expect((await scenario.pool.query('SELECT quantity FROM sale_items WHERE "saleID"=$1', [sale])).rows[0].quantity).toBe(1);
                        expect((await scenario.pool.query('SELECT status FROM sales WHERE id=$1', [sale])).rows[0].status).toBe(capability === "debts.collect" ? "DEBT" : "UNPAID");
                        expect((await scenario.pool.query('SELECT "currentBalanceCents" FROM customer WHERE id=$1', [scenario.customer])).rows[0].currentBalanceCents).toBe(capability === "debts.collect" ? "2500" : "0");
                    } finally { await held.dispose(); }
                } finally { await context.close(); }
            });
        }
    }

    for (const role of ["ADMIN", "SUPERVISOR", "STAFF"] as const) for (const status of ["PAID", "DEBT"] as const) {
        test(`${role} stale edit respects ${status} restrictions at ${viewport.width}`, async ({ browser, scenario }) => {
            test.setTimeout(120_000);
            const { context, page } = await terminal(browser, viewport, role);
            try {
                await selectCustomer(page, scenario);
                await addProduct(page, scenario);
                const sale = (await scenario.pool.query<{ id: number }>('SELECT id FROM sales WHERE "jornadaId"=$1', [scenario.jornada])).rows[0].id;
                const root = await account(page);
                const line = isMobile(page) ? root.getByRole("listitem").first() : page.locator("tbody tr").first();
                const held = await holdAction(page, body => body === JSON.stringify([sale, 2, scenario.product]));
                try {
                    await (isMobile(page) ? line.getByRole("button", { name: "Aumentar cantidad" }) : line.getByRole("button").nth(0)).click();
                    await held.arrived;
                    await withTerminals(browser, viewport, async admin => {
                        await selectCustomer(admin, scenario);
                        if (status === "PAID") await (await checkout(admin)).click();
                        else await sendToDebt(admin, scenario);
                        await expect.poll(async () => (await scenario.pool.query('SELECT status FROM sales WHERE id=$1', [sale])).rows[0].status).toBe(status);
                    });
                    held.release();
                    const response = await held.response;
                    const allowed = role === "ADMIN" && status === "DEBT";
                    if (!allowed) expect(await response.text()).toContain(status === "PAID" ? "CANNOT_MODIFY_PAID_SALE" : "UNAUTHORIZED");
                    expect((await scenario.pool.query('SELECT quantity FROM sale_items WHERE "saleID"=$1', [sale])).rows[0].quantity).toBe(allowed ? 2 : 1);
                    expect((await scenario.pool.query('SELECT "currentBalanceCents" FROM customer WHERE id=$1', [scenario.customer])).rows[0].currentBalanceCents).toBe(status === "PAID" ? "0" : allowed ? "5000" : "2500");
                } finally { await held.dispose(); }
            } finally { await context.close(); }
        });
    }
}
