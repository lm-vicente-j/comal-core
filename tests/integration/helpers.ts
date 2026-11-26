import type { ActionResult } from "@/lib/action-result";
import { vi } from "vitest";
import type { Session } from "next-auth";
import { randomUUID } from "node:crypto";
import type { CashCountInput } from "@/lib/cash-count";

/**
 * Shared helpers for the server-action integration tests.
 *
 * Every test file mocks `@/lib/auth` with `mockAuth` (so actions see a real
 * looking JWT session without NextAuth needing a request context) and
 * `next/cache` (revalidatePath only works inside a Next.js request).
 */

export const authMock = vi.fn<() => Promise<Session | null>>();

let defaultOwnerId = 1;

export function loginAs(role: "ADMIN" | "SUPERVISOR" | "STAFF", id = defaultOwnerId) {
    authMock.mockResolvedValue({
        user: { id: String(id), name: "Test User", role },
        expires: new Date(Date.now() + 3600_000).toISOString(),
    } as Session);
}

export function logout() {
    authMock.mockResolvedValue(null);
}

/** Build physical cash rows for action integration tests using catalog denominations. */
export function makeCashCountInput(cents: number, note?: string): CashCountInput {
    if (!Number.isSafeInteger(cents) || cents < 0 || cents % 5 !== 0) {
        throw new Error(`Cash test fixture amount must be a non-negative multiple of 5 cents: ${cents}`);
    }
    let remaining = cents;
    const denominations: CashCountInput["denominations"] = [];
    for (const { kind, valueCents } of [
        ...[100000, 50000, 20000, 10000, 5000, 2000].map(valueCents => ({ kind: "BILL" as const, valueCents })),
        ...[2000, 1000, 500, 200, 100, 50, 20, 10, 5].map(valueCents => ({ kind: "COIN" as const, valueCents })),
    ]) {
        const quantity = Math.floor(remaining / valueCents);
        if (quantity > 0) {
            denominations.push({ kind, valueCents, quantity });
            remaining -= quantity * valueCents;
        }
    }
    return {
        requestId: randomUUID(),
        denominations,
        ...(note ? { note } : {}),
        ...(cents === 0 ? { confirmEmpty: true } : {}),
    };
}

/** Deletes every row in dependency order so each suite starts clean. */
export async function resetDb() {
    const { default: prisma } = await import("@/lib/prisma");
    await prisma.$transaction(async (tx) => {
        // cash_count is protected by an immutable-row trigger; reset fixtures
        // with TRUNCATE (trigger-safe) before removing its referenced jornada/users.
        await tx.$executeRaw`TRUNCATE TABLE "cash_count" RESTART IDENTITY CASCADE`;
        await tx.goal_contribution.deleteMany();
        await tx.savings_goal.deleteMany();
        await tx.savings_movement.deleteMany();
        await tx.debtors.deleteMany();
        await tx.sale_item_consumptions.deleteMany();
        await tx.sale_items.deleteMany();
        await tx.sales.deleteMany();
        await tx.recipes.deleteMany();
        await tx.products.deleteMany();
        await tx.supplies.deleteMany();
        await tx.salary.deleteMany();
        await tx.bill.deleteMany();
        await tx.jornada.deleteMany();
        await tx.customer.deleteMany();
        await tx.terminalSession.deleteMany();
        await tx.terminalRequest.deleteMany();
        await tx.terminal.deleteMany();
        await tx.rolePermission.deleteMany();
        await tx.authRateLimit.deleteMany();
        await tx.securityAudit.deleteMany();
        await tx.users.deleteMany();
        await tx.setting.deleteMany({ where: { OR: [{ key: { startsWith: "TICKET_RES:" } }, { key: { startsWith: "AUTH_LOCKOUT:" } }, { key: { in: ["CASH_COUNT_TOLERANCE_CENTS", "CLABE"] } }] } });
    }, { maxWait: 10_000, timeout: 30_000 });
}

/** Base fixtures most suites need: an admin user and an open jornada. */
export async function seedBase() {
    const { default: prisma } = await import("@/lib/prisma");
    const admin = await prisma.users.create({
        data: { name: "Admin Test", email: "admin@test.local", role: "ADMIN", active: true },
    });
    defaultOwnerId = admin.id;
    const jornada = await prisma.jornada.create({
        data: { openedBy: admin.id, openingAmountCents: 50000, status: "OPEN" },
    });
    return { admin, jornada };
}

/** Unwrap successful reads while retaining existing payload regression assertions. */
export function actionData<T>(result: ActionResult<T>): T {
    if (!result.success) throw new Error(`Expected successful action, received ${result.error}`);
    return result.data as T;
}
