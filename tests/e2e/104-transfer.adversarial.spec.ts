import { expect } from "@playwright/test";
import { test, terminal, viewports, selectCustomer, addProduct, sendToDebt, debtSummary, account, isMobile } from "../helpers/pos-browser";

for (const viewport of viewports) for (const role of ["STAFF", "SUPERVISOR"] as const) for (const source of ["POS", "Deudores"] as const) {
    test(`OCR CLABE ${role} ${source} at ${viewport.width}`, async ({ browser, scenario }) => {
        test.setTimeout(90_000);
        const previous = (await scenario.pool.query('SELECT value FROM setting WHERE key=\'CLABE\'')).rows[0];
        const { context, page } = await terminal(browser, viewport, role);
        try {
            await scenario.pool.query('INSERT INTO setting (key,value,"updatedAt") VALUES (\'CLABE\',$1,NOW()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', ["123456789012345678"]);
            await selectCustomer(page, scenario);
            await addProduct(page, scenario);
            if (source === "Deudores") {
                await sendToDebt(page, scenario);
                const summary = await debtSummary(page, scenario);
                await summary.getByRole("combobox").click();
                await page.getByRole("option", { name: "Transferencia", exact: true }).click();
                await summary.getByRole("button", { name: "Confirmar transferencia", exact: true }).click();
            } else {
                if (isMobile(page)) {
                    const summary = await account(page);
                    await summary.getByRole("button", { name: "Transferencia", exact: true }).click();
                    await summary.getByRole("button", { name: /^Cobrar \$/ }).click();
                } else {
                    await page.getByRole("button", { name: /Cerrar cuenta/ }).click();
                    const summary = page.getByRole("dialog", { name: /^Pago de cuenta/ });
                    await summary.getByRole("button", { name: "Transferencia", exact: true }).click();
                    await summary.getByRole("button", { name: "Confirmar y Cerrar", exact: true }).click();
                }
            }
            const dialog = page.getByRole("dialog", { name: "Confirmar transferencia recibida", exact: true });
            await expect(dialog).toBeVisible();
            await expect(dialog.getByRole("button", { name: "Confirmar transferencia recibida", exact: true })).toBeEnabled();
            expect((await scenario.pool.query('SELECT value FROM setting WHERE key=\'CLABE\'')).rows[0].value).toBe("123456789012345678");
            await test.info().attach("configured-clabe-dialog", { body: await page.screenshot(), contentType: "image/png" });
            test.fail(true, "Known OCR finding: getSettings hides configured CLABE from authenticated STAFF and SUPERVISOR collectors");
            await expect(dialog.getByLabel("CLABE de transferencia", { exact: true })).toHaveText("1234 5678 9012 3456 78", { timeout: 1500 });
        } finally {
            if (previous) await scenario.pool.query('UPDATE setting SET value=$1 WHERE key=\'CLABE\'', [previous.value]);
            else await scenario.pool.query('DELETE FROM setting WHERE key=\'CLABE\'');
            await context.close();
        }
    });
}
