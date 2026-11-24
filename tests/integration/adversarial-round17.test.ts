import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("./helpers");
    return {
        auth: authMock,
        signIn: vi.fn(),
        signOut: vi.fn(),
    };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { revalidatePath } from "next/cache";
import prisma from "@/lib/prisma";
import { loginAs, resetDb, seedBase } from "./helpers";
import {
    closeJornada,
    getActiveJornadaWithStats,
    openJornada,
} from "@/lib/actions/jornada";
import {
    getPoolBalance,
    saveGoal,
    saveMovement,
} from "@/lib/actions/savings";

describe("Adversarial Round 17 — Jornada and Savings Guarantees", () => {
    let adminId: number;
    let jornadaId: number;

    beforeEach(async () => {
        await resetDb();
        const { admin, jornada } = await seedBase();
        adminId = admin.id;
        jornadaId = jornada.id;
        loginAs("ADMIN", adminId);
        vi.mocked(revalidatePath).mockClear();
    });

    it("R17-1a: saveMovement rejects deposits that push cumulative pool deposits above MAX_SAFE_INTEGER", async () => {
        const priorJornada = await prisma.jornada.create({
            data: {
                openedBy: adminId,
                closedBy: adminId,
                openingAmountCents: 0,
                status: "CLOSED",
                closedAt: new Date(),
            },
        });

        await prisma.savings_movement.create({
            data: {
                amountCents: BigInt("9000000000000000"),
                type: "DEPOSIT",
                registered_by: adminId,
                jornadaId: priorJornada.id,
            },
        });

        const res = await saveMovement(100_000_000_000_000, "DEPOSIT", "Pool limit deposit");
        expect(res.success).toBe(false);

        const pool = await getPoolBalance();
        expect(pool.deposited).toBe(9_000_000_000_000_000);

        const withdrawRes = await saveMovement(1, "WITHDRAW", "Post-limit withdrawal");
        expect(withdrawRes.success).toBe(true);
    });

    it("R17-1b: saveMovement rejects deposits that push the active jornada expectedCash below MIN_SAFE_INTEGER", async () => {
        await prisma.jornada.update({
            where: { id: jornadaId },
            data: { openingAmountCents: 0 },
        });

        await prisma.bill.create({
            data: {
                description: "Large cash expense",
                amountCents: BigInt("8950000000000000"),
                category: "Otros",
                date: new Date(),
                registered_by: adminId,
                payment_method: "CASH",
                jornadaId,
            },
        });

        const res = await saveMovement(100_000_000_000_000, "DEPOSIT", "Jornada underflow deposit");
        expect(res.success).toBe(false);

        await expect(getActiveJornadaWithStats()).resolves.toBeDefined();
        const closeRes = await closeJornada(jornadaId, 0);
        expect(closeRes.success).toBe(true);
    });

    it("R17-2: saveGoal rejects or preserves the calendar date for rollover and offset deadline strings", async () => {
        const cases: Array<{ name: string; input: string; expectedDate: string }> = [
            {
                name: "Rollover Hour Deadline",
                input: "2026-06-15T24:00:00Z",
                expectedDate: "2026-06-15",
            },
            {
                name: "Offset ISO Deadline",
                input: "2026-05-01T00:00:00+02:00",
                expectedDate: "2026-05-01",
            },
            {
                name: "GMT Suffix Deadline",
                input: "2026-05-01 GMT+0500",
                expectedDate: "2026-05-01",
            },
        ];

        for (const testCase of cases) {
            const res = await saveGoal({
                name: testCase.name,
                targetAmount: 10000,
                deadline: testCase.input as unknown as Date,
            });
            if (res.success) {
                const goal = await prisma.savings_goal.findFirstOrThrow({
                    where: { name: testCase.name },
                });
                expect(goal.deadline?.toISOString().slice(0, 10)).toBe(testCase.expectedDate);
            } else {
                expect(res.success).toBe(false);
            }
        }
    });

    it("R17-3a: openJornada and closeJornada revalidate the dashboard layout and shift-dependent routes", async () => {
        vi.mocked(revalidatePath).mockClear();
        const closeRes = await closeJornada(jornadaId, 50000);
        expect(closeRes.success).toBe(true);

        expect(revalidatePath).toHaveBeenCalledWith("/admin/jornada");
        expect(revalidatePath).toHaveBeenCalledWith("/(dashboard)", "layout");
        expect(revalidatePath).toHaveBeenCalledWith("/pos");
        expect(revalidatePath).toHaveBeenCalledWith("/debtors");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/savings");

        vi.mocked(revalidatePath).mockClear();
        const openRes = await openJornada(50000);
        expect(openRes.success).toBe(true);

        expect(revalidatePath).toHaveBeenCalledWith("/admin/jornada");
        expect(revalidatePath).toHaveBeenCalledWith("/(dashboard)", "layout");
        expect(revalidatePath).toHaveBeenCalledWith("/pos");
        expect(revalidatePath).toHaveBeenCalledWith("/debtors");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/savings");
    });

    it("R17-3b: saveMovement revalidates /admin/jornada alongside /admin/savings and the dashboard layout", async () => {
        vi.mocked(revalidatePath).mockClear();
        const res = await saveMovement(5000, "DEPOSIT", "Drawer transfer");
        expect(res.success).toBe(true);

        expect(revalidatePath).toHaveBeenCalledWith("/admin/savings");
        expect(revalidatePath).toHaveBeenCalledWith("/(dashboard)", "layout");
        expect(revalidatePath).toHaveBeenCalledWith("/admin/jornada");
    });
});
