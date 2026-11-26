import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../helpers/database");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { loginAs, logout, resetDb, seedBase } from "../helpers/database";
import {
    addContribution,
    cancelGoal,
    getGoalsWithProgress,
    getPoolBalance,
    getRecentMovements,
    saveGoal,
    saveMovement,
} from "@/lib/actions/savings";

describe("savings actions", () => {
    let adminId: number;
    let jornadaId: number;

    beforeAll(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;
    });

    it("rejects saveMovement for non-admin sessions", async () => {
        logout();
        expect(await saveMovement(10000, "DEPOSIT")).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        loginAs("STAFF", adminId);
        expect(await saveMovement(10000, "DEPOSIT")).toMatchObject({ success: false, error: "PERMISSION DENIED" });
        expect(await prisma.savings_movement.count()).toBe(0);
    });

    it("registers a deposit linked to the jornada and the user", async () => {
        loginAs("ADMIN", adminId);
        expect(await saveMovement(10000, "DEPOSIT", "ahorro viernes")).toMatchObject({ success: true });

        const row = await prisma.savings_movement.findFirstOrThrow();
        expect(row.type).toBe("DEPOSIT");
        expect(Number(row.amountCents)).toBe(10000);
        expect(row.registered_by).toBe(adminId);
        expect(row.jornadaId).toBe(jornadaId);
        expect(row.description).toBe("ahorro viernes");

        expect((await getPoolBalance()).balance).toBe(10000);
    });

    it("registers a withdrawal and rejects overdrafts", async () => {
        loginAs("ADMIN", adminId);
        expect(await saveMovement(4000, "WITHDRAW")).toMatchObject({ success: true });
        expect((await getPoolBalance()).balance).toBe(6000);

        const res = await saveMovement(100000, "WITHDRAW");
        expect(res.success).toBe(false);
        expect((await getPoolBalance()).balance).toBe(6000);
    });

    it("paginates recent movements", async () => {
        loginAs("ADMIN", adminId);
        const page1 = await getRecentMovements({ page: 1, pageSize: 1 });
        expect(page1.success && page1.data.items).toHaveLength(1);
        expect(page1.success && page1.data.hasMore).toBe(true);

        const page2 = await getRecentMovements({ page: 2, pageSize: 1 });
        expect(page2.success && page2.data.items).toHaveLength(1);
        expect(page2.success && page2.data.hasMore).toBe(false);
    });

    it("creates and updates a goal", async () => {
        loginAs("ADMIN", adminId);
        expect(await saveGoal({ name: "Horno", targetAmount: 20000 })).toMatchObject({ success: true });

        const goal = await prisma.savings_goal.findFirstOrThrow({ where: { name: "Horno" } });
        expect(goal.status).toBe("ACTIVE");

        expect(await saveGoal({ id: goal.id, name: "Horno Industrial", targetAmount: 20000 })).toMatchObject({ success: true });
        const updated = await prisma.savings_goal.findUniqueOrThrow({ where: { id: goal.id } });
        expect(updated.name).toBe("Horno Industrial");
    });

    it("contributions accumulate and auto-complete the goal", async () => {
        loginAs("ADMIN", adminId);
        const goal = await prisma.savings_goal.findFirstOrThrow({ where: { name: "Horno Industrial" } });

        expect(await addContribution(goal.id, 15000, "primer abono")).toMatchObject({ success: true });
        const first = await getGoalsWithProgress();
        if (!first.success) throw new Error(first.error);
        let progress = first.data.items.find((g) => g.id === goal.id)!;
        expect(progress.currentAmount).toBe(15000);
        expect(progress.status).toBe("ACTIVE");

        expect(await addContribution(goal.id, 6000)).toMatchObject({ success: true });
        const completed = await getGoalsWithProgress({ filters: { status: "inactive" } });
        if (!completed.success) throw new Error(completed.error);
        progress = completed.data.items.find((g) => g.id === goal.id)!;
        expect(progress.currentAmount).toBe(21000);
        expect(progress.status).toBe("COMPLETED");
    });

    it("cancelGoal marks the goal cancelled keeping its history", async () => {
        loginAs("ADMIN", adminId);
        const goal = await prisma.savings_goal.create({ data: { name: "Meta cancelable", targetAmountCents: 50000 } });

        expect(await cancelGoal(goal.id)).toMatchObject({ success: true });
        const row = await prisma.savings_goal.findUniqueOrThrow({ where: { id: goal.id } });
        expect(row.status).toBe("CANCELLED");
        expect(await prisma.goal_contribution.count({ where: { goalId: goal.id } })).toBe(0);
    });

    it("fails movements when no jornada is open", async () => {
        loginAs("ADMIN", adminId);
        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "CLOSED" } });

        expect(await saveMovement(1000, "DEPOSIT")).toMatchObject({ success: false, error: "NO_OPEN_JORNADA" });

        await prisma.jornada.update({ where: { id: jornadaId }, data: { status: "OPEN" } });
    });

    it("read actions are empty without a session", async () => {
        logout();
        expect(await getPoolBalance()).toEqual({ balance: 0, deposited: 0, withdrawn: 0 });
        expect(await getRecentMovements()).toEqual({ success: false, error: "UNAUTHENTICATED" });
        expect(await getGoalsWithProgress()).toEqual({ success: false, error: "UNAUTHENTICATED" });
    });
});
