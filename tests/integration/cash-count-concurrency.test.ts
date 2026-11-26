import { describe, it, expect, beforeEach, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { closeJornada, openJornada, recordCashCount } from "@/lib/actions/jornada";
import { saveExpense } from "@/lib/actions/expenses";
import { createSale } from "@/lib/actions/sales";
import { acquireJornadaTicketLock } from "@/lib/ticket-reservations";
import { makeCashCountInput, loginAs, resetDb } from "./helpers";

const LOCK_NAMESPACE = 290001;

async function waitForAdvisoryWaiters(jornadaId: number, expected: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const rows = await prisma.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND classid = ${LOCK_NAMESPACE}::oid AND objid = ${jornadaId}::oid
        `;
        if (Number(rows[0]?.count ?? 0) >= expected) return;
        await delay(10);
    }
    throw new Error(`Timed out waiting for ${expected} advisory lock waiter(s) on jornada ${jornadaId}`);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

describe("cash count concurrency", () => {
    let adminId: number;
    let jornadaId: number;

    beforeEach(async () => {
        await resetDb();
        const admin = await prisma.users.create({ data: { name: "Concurrency Admin", email: "cash-race@test.local", role: "ADMIN", active: true } });
        adminId = admin.id;
        loginAs("ADMIN", adminId);
        const opened = await openJornada(makeCashCountInput(50000));
        if (!opened.success) throw new Error(opened.error);
        jornadaId = opened.data.jornadaId;
    });

    it("orders a count and cash expense by their shared jornada lock, freezing the count cutoff", async () => {
        const acquired = deferred();
        const release = deferred();
        const blocker = prisma.$transaction(async tx => {
            await acquireJornadaTicketLock(tx, jornadaId);
            acquired.resolve();
            await release.promise;
        });
        await acquired.promise;

        const count = recordCashCount(jornadaId, makeCashCountInput(50000));
        await waitForAdvisoryWaiters(jornadaId, 1);
        const expense = saveExpense({ amount: 25, category: "Race", description: "Raced after count", date: new Date(), payment_method: "CASH" });
        await waitForAdvisoryWaiters(jornadaId, 2);
        release.resolve();

        const [countResult, expenseResult] = await Promise.all([count, expense]);
        await blocker;
        expect(countResult).toMatchObject({ success: true, data: { expectedAmount: 50000, difference: 0 } });
        expect(expenseResult).toMatchObject({ success: true });
        const row = await prisma.cash_count.findFirstOrThrow({ where: { jornadaId, type: "INTERIM" } });
        expect(Number(row.expectedAmountCents)).toBe(50000);
    });

    it("serializes two closures so exactly one closing count is committed", async () => {
        const acquired = deferred();
        const release = deferred();
        const blocker = prisma.$transaction(async tx => {
            await acquireJornadaTicketLock(tx, jornadaId);
            acquired.resolve();
            await release.promise;
        });
        await acquired.promise;
        const first = closeJornada(jornadaId, makeCashCountInput(50000));
        await waitForAdvisoryWaiters(jornadaId, 1);
        const second = closeJornada(jornadaId, makeCashCountInput(50000));
        await waitForAdvisoryWaiters(jornadaId, 2);
        release.resolve();
        const results = await Promise.all([first, second]);
        await blocker;
        expect(results.filter(result => result.success)).toHaveLength(1);
        expect(await prisma.cash_count.count({ where: { jornadaId, type: "CLOSING" } })).toBe(1);
        expect((await prisma.jornada.findUniqueOrThrow({ where: { id: jornadaId } })).status).toBe("CLOSED");
    });

    it("does not strand a sale when closure wins the jornada lock", async () => {
        const product = await prisma.products.create({ data: { name: "Race taco", priceCents: 5000 } });
        const acquired = deferred();
        const release = deferred();
        const blocker = prisma.$transaction(async tx => {
            await acquireJornadaTicketLock(tx, jornadaId);
            acquired.resolve();
            await release.promise;
        });
        await acquired.promise;
        const closing = closeJornada(jornadaId, makeCashCountInput(50000));
        await waitForAdvisoryWaiters(jornadaId, 1);
        const sale = createSale([{ productID: product.id, quantity: 1 }], "UNPAID", "MESA_3", -1);
        await waitForAdvisoryWaiters(jornadaId, 2);
        release.resolve();
        const [closeResult, saleResult] = await Promise.all([closing, sale]);
        await blocker;
        expect(closeResult).toMatchObject({ success: true });
        expect(saleResult).toMatchObject({ success: false });
        expect(await prisma.sales.count({ where: { jornadaId, status: "UNPAID" } })).toBe(0);
        expect((await prisma.jornada.findUniqueOrThrow({ where: { id: jornadaId } })).status).toBe("CLOSED");
    });
});
