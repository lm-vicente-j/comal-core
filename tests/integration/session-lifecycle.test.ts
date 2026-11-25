import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { JWT } from "next-auth/jwt";

const state = vi.hoisted(() => ({ token: "" }));
vi.mock("@/lib/auth", async () => ({ auth: (await import("./helpers")).authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => state.token ? { value: state.token } : undefined }) }));

import prisma from "@/lib/prisma";
import { authConfig, AUTH_SESSION_MAX_AGE } from "@/app/auth.config";
import { authorizeCredentials } from "@/lib/auth-credentials";
import { createPinLookupHash, sha256 } from "@/lib/auth-crypto";
import { regenerateStaffPin, saveUser } from "@/lib/actions/users";
import { updateTerminal, revokeTerminal } from "@/lib/actions/terminal";
import { loginAs, resetDb, seedBase } from "./helpers";

const refresh = (token: JWT, user?: unknown) => authConfig.callbacks.jwt({ token, ...(user ? { user } : {}) } as Parameters<typeof authConfig.callbacks.jwt>[0]);

describe("live session invalidation and absolute expiry", () => {
    let staffId: number;
    let terminalId: string;
    beforeEach(async () => {
        vi.restoreAllMocks();
        state.token = "b".repeat(64);
        await resetDb();
        const { admin } = await seedBase();
        loginAs("ADMIN", admin.id);
        const staff = await prisma.users.create({ data: {
            name: "Session Staff Person", username: "SESSION1", role: "STAFF", active: true,
            pin: await bcrypt.hash("378264", 10), pinLookupHash: createPinLookupHash("378264"),
        } });
        staffId = staff.id;
        const terminal = await prisma.terminal.create({ data: { name: "Session counter", type: "FIXED", tokenHash: await sha256(state.token) } });
        terminalId = terminal.id;
    });

    async function authenticate() {
        const user = await authorizeCredentials({ authMode: "FIXED_PIN", pin: "378264" });
        expect(user).not.toBeNull();
        const token = await refresh({}, user);
        expect(token).not.toBeNull();
        return token!;
    }

    it("preserves authentication time and enforces an eight-hour lifetime despite refreshes", async () => {
        const token = await authenticate();
        const authenticatedAt = token.authenticatedAt!;
        const clock = vi.spyOn(Date, "now").mockReturnValue(authenticatedAt + 7 * 60 * 60 * 1000);
        const refreshed = await refresh(token);
        expect(refreshed?.authenticatedAt).toBe(authenticatedAt);
        clock.mockReturnValue(authenticatedAt + AUTH_SESSION_MAX_AGE * 1000 + 1);
        expect(await refresh(refreshed!)).toBeNull();
        clock.mockRestore();
    });

    it("rejects malformed modes, timestamps and terminal cookies", async () => {
        const token = await authenticate();
        expect(await refresh({ ...token, authMode: "INVALID" as never })).toBeNull();
        expect(await refresh({ ...token, authenticatedAt: Number.NaN })).toBeNull();
        expect(await refresh({ ...token, authenticatedAt: Date.now() + 120_000 })).toBeNull();
        state.token = "tampered";
        expect(await refresh(token)).toBeNull();
        state.token = "";
        expect(await refresh(token)).toBeNull();
    });

    it("invalidates old sessions after terminal type changes even when the original type is restored", async () => {
        const token = await authenticate();
        expect(await updateTerminal(terminalId, { type: "MOBILE" })).toMatchObject({ success: true });
        expect(await updateTerminal(terminalId, { type: "FIXED" })).toMatchObject({ success: true });
        expect(await refresh(token)).toBeNull();
        expect(await revokeTerminal(terminalId)).toMatchObject({ success: true });
        expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "378264" })).toBeNull();
    });

    it("invalidates an existing session after PIN regeneration", async () => {
        const token = await authenticate();
        const result = await regenerateStaffPin(staffId);
        expect(result.success).toBe(true);
        expect(await refresh(token)).toBeNull();
        expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "378264" })).toBeNull();
        if (result.success) expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: result.data.pin })).toMatchObject({ id: String(staffId) });
    });

    it("revokes a valid device session without requiring a type change", async () => {
        const token = await authenticate();
        expect(await refresh(token)).not.toBeNull();
        expect(await revokeTerminal(terminalId)).toMatchObject({ success: true });
        expect(await refresh(token)).toBeNull();
        expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "378264" })).toBeNull();
    });

    it("invalidates sessions after role changes and account deactivation", async () => {
        const token = await authenticate();
        expect(await saveUser({ id: staffId, role: "SUPERVISOR" })).toMatchObject({ success: true });
        expect(await refresh(token)).toBeNull();
        const newToken = await authenticate();
        expect(newToken.role).toBe("SUPERVISOR");
        expect(await saveUser({ id: staffId, active: false })).toMatchObject({ success: true });
        expect(await refresh(newToken)).toBeNull();
        expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "378264" })).toBeNull();
    });

    it("rejects unknown persisted account roles instead of granting staff access", async () => {
        const token = await authenticate();
        await prisma.users.update({ where: { id: staffId }, data: { role: "UNKNOWN" } });
        expect(await refresh(token)).toBeNull();
        expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "378264" })).toBeNull();
    });
    it("keeps the operator signed in when only a device's display name changes", async () => {
        const token = await authenticate();
        expect(await updateTerminal(terminalId, { name: "Renamed counter" })).toMatchObject({ success: true });
        expect(await refresh(token)).not.toBeNull();
    });

});
