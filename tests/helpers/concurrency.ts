import { setTimeout as delay } from "node:timers/promises";
import prisma from "@/lib/prisma";
import { acquireJornadaTicketLock } from "@/lib/ticket-reservations";

export function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

export async function waitForAdvisoryWaiters(jornadaId: number, expected: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
                AND classid = 290001::oid AND objid = ${jornadaId}::oid
        `;
        if (row.count >= expected) return;
        await delay(10);
    }
    throw new Error(`Timed out waiting for ${expected} advisory waiter(s) on jornada ${jornadaId}`);
}

/** Queue real transactions in a specified order; always release and drain them. */
export async function orderedJornadaActions(jornadaId: number, actions: Array<() => Promise<unknown>>) {
    const acquired = deferred();
    const release = deferred();
    const blocker = prisma.$transaction(async tx => {
        await acquireJornadaTicketLock(tx, jornadaId);
        acquired.resolve();
        await release.promise;
    }, { timeout: 15_000 });
    // A blocker failure must reject the handshake instead of hanging the suite.
    await Promise.race([acquired.promise, blocker.then(() => { throw new Error("Blocker ended before acquiring lock"); })]);
    const pending: Promise<unknown>[] = [];
    try {
        for (const action of actions) {
            const promise = action();
            // Attach a rejection handler immediately while observing its DB waiter.
            void promise.catch(() => {});
            pending.push(promise);
            await waitForAdvisoryWaiters(jornadaId, pending.length);
        }
        release.resolve();
        return await Promise.all(pending);
    } finally {
        release.resolve();
        await Promise.allSettled(pending);
        await blocker;
    }
}
