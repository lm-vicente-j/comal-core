// lib/auth-credentials.ts
import { z } from "zod";
import bcrypt from "bcryptjs";
import prisma from "./prisma";
import { normalizeUserRole } from "@/lib/auth-types";
import {
  isLockedOut,
  recordFailedAttempt,
  readAccountAttempts,
  updateAccountAttempts,
} from "./auth-lockout";

export const credentialsSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("ADMIN"),
    email: z.string().trim().email(),
    password: z.string().refine((value) => value.trim().length > 0),
  }),
  z.object({
    role: z.literal("STAFF"),
    username: z.string().trim().min(1),
    pin: z.string().regex(/^\d{4}$/),
  }),
]);

async function findAccount(identifier: string, role: "ADMIN" | "STAFF") {
  const field = role === "ADMIN" ? "email" : "username";
  const exact = await prisma.users.findMany({
    where: { [field]: identifier },
    select: { id: true, role: true },
    take: 2,
  });
  if (exact.length > 0) return exact.length === 1 ? exact[0] : null;

  const matches = await prisma.users.findMany({
    where: { [field]: { equals: identifier, mode: "insensitive" } },
    select: { id: true, role: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function isAccountLockedOut(identifier: string, role: "ADMIN" | "STAFF") {
  const user = await findAccount(identifier, role);
  if (!user || normalizeUserRole(user.role) !== role) return isLockedOut(identifier);
  return (await readAccountAttempts(user.id))?.lockedUntil != null;
}

export async function authorizeCredentials(credentials: Record<string, unknown>) {
  const parsedCredentials = credentialsSchema.safeParse(credentials);
  if (!parsedCredentials.success) return null;

  const input = parsedCredentials.data;
  const isAdmin = input.role === "ADMIN";
  const identifier = isAdmin ? input.email : input.username;
  const user = await findAccount(identifier, input.role);
  if (!user || normalizeUserRole(user.role) !== input.role) {
    if (!isLockedOut(identifier)) recordFailedAttempt(identifier);
    return null;
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
    const current = await tx.users.findUnique({ where: { id: user.id } });
    const currentIdentifier = isAdmin ? current?.email : current?.username;
    if (
      !current ||
      current.active === false ||
      normalizeUserRole(current.role) !== input.role ||
      currentIdentifier?.toLowerCase() !== identifier.toLowerCase()
    ) return null;

    const record = await readAccountAttempts(user.id, tx);
    if (record?.lockedUntil != null) return null;

    const hash = isAdmin ? current.password : current.pin;
    const credential = isAdmin ? input.password : input.pin;
    const authenticated = hash != null && (
      await bcrypt.compare(credential, hash) ||
      (isAdmin && credential !== credential.trim() && await bcrypt.compare(credential.trim(), hash))
    );
    await updateAccountAttempts(tx, user.id, record, authenticated);
    if (!authenticated) return null;

    return {
      id: current.id.toString(),
      name: current.name,
      email: isAdmin ? current.email : undefined,
      role: input.role,
    };
  });
}
