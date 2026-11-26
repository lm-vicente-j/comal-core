import { beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";

vi.mock("@/lib/auth", async () => {
  const { authMock } = await import("../helpers/database");
  return { auth: authMock };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import prisma from "@/lib/prisma";
import { createPinLookupHash } from "@/lib/auth-crypto";
import { createStaff, GetAllUsers, regenerateStaffPin, saveUser } from "@/lib/actions/users";
import { loginAs, logout, resetDb, seedBase } from "../helpers/database";

describe("staff administration", () => {
  let ownerId: number;

  beforeEach(async () => {
    await resetDb();
    const base = await seedBase();
    ownerId = base.admin.id;
    loginAs("ADMIN", ownerId);
  });

  it("creates a staff account with generated, indexed six digit PIN", async () => {
    const result = await createStaff({ name: "Maria Lopez Garcia", role: "STAFF" });
    expect(result).toMatchObject({ success: true, data: { pin: expect.stringMatching(/^\d{6}$/), username: expect.any(String) } });
    if (!result.success) return;
    const user = await prisma.users.findUniqueOrThrow({ where: { id: result.data.id } });
    expect(user.role).toBe("STAFF");
    expect(user.pinLookupHash).toBe(createPinLookupHash(result.data.pin));
    expect(await bcrypt.compare(result.data.pin, user.pin!)).toBe(true);
    expect(result.data.pin).not.toBe(user.pin);
  });

  it("generates globally unique PINs even when prior account is inactive", async () => {
    const first = await createStaff({ name: "Staff User One", role: "STAFF", active: false });
    const second = await createStaff({ name: "Staff User Two", role: "SUPERVISOR" });
    expect(first.success && second.success).toBe(true);
    if (first.success && second.success) expect(first.data.pin).not.toBe(second.data.pin);
    expect(await prisma.users.count({ where: { pinLookupHash: first.success ? createPinLookupHash(first.data.pin) : "" } })).toBe(1);
  });

  it("rejects case-insensitive duplicate staff email addresses", async () => {
    expect(await createStaff({ name: "Staff User One", role: "STAFF", email: "Person@example.test" })).toMatchObject({ success: true });
    expect(await createStaff({ name: "Staff User Two", role: "STAFF", email: "person@EXAMPLE.test" })).toMatchObject({ success: false });
    expect(await prisma.users.count()).toBe(2);
  });

  it("regenerates the PIN once and invalidates the prior credential version", async () => {
    const created = await createStaff({ name: "Staff User One", role: "SUPERVISOR" });
    if (!created.success) throw new Error("createStaff failed");
    const before = await prisma.users.findUniqueOrThrow({ where: { id: created.data.id } });
    const result = await regenerateStaffPin(created.data.id);
    expect(result).toMatchObject({ success: true, data: { pin: expect.stringMatching(/^\d{6}$/) } });
    if (!result.success) return;
    const after = await prisma.users.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(after.credentialVersion).toBe(before.credentialVersion + 1);
    expect(after.pinLookupHash).toBe(createPinLookupHash(result.data.pin));
    expect(result.data.pin).not.toBe(created.data.pin);
  });

  it("allows role changes and deactivation only for staff and increments credential versions", async () => {
    const created = await createStaff({ name: "Staff User One", role: "STAFF" });
    if (!created.success) throw new Error("createStaff failed");
    const original = await prisma.users.findUniqueOrThrow({ where: { id: created.data.id } });
    expect(await saveUser({ id: created.data.id, role: "SUPERVISOR" })).toMatchObject({ success: true });
    expect(await saveUser({ id: created.data.id, active: false })).toMatchObject({ success: true });
    expect(await prisma.users.findUniqueOrThrow({ where: { id: created.data.id } })).toMatchObject({
      role: "SUPERVISOR", active: false, credentialVersion: original.credentialVersion + 2,
    });
  });

  it("does not allow normal staff management to alter or remove the owner", async () => {
    expect(await saveUser({ id: ownerId, active: false })).toMatchObject({ success: false });
    expect(await saveUser({ id: ownerId, role: "STAFF" })).toMatchObject({ success: false });
    expect(await prisma.users.findUniqueOrThrow({ where: { id: ownerId } })).toMatchObject({ role: "ADMIN", active: true });
    expect(await prisma.users.count({ where: { role: "ADMIN" } })).toBe(1);
  });

  it("returns staff directory entries without credential hashes and excludes the owner", async () => {
    const created = await createStaff({ name: "Staff User One", role: "STAFF" });
    expect(created.success).toBe(true);
    const users = await GetAllUsers();
    expect(users).toHaveLength(1);
    expect(users[0]).not.toHaveProperty("password");
    expect(users[0]).not.toHaveProperty("pin");
    expect(users[0].hasPin).toBe(true);
  });

  it("rejects management without an active owner session", async () => {
    logout();
    expect(await createStaff({ name: "Staff User One", role: "STAFF" })).toMatchObject({ success: false });
    expect(await prisma.users.count()).toBe(1);
  });

  it("rejects unknown roles and invalid identifiers", async () => {
    expect(await createStaff({ name: "Staff User One", role: "ADMIN" as never })).toMatchObject({ success: false });
    expect(await saveUser({ id: 2_147_483_648, active: false })).toMatchObject({ success: false });
  });
});
