import type { ActionResult } from "@/lib/action-result";
import { vi } from "vitest";
import type { Session } from "next-auth";

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

/** Deletes every row in dependency order so each suite starts clean. */
export async function resetDb() {
    const { default: prisma } = await import("@/lib/prisma");
    await prisma.$transaction(async (tx) => {
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
        await tx.setting.deleteMany({ where: { OR: [{ key: { startsWith: "TICKET_RES:" } }, { key: { startsWith: "AUTH_LOCKOUT:" } }] } });
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
