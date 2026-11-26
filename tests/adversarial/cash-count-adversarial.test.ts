import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async () => {
    const { authMock } = await import("../helpers/database");
    return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { openJornada } from "@/lib/actions/jornada";
import { loginAs, makeCashCountInput, resetDb } from "../helpers/database";

describe("cash count adversarial regressions", () => {
    beforeEach(async () => {
        await resetDb();
        const admin = await prisma.users.create({
            data: { name: "Count audit owner", role: "ADMIN", active: true },
        });
        loginAs("ADMIN", admin.id);
    });

    it("replays an identical opening when the UUID uses equivalent uppercase hex", async () => {
        const input = {
            ...makeCashCountInput(50000),
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        };
        const first = await openJornada(input);
        expect(first.success).toBe(true);
        if (!first.success) throw new Error(first.error);
        const retry = await openJornada({ ...input, requestId: input.requestId.toUpperCase() });
        expect(retry).toMatchObject({
            success: true,
            data: {
                id: first.data.id,
                jornadaId: first.data.jornadaId,
                cutoffAt: first.data.cutoffAt,
                countedAmount: first.data.countedAmount,
            },
        });
        expect(await prisma.jornada.count()).toBe(1);
        expect(await prisma.cash_count.count()).toBe(1);
    });
});
