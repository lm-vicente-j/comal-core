import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

const cookieState = vi.hoisted(() => ({ terminalToken: "" }));
vi.mock("@/lib/auth", async () => {
  const { authMock } = await import("../helpers/database");
  return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => name === "comal_terminal" && cookieState.terminalToken ? { value: cookieState.terminalToken } : undefined,
  }),
}));

import prisma from "@/lib/prisma";
import { authorizeCredentials } from "@/lib/auth-credentials";
import { getBrowserTerminalAccess } from "@/lib/actions/terminal";
import { createPinLookupHash, sha256 } from "@/lib/auth-crypto";
import { readAccountAttempts, MAX_FAILED_ATTEMPTS } from "@/lib/auth-lockout";
import { loginAs, resetDb, seedBase } from "../helpers/database";

describe("credential authentication security", () => {
  let ownerId: number;
  let staffId: number;
  const terminalToken = "a".repeat(64);

  beforeEach(async () => {
    cookieState.terminalToken = "";
    await resetDb();
    const base = await seedBase();
    ownerId = base.admin.id;
    await prisma.users.update({ where: { id: ownerId }, data: { password: await bcrypt.hash("owner-password-123", 12) } });
    loginAs("ADMIN", ownerId);
    await prisma.terminal.create({ data: { name: "Front counter", type: "MOBILE", tokenHash: await sha256(terminalToken) } });
    const pin = "042681";
    const staff = await prisma.users.create({ data: {
      name: "Staff Example Person", username: "staff-example", role: "STAFF", active: true,
      pin: await bcrypt.hash(pin, 12), pinLookupHash: createPinLookupHash(pin),
    } });
    staffId = staff.id;
  });

  afterEach(() => { cookieState.terminalToken = ""; });

  it("reports only the active terminal type tied to this browser's cookie", async () => {
    expect(await getBrowserTerminalAccess()).toEqual({ success: true, data: { type: null } });
    cookieState.terminalToken = "b".repeat(64);
    expect(await getBrowserTerminalAccess()).toEqual({ success: true, data: { type: null } });
    cookieState.terminalToken = terminalToken;
    expect(await getBrowserTerminalAccess()).toEqual({ success: true, data: { type: "MOBILE" } });
    const terminal = await prisma.terminal.findFirstOrThrow();
    await prisma.terminal.update({ where: { id: terminal.id }, data: { type: "FIXED" } });
    expect(await getBrowserTerminalAccess()).toEqual({ success: true, data: { type: "FIXED" } });
    await prisma.terminal.update({ where: { id: terminal.id }, data: { active: false } });
    expect(await getBrowserTerminalAccess()).toEqual({ success: true, data: { type: null } });
  });

  it("accepts owner email and password while rejecting unknown roles", async () => {
    expect(await authorizeCredentials({ authMode: "OWNER_PASSWORD", email: "ADMIN@test.local", password: "owner-password-123" }))
      .toMatchObject({ id: String(ownerId), role: "ADMIN", authMode: "OWNER_PASSWORD" });
    expect(await authorizeCredentials({ role: "UNRECOGNIZED", email: "admin@test.local", password: "owner-password-123" })).toBeNull();
    expect(await authorizeCredentials({ authMode: "OWNER_PASSWORD", email: "staff-example", password: "owner-password-123" })).toBeNull();
  });

  it("requires an authorized matching mobile terminal and authenticates the individual PIN", async () => {
    expect(await authorizeCredentials({ authMode: "MOBILE_PIN", username: "staff-example", pin: "042681" })).toBeNull();
    cookieState.terminalToken = terminalToken;
    expect(await authorizeCredentials({ authMode: "MOBILE_PIN", username: "staff-example", pin: "042681" }))
      .toMatchObject({ id: String(staffId), role: "STAFF", authMode: "MOBILE_PIN", terminalId: expect.any(String) });
  });

  it("persists and enforces the account lock after five wrong mobile PINs", async () => {
    cookieState.terminalToken = terminalToken;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect(await authorizeCredentials({ authMode: "MOBILE_PIN", username: "staff-example", pin: "999999" })).toBeNull();
    }
    expect((await readAccountAttempts(staffId))?.lockedUntil).toBeGreaterThan(Date.now());
    expect(await authorizeCredentials({ authMode: "MOBILE_PIN", username: "staff-example", pin: "042681" })).toBeNull();
  });

  it("clears a persisted account lockout after successful authentication", async () => {
    cookieState.terminalToken = terminalToken;
    for (let i = 0; i < 3; i++) await authorizeCredentials({ authMode: "MOBILE_PIN", username: "staff-example", pin: "999999" });
    expect(await readAccountAttempts(staffId)).toMatchObject({ attempts: 3, lockedUntil: null });
    expect(await authorizeCredentials({ authMode: "MOBILE_PIN", username: "staff-example", pin: "042681" })).not.toBeNull();
    expect(await readAccountAttempts(staffId)).toBeNull();
  });

  it("rejects fixed terminal mode on a mobile terminal", async () => {
    cookieState.terminalToken = terminalToken;
    expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "042681" })).toBeNull();
  });
  it("serializes concurrent mobile failures and persists the five-attempt lock", async () => {
    cookieState.terminalToken = terminalToken;
    const attempts = await Promise.all(Array.from({ length: 5 }, () => authorizeCredentials({ authMode: "MOBILE_PIN", username: "staff-example", pin: "999999" })));
    expect(attempts).toEqual(Array(5).fill(null));
    expect(await readAccountAttempts(staffId)).toMatchObject({ attempts: 5, lockedUntil: expect.any(Number) });
    expect(await authorizeCredentials({ authMode: "MOBILE_PIN", username: "staff-example", pin: "042681" })).toBeNull();
  });

  it("persists fixed-device lockouts even when a PIN identifies no account", async () => {
    cookieState.terminalToken = terminalToken;
    const terminal = await prisma.terminal.findFirstOrThrow();
    await prisma.terminal.update({ where: { id: terminal.id }, data: { type: "FIXED" } });
    for (let index = 0; index < 5; index++) expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "999999" })).toBeNull();
    const lock = await prisma.authRateLimit.findUniqueOrThrow({ where: { key: `terminal-pin:${terminal.id}` } });
    expect(lock.attempts).toBe(5);
    expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "042681" })).toBeNull();
    await prisma.authRateLimit.update({ where: { key: lock.key }, data: { windowEnds: new Date(Date.now() - 1) } });
    expect(await authorizeCredentials({ authMode: "FIXED_PIN", pin: "042681" })).toMatchObject({ id: String(staffId) });
  });

  it("rejects password suffixes beyond the bcrypt byte limit", async () => {
    await prisma.users.update({ where: { id: ownerId }, data: { password: await bcrypt.hash("a".repeat(72), 10) } });
    expect(await authorizeCredentials({ authMode: "OWNER_PASSWORD", email: "admin@test.local", password: "a".repeat(72) + "wrong" })).toBeNull();
  });

});
