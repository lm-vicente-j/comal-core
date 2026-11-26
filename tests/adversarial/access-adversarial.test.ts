import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const browser = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock("@/lib/auth", async () => ({ auth: (await import("../helpers/database")).authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
    cookies: async () => ({
        get: (name: string) => browser.cookies.has(name) ? { value: browser.cookies.get(name)! } : undefined,
        set: (name: string, value: string) => { browser.cookies.set(name, value); },
        delete: (name: string) => { browser.cookies.delete(name); },
    }),
    headers: async () => new Headers({ "x-forwarded-for": "127.0.0.1" }),
}));
import prisma from "@/lib/prisma";
import { getSetupStatus, createInitialOwner } from "@/lib/actions/setup";
import { requestTerminalLink, approveTerminalRequest, getTerminalLinkStatus } from "@/lib/actions/terminal";
import { loginAs, resetDb, seedBase } from "../helpers/database";
import { sha256 } from "@/lib/auth-crypto";

const incompleteMigration = "test_incomplete_access_migration";
beforeEach(async () => {
    browser.cookies.clear();
    await resetDb();
});
afterEach(async () => {
    await prisma.$executeRaw`DELETE FROM "_prisma_migrations" WHERE migration_name = ${incompleteMigration}`;
});

describe("adversarial access regressions", () => {
    it("deduplicates pending links and limits new browsers on one IP until the persisted window expires", async () => {
        const first = await requestTerminalLink();
        expect(first.success).toBe(true);
        expect(await requestTerminalLink()).toEqual(first);
        expect(await prisma.terminalRequest.count()).toBe(1);
        const rateKey = `terminal-request:${await sha256("127.0.0.1")}`;
        expect((await prisma.authRateLimit.findUniqueOrThrow({ where: { key: rateKey } })).attempts).toBe(1);
        for (let index = 0; index < 3; index++) {
            browser.cookies.clear();
            expect(await requestTerminalLink()).toMatchObject({ success: true });
        }
        browser.cookies.clear();
        expect(await requestTerminalLink()).toMatchObject({ success: false, error: "Too many terminal requests; try again later" });
        expect(await prisma.terminalRequest.count()).toBe(4);
        expect(await requestTerminalLink()).toMatchObject({ success: false });
        await prisma.authRateLimit.update({ where: { key: rateKey }, data: { windowEnds: new Date(Date.now() - 1) } });
        expect(await requestTerminalLink()).toMatchObject({ success: true });
        expect(await prisma.terminalRequest.count()).toBe(5);
        expect((await prisma.authRateLimit.findUniqueOrThrow({ where: { key: rateKey } })).attempts).toBe(1);
    });

    it("refuses direct bootstrap calls while any migration is incomplete", async () => {
        await prisma.installationState.update({ where: { id: 1 }, data: { initializedAt: null } });
        await prisma.$executeRaw`INSERT INTO "_prisma_migrations" (id, checksum, migration_name, started_at, applied_steps_count)
            VALUES ('11c47100-cb53-4fe6-9000-000000000001', ${"0".repeat(64)}, ${incompleteMigration}, NOW(), 0)`;
        expect(await getSetupStatus()).toEqual({ available: false });
        const form = new FormData();
        for (const [key, value] of Object.entries({ name: "Migration Owner", email: "migration@owner.test", password: "migration-owner-password", confirmPassword: "migration-owner-password", installSecret: process.env.INSTALLATION_SECRET! })) form.set(key, value);
        expect(await createInitialOwner(form)).toMatchObject({ success: false });
        expect(await prisma.users.count()).toBe(0);
    });

    it("does not revoke an already authorized browser when an old link poll is replayed after its TTL", async () => {
        const { admin } = await seedBase();
        loginAs("ADMIN", admin.id);
        const request = await requestTerminalLink();
        if (!request.success) throw new Error(request.error);
        const requestCookie = browser.cookies.get("comal_terminal_request")!;
        expect(await approveTerminalRequest(request.data.requestId, "Approved counter", "FIXED")).toMatchObject({ success: true });
        const approved = await getTerminalLinkStatus(request.data.requestId);
        expect(approved).toMatchObject({ success: true, data: { status: "APPROVED" } });
        const terminal = await prisma.terminal.findFirstOrThrow();
        await prisma.terminalRequest.update({ where: { id: request.data.requestId }, data: { expiresAt: new Date(Date.now() - 1) } });
        browser.cookies.set("comal_terminal_request", requestCookie);
        await getTerminalLinkStatus(request.data.requestId);
        expect((await prisma.terminal.findUniqueOrThrow({ where: { id: terminal.id } })).active).toBe(true);
    });
});
