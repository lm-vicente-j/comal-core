import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { createInitialOwner as submitInitialOwner, getSetupStatus } from "@/lib/actions/setup";
import { resetDb } from "./helpers";

function createInitialOwner(input: Record<string, string>) {
    const form = new FormData();
    for (const [key, value] of Object.entries(input)) form.set(key, value);
    return submitInitialOwner(form);
}

const owner = () => ({
    name: "Installation Owner", email: "owner@setup.test", password: "long-owner-password",
    confirmPassword: "long-owner-password", installSecret: process.env.INSTALLATION_SECRET!,
});

beforeEach(async () => {
    await resetDb();
    // Only this bootstrap suite deliberately simulates an untouched installation.
    await prisma.installationState.upsert({ where: { id: 1 }, create: { id: 1 }, update: { initializedAt: null } });
});

describe("first-owner bootstrap security", () => {
    it("creates one active owner, hashes the password, and permanently closes setup", async () => {
        expect(await getSetupStatus()).toEqual({ available: true });
        expect(await createInitialOwner(owner())).toMatchObject({ success: true });
        const user = await prisma.users.findFirstOrThrow();
        expect(user).toMatchObject({ role: "ADMIN", active: true, email: "owner@setup.test", pin: null });
        expect(await bcrypt.compare(owner().password, user.password!)).toBe(true);
        expect(await getSetupStatus()).toEqual({ available: false });
        await prisma.users.deleteMany();
        expect(await getSetupStatus()).toEqual({ available: false });
        expect(await createInitialOwner(owner())).toMatchObject({ success: false });
        expect(await prisma.securityAudit.count({ where: { action: "INITIAL_OWNER_CREATED" } })).toBe(1);
    });

    it("serializes concurrent creation attempts", async () => {
        const results = await Promise.all(Array.from({ length: 3 }, () => createInitialOwner(owner())));
        expect(results.filter(result => result.success)).toHaveLength(1);
        expect(await prisma.users.count({ where: { role: "ADMIN" } })).toBe(1);
        expect(await prisma.installationState.findUniqueOrThrow({ where: { id: 1 } })).toHaveProperty("initializedAt", expect.any(Date));
    });

    it("rejects invalid secrets, short passwords, mismatched confirmation and bcrypt overflow without data changes", async () => {
        for (const input of [
            { ...owner(), installSecret: "incorrect" },
            { ...owner(), password: "short", confirmPassword: "short" },
            { ...owner(), confirmPassword: "different-long-password" },
            { ...owner(), password: "😀".repeat(19), confirmPassword: "😀".repeat(19) },
        ]) expect(await createInitialOwner(input)).toMatchObject({ success: false });
        expect(await prisma.users.count()).toBe(0);
        expect((await prisma.installationState.findUniqueOrThrow({ where: { id: 1 } })).initializedAt).toBeNull();
    });

    it("requires the migration-created marker", async () => {
        await prisma.installationState.deleteMany();
        expect(await getSetupStatus()).toEqual({ available: false });
        expect(await createInitialOwner(owner())).toMatchObject({ success: false });
        expect(await prisma.users.count()).toBe(0);
    });

    it("refuses a populated installation even with no users", async () => {
        await prisma.supplies.create({ data: { name: "Existing supply", measureUnit: "kg", currentStockMilliunits: 1000 } });
        expect(await getSetupStatus()).toEqual({ available: false });
        expect(await createInitialOwner(owner())).toMatchObject({ success: false });
        expect(await prisma.users.count()).toBe(0);
    });

    it("enforces owner uniqueness in PostgreSQL independently of the application", async () => {
        expect(await createInitialOwner(owner())).toMatchObject({ success: true });
        await expect(prisma.users.create({ data: { role: "ADMIN", name: "Second owner", active: true } })).rejects.toThrow();
        expect(await prisma.users.count({ where: { role: "ADMIN" } })).toBe(1);
    });
});
