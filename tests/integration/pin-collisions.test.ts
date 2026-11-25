import { beforeEach, describe, expect, it, vi } from "vitest";
const candidates = vi.hoisted(() => ({ values: [] as number[] }));
vi.mock("node:crypto", async (original) => {
    const crypto = await original<typeof import("node:crypto")>();
    return { ...crypto, randomInt: (...args: [number, number]) => candidates.values.shift() ?? crypto.randomInt(...args) };
});
import prisma from "@/lib/prisma";
import { generateUniqueStaffPin } from "@/lib/auth-credentials";
import { createPinLookupHash } from "@/lib/auth-crypto";
import { resetDb } from "./helpers";

beforeEach(async () => { candidates.values = []; await resetDb(); });
describe("PIN lookup collision handling", () => {
    it("retries a collision with an inactive account and retains database uniqueness", async () => {
        await prisma.users.create({ data: { name: "Inactive Person", role: "STAFF", active: false, pinLookupHash: createPinLookupHash("111111") } });
        candidates.values = [111111, 222222];
        expect(await generateUniqueStaffPin()).toBe("222222");
        expect(candidates.values).toEqual([]);
        await expect(prisma.users.create({ data: { role: "SUPERVISOR", pinLookupHash: createPinLookupHash("111111") } })).rejects.toThrow();
        expect(await prisma.users.count()).toBe(1);
    });
});
