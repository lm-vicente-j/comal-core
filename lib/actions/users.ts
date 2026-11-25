"use server";

import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import prisma from "@/lib/prisma";
import type { Prisma } from "@/app/generated/prisma/client";
import { auth } from "@/lib/auth";
import { actionFail, actionOk, type ActionResult } from "@/lib/action-result";
import { UserSchema, type User } from "./schemas";
import { isUserRole } from "@/lib/auth-types";
import { createPinLookupHash, generateUniqueStaffPin } from "@/lib/auth-credentials";
import { createPaginationSchema, escapeListSearch, getPaginationMeta, getPaginationOffset } from "@/lib/pagination";

type StaffRole = "SUPERVISOR" | "STAFF";

async function ownerId(): Promise<number | null> {
  const session = await auth();
  if (session?.user?.role !== "ADMIN" || !session.user.id) return null;
  const id = Number(session.user.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const current = await prisma.users.findUnique({ where: { id }, select: { role: true, active: true } });
  return current?.role === "ADMIN" && current.active !== false ? id : null;
}

function usernameBase(fullname: string): string {
  const words = fullname.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return "";
  const last = words.at(-2)!;
  const secondLast = words.at(-1)!;
  const vowel = last.match(/[AEIOU]/)?.[0] ?? "X";
  return `${last[0]}${vowel}${secondLast[0]}${words[0][0]}`;
}

async function generateUniqueUsername(fullname: string, db: typeof prisma | Prisma.TransactionClient): Promise<string> {
  const prefix = usernameBase(fullname);
  if (!prefix) return "";
  for (let attempt = 0; attempt < 40; attempt++) {
    const username = `${prefix}${String(randomInt(0, 10_000)).padStart(4, "0")}`;
    const exists = await db.users.findFirst({ where: { username: { equals: username, mode: "insensitive" } }, select: { id: true } });
    if (!exists) return username;
  }
  throw new Error("Could not generate a username");
}

export async function GetAllUsers() {
  if (await ownerId() === null) return [];
  try {
    const rows = await prisma.users.findMany({
      where: { role: { in: ["SUPERVISOR", "STAFF"] } },
      select: { id: true, name: true, email: true, username: true, active: true, role: true, password: true, pin: true },
      orderBy: { name: "asc" },
    });
    return rows.map(({ password, pin, ...user }) => ({ ...user, hasPassword: Boolean(password), hasPin: Boolean(pin) }));
  } catch {
    return [];
  }
}

export async function getStaffPage(query: unknown = {}) {
  if (await ownerId() === null) return actionFail("FORBIDDEN");
  const input = createPaginationSchema({ sortFields: ["name", "username", "role", "active"], defaultSort: "name", defaultOrder: "asc" }).safeParse(query);
  if (!input.success) return actionFail("INVALID_INPUT");
  const { search, sort: field = "name", order: direction = "asc" } = input.data;
  const where = {
    role: { in: ["SUPERVISOR", "STAFF"] },
    ...(search ? { OR: [{ name: { contains: escapeListSearch(search), mode: "insensitive" as const } }, { username: { contains: escapeListSearch(search), mode: "insensitive" as const } }] } : {}),
  };
  try {
    return await prisma.$transaction(async (tx) => {
      const total = await tx.users.count({ where });
      const meta = getPaginationMeta(total, input.data);
      const rows = await tx.users.findMany({
        select: { id: true, name: true, email: true, username: true, active: true, role: true, password: true, pin: true },
        where, orderBy: [{ [field]: { sort: direction, nulls: "last" } }, { id: direction }],
        take: meta.pageSize, skip: getPaginationOffset(meta),
      });
      return actionOk({ ...meta, items: rows.map(({ password, pin, ...user }) => ({ ...user, hasPassword: Boolean(password), hasPin: Boolean(pin) })) });
    }, { isolationLevel: "RepeatableRead" });
  } catch {
    return actionFail("QUERY_FAILED");
  }
}

export async function searchUsers(query: string, limit = 20) {
  if (await ownerId() === null || typeof query !== "string") return [];
  const safeLimit = Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 20));
  try {
    return await prisma.users.findMany({
      where: { role: { in: ["SUPERVISOR", "STAFF"] }, ...(query.trim() ? { OR: [
        { name: { contains: query.trim(), mode: "insensitive" } },
        { username: { contains: query.trim(), mode: "insensitive" } },
      ] } : {}) },
      select: { id: true, name: true, username: true, registeredAt: true },
      orderBy: { name: "asc" }, take: safeLimit,
    });
  } catch {
    return [];
  }
}

export async function createStaff(input: { name: string; role: StaffRole; email?: string | null; active?: boolean }): Promise<ActionResult<{ id: number; username: string; pin: string }>> {
  const actorId = await ownerId();
  if (actorId === null) return actionFail("FORBIDDEN");
  const parsed = z.object({
    name: UserSchema.shape.name,
    role: z.enum(["SUPERVISOR", "STAFF"]),
    email: z.string().trim().email().max(150).nullable().optional(),
    active: z.boolean().optional(),
  }).strict().safeParse(input);
  if (!parsed.success) return actionFail("INVALID_INPUT", { fieldErrors: z.flattenError(parsed.error).fieldErrors });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        const email = parsed.data.email?.trim().toLowerCase() || null;
        if (email) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${email}))`;
          const duplicate = await tx.users.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { id: true } });
          if (duplicate) throw new Error("EMAIL_ALREADY_REGISTERED");
        }
        const username = await generateUniqueUsername(parsed.data.name, tx);
        const pin = await generateUniqueStaffPin(tx);
        const pinHash = await bcrypt.hash(pin, 12);
        const pinLookupHash = createPinLookupHash(pin);
        const user = await tx.users.create({ data: {
          name: parsed.data.name,
          username,
          email,
          role: parsed.data.role,
          active: parsed.data.active ?? true,
          pin: pinHash,
          pinLookupHash,
          credentialVersion: 1,
        }, select: { id: true, username: true } });
        await tx.securityAudit.create({ data: { actorId, action: "STAFF_CREATED", subjectId: String(user.id), metadata: { role: parsed.data.role } } });
        return { ...user, username: user.username!, pin };
      });
      revalidatePath("/admin/roster");
      return actionOk(created);
    } catch (error) {
      if (error instanceof Error && error.message === "EMAIL_ALREADY_REGISTERED") return actionFail("Email already registered");
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") continue;
      return actionFail("Could not create staff account");
    }
  }
  return actionFail("Could not generate unique staff credentials");
}

export async function regenerateStaffPin(userId: number): Promise<ActionResult<{ pin: string }>> {
  const actorId = await ownerId();
  if (actorId === null) return actionFail("FORBIDDEN");
  if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2_147_483_647) return actionFail("INVALID_INPUT");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const pin = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        const current = await tx.users.findUnique({ where: { id: userId }, select: { role: true } });
        if (!current || (current.role !== "STAFF" && current.role !== "SUPERVISOR")) return null;
        const newPin = await generateUniqueStaffPin(tx);
        await tx.users.update({ where: { id: userId }, data: {
          pin: await bcrypt.hash(newPin, 12),
          pinLookupHash: createPinLookupHash(newPin),
          credentialVersion: { increment: 1 },
        } });
        await tx.setting.deleteMany({ where: { key: `AUTH_LOCKOUT:${userId}` } });
        await tx.securityAudit.create({ data: { actorId, action: "STAFF_PIN_REGENERATED", subjectId: String(userId) } });
        return newPin;
      });
      if (!pin) return actionFail("Staff account not found");
      revalidatePath("/admin/roster");
      return actionOk({ pin });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") continue;
      return actionFail("Could not regenerate PIN");
    }
  }
  return actionFail("Could not generate unique PIN");
}

export async function saveUser(data: Partial<User>): Promise<ActionResult> {
  const actorId = await ownerId();
  if (actorId === null) return actionFail("FORBIDDEN");
  const parsed = z.object({
    id: z.number().int().positive().max(2_147_483_647),
    name: UserSchema.shape.name.optional(),
    role: z.enum(["SUPERVISOR", "STAFF"]).optional(),
    active: z.boolean().optional(),
  }).strict().safeParse(data);
  if (!parsed.success) return actionFail("INVALID_INPUT", { fieldErrors: z.flattenError(parsed.error).fieldErrors });
  const updates = parsed.data;
  if (updates.name === undefined && updates.role === undefined && updates.active === undefined) return actionFail("No changes provided");
  try {
    const changed = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM users WHERE id = ${updates.id} FOR UPDATE`;
      const current = await tx.users.findUnique({ where: { id: updates.id }, select: { role: true, active: true, name: true } });
      if (!current || !isUserRole(current.role) || current.role === "ADMIN") return false;
      const securityChange = (updates.role !== undefined && updates.role !== current.role) || (updates.active !== undefined && updates.active !== current.active);
      await tx.users.update({ where: { id: updates.id }, data: {
        ...(updates.name !== undefined ? { name: updates.name } : {}),
        ...(updates.role !== undefined ? { role: updates.role } : {}),
        ...(updates.active !== undefined ? { active: updates.active } : {}),
        ...(securityChange ? { credentialVersion: { increment: 1 } } : {}),
      } });
      await tx.securityAudit.create({ data: { actorId, action: "STAFF_UPDATED", subjectId: String(updates.id), metadata: { name: updates.name, role: updates.role, active: updates.active } } });
      return true;
    });
    if (!changed) return actionFail("Staff account not found or protected");
    revalidatePath("/admin/roster");
    return actionOk();
  } catch {
    return actionFail("Could not update staff account");
  }
}
