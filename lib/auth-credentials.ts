import { randomInt } from "node:crypto";
import { z } from "zod";
import bcrypt from "bcryptjs";
import type { Prisma } from "@/app/generated/prisma/client";
import { cookies } from "next/headers";
import prisma from "./prisma";
import { isUserRole, type AuthMode } from "@/lib/auth-types";
import { readAccountAttempts, updateAccountAttempts, persistentRateLimitStatus, recordPersistentFailedAttempt } from "./auth-lockout";
import { createPinLookupHash, sha256 } from "./auth-crypto";
export { createPinLookupHash } from "./auth-crypto";

const TERMINAL_COOKIE = "comal_terminal";
const PIN = /^\d{6}$/;

export const credentialsSchema = z.discriminatedUnion("authMode", [
  z.object({ authMode: z.literal("OWNER_PASSWORD"), email: z.string().trim().email(), password: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= 72) }),
  z.object({ authMode: z.literal("FIXED_PIN"), pin: z.string().regex(PIN) }),
  z.object({ authMode: z.literal("MOBILE_PIN"), username: z.string().trim().min(1), pin: z.string().regex(PIN) }),
]);

export async function generateUniqueStaffPin(db: typeof prisma | Prisma.TransactionClient = prisma): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const pinLookupHash = createPinLookupHash(pin);
    const exists = await db.users.findUnique({ where: { pinLookupHash }, select: { id: true } });
    if (!exists) return pin;
  }
  throw new Error("Could not generate a unique PIN");
}

async function findAccount(input: z.infer<typeof credentialsSchema>) {
  if (input.authMode === "OWNER_PASSWORD") {
    return prisma.users.findFirst({
      where: { email: { equals: input.email, mode: "insensitive" } },
      select: { id: true, role: true, email: true },
    });
  }
  if (input.authMode === "FIXED_PIN") {
    return prisma.users.findUnique({
      where: { pinLookupHash: createPinLookupHash(input.pin) },
      select: { id: true, role: true, username: true },
    });
  }
  return prisma.users.findFirst({
    where: { username: { equals: input.username, mode: "insensitive" } },
    select: { id: true, role: true, username: true },
  });
}

export async function isAccountLockedOut(identifier: string, role?: string) {
  const row = role === "ADMIN"
    ? await prisma.users.findFirst({ where: { email: { equals: identifier, mode: "insensitive" } }, select: { id: true } })
    : await prisma.users.findFirst({ where: { username: { equals: identifier, mode: "insensitive" } }, select: { id: true } });
  if (row) return (await readAccountAttempts(row.id))?.lockedUntil != null;
  const identityHash = await sha256(identifier.trim().toLowerCase());
  return (await persistentRateLimitStatus(`login:${identityHash}`)).blocked;
}

export async function authorizeCredentials(credentials: Record<string, unknown>) {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success) return null;
  const input = parsed.data;
  let terminalId: string | null = null;
  let terminalTokenHash: string | null = null;
  if (input.authMode !== "OWNER_PASSWORD") {
    const token = (await cookies()).get(TERMINAL_COOKIE)?.value;
    if (!token) return null;
    terminalTokenHash = await sha256(token);
    const terminal = await prisma.terminal.findFirst({ where: { active: true, tokenHash: terminalTokenHash } });
    if (!terminal || (input.authMode === "FIXED_PIN" && terminal.type !== "FIXED") || (input.authMode === "MOBILE_PIN" && terminal.type !== "MOBILE")) return null;
    terminalId = terminal.id;
    if (input.authMode === "FIXED_PIN" && (await persistentRateLimitStatus(`terminal-pin:${terminal.id}`)).blocked) return null;
  }

  const inputIdentity = input.authMode === "OWNER_PASSWORD" ? input.email : input.authMode === "MOBILE_PIN" ? input.username : `terminal:${terminalId}`;
  const user = await findAccount(input);
  if (!user || !isUserRole(user.role)) {
    const identityHash = await sha256(inputIdentity.trim().toLowerCase());
    await recordPersistentFailedAttempt(input.authMode === "FIXED_PIN" && terminalId ? `terminal-pin:${terminalId}` : `login:${identityHash}`);
    return null;
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
    const current = await tx.users.findUnique({ where: { id: user.id } });
    if (!current || current.active === false || !isUserRole(current.role)) return null;
    if (input.authMode === "OWNER_PASSWORD" && current.role !== "ADMIN") return null;
    if (input.authMode !== "OWNER_PASSWORD" && current.role === "ADMIN") return null;
    const attempts = await readAccountAttempts(current.id, tx);
    if (attempts?.lockedUntil != null && Date.now() < attempts.lockedUntil) return null;

    const hash = input.authMode === "OWNER_PASSWORD" ? current.password : current.pin;
    const credential = input.authMode === "OWNER_PASSWORD" ? input.password : input.pin;
    const pinMatchesIndex = input.authMode === "OWNER_PASSWORD" || (input.authMode === "MOBILE_PIN"
      ? current.pinLookupHash === createPinLookupHash(input.pin)
      : true);
    const authenticated = Boolean(pinMatchesIndex && hash && await bcrypt.compare(credential, hash));
    await updateAccountAttempts(tx, current.id, attempts, authenticated);
    if (!authenticated) return null;

    const authMode = input.authMode as AuthMode;
    return {
      id: String(current.id),
      name: current.name ?? undefined,
      email: input.authMode === "OWNER_PASSWORD" ? current.email ?? undefined : undefined,
      role: current.role,
      authMode,
      terminalId,
      terminalTokenHash,
      terminalCredentialVersion: input.authMode === "OWNER_PASSWORD" ? undefined : (await tx.terminal.findUnique({ where: { id: terminalId! }, select: { credentialVersion: true } }))?.credentialVersion,
      credentialVersion: current.credentialVersion,
      authenticatedAt: Date.now(),
    };
  });
}
