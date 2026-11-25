import { beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { recoverOwnerCredentials } from "@/lib/owner-recovery";
import { resetDb, seedBase } from "./helpers";

beforeEach(async () => {
  await resetDb();
  await prisma.installationState.upsert({ where: { id: 1 }, create: { id: 1, initializedAt: new Date() }, update: { initializedAt: new Date() } });
});

describe("owner recovery maintenance", () => {
  it("updates only the existing owner, bumps credential version, audits and preserves initialized state", async () => {
    const { admin } = await seedBase();
    const previous = await prisma.users.update({ where: { id: admin.id }, data: { password: await bcrypt.hash("before-password-123", 12) } });
    const markerBefore = await prisma.installationState.findUniqueOrThrow({ where: { id: 1 } });
    expect(await recoverOwnerCredentials(admin.email!, "replacement-password-456")).toBe(true);
    const owner = await prisma.users.findUniqueOrThrow({ where: { id: admin.id } });
    expect(owner.role).toBe("ADMIN");
    expect(owner.credentialVersion).toBe(previous.credentialVersion + 1);
    expect(await bcrypt.compare("replacement-password-456", owner.password!)).toBe(true);
    expect(await prisma.users.count()).toBe(1);
    expect(await prisma.installationState.findUniqueOrThrow({ where: { id: 1 } })).toEqual(markerBefore);
    expect(await prisma.securityAudit.count({ where: { action: "OWNER_CREDENTIALS_RECOVERED", actorId: admin.id } })).toBe(1);
  });

  it("cannot create an owner, recover with wrong identity or proceed without initialized marker", async () => {
    const { admin } = await seedBase();
    expect(await recoverOwnerCredentials("different@test.local", "replacement-password-456")).toBe(false);
    expect(await prisma.users.count({ where: { role: "ADMIN" } })).toBe(1);
    await prisma.installationState.update({ where: { id: 1 }, data: { initializedAt: null } });
    expect(await recoverOwnerCredentials(admin.email!, "replacement-password-456")).toBe(false);
    expect(await prisma.users.count({ where: { role: "ADMIN" } })).toBe(1);
  });
});
