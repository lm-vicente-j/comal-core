// lib/auth-lockout.ts
import type { Prisma } from "../app/generated/prisma/client";
import prisma from "./prisma";

export const ACCOUNT_LOCKOUT_PREFIX = "AUTH_LOCKOUT:";

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_TRACKED_IDENTIFIERS = 10_000;

export async function persistentRateLimitStatus(key: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const row = await db.authRateLimit.findUnique({ where: { key } });
  if (!row || row.windowEnds <= new Date()) return { attempts: 0, blocked: false, windowEnds: null as Date | null };
  return { attempts: row.attempts, blocked: row.attempts >= MAX_FAILED_ATTEMPTS, windowEnds: row.windowEnds };
}

/** Atomically records a failed attempt and starts/extends a persistent 15 minute lock. */
export async function recordPersistentFailedAttempt(key: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const now = new Date();
  const rows = await db.$queryRaw<Array<{ attempts: number; windowEnds: Date }>>`
    INSERT INTO "authRateLimit" ("key", "attempts", "windowEnds", "updatedAt")
    VALUES (${key}, 1, ${new Date(now.getTime() + LOCKOUT_DURATION_MS)}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "attempts" = CASE WHEN "authRateLimit"."windowEnds" <= ${now} THEN 1 ELSE "authRateLimit"."attempts" + 1 END,
      "windowEnds" = CASE
        WHEN "authRateLimit"."windowEnds" <= ${now} THEN ${new Date(now.getTime() + LOCKOUT_DURATION_MS)}
        WHEN "authRateLimit"."attempts" + 1 >= ${MAX_FAILED_ATTEMPTS} THEN ${new Date(now.getTime() + LOCKOUT_DURATION_MS)}
        ELSE "authRateLimit"."windowEnds" END,
      "updatedAt" = ${now}
    RETURNING "attempts", "windowEnds"`;
  return rows[0];
}

interface AttemptRecord {
  attempts: number;
  lockedUntil: number | null;
  lastAttemptAt: number;
}

// In-memory store for tracking failed login attempts (bounded + TTL pruned)
const attemptStore = new Map<string, AttemptRecord>();

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

function isExpired(record: AttemptRecord, now: number): boolean {
  if (record.lockedUntil !== null) {
    return now >= record.lockedUntil;
  }
  return now - record.lastAttemptAt >= LOCKOUT_DURATION_MS;
}

export async function readAccountAttempts(userId: number, db: Prisma.TransactionClient = prisma) {
  const row = await db.setting.findUnique({ where: { key: ACCOUNT_LOCKOUT_PREFIX + userId } });
  if (!row?.value) return null;
  const record: AttemptRecord = JSON.parse(row.value);
  return isExpired(record, Date.now()) ? null : record;
}

// The caller holds the user row lock until credential verification finishes.
export async function updateAccountAttempts(
  db: Prisma.TransactionClient,
  userId: number,
  record: AttemptRecord | null,
  authenticated: boolean,
) {
  const key = ACCOUNT_LOCKOUT_PREFIX + userId;
  if (authenticated) {
    await db.setting.deleteMany({ where: { key } });
    return;
  }
  const now = Date.now();
  const attempts = (record && !isExpired(record, now) ? record.attempts : 0) + 1;
  const value = JSON.stringify({
    attempts,
    lastAttemptAt: now,
    lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? now + LOCKOUT_DURATION_MS : null,
  });
  await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

function pruneExpired(now: number): void {
  for (const [key, record] of attemptStore) {
    if (isExpired(record, now)) {
      attemptStore.delete(key);
    }
  }
}

/**
 * Checks whether an identifier is currently locked out.
 */
export function isLockedOut(identifier: string): boolean {
  if (!identifier) return false;
  const key = normalizeIdentifier(identifier);
  if (!key) return false;
  const record = attemptStore.get(key);
  if (!record) return false;

  const now = Date.now();
  if (isExpired(record, now)) {
    attemptStore.delete(key);
    return false;
  }

  return record.lockedUntil !== null && now < record.lockedUntil;
}

/**
 * Records a failed login attempt for an identifier.
 * Increments attempt count and sets lockedUntil if threshold reached.
 */
export function recordFailedAttempt(
  identifier: string,
  maxAttempts = MAX_FAILED_ATTEMPTS,
  lockoutDurationMs = LOCKOUT_DURATION_MS
): { attempts: number; locked: boolean; lockedUntil: number | null } {
  if (!identifier) return { attempts: 0, locked: false, lockedUntil: null };
  const key = normalizeIdentifier(identifier);
  if (!key) return { attempts: 0, locked: false, lockedUntil: null };
  const now = Date.now();

  if (!attemptStore.has(key) && attemptStore.size >= MAX_TRACKED_IDENTIFIERS) {
    pruneExpired(now);
    // Evict NON-locked entries with the fewest failed attempts first so 1-attempt floods
    // cannot evict active lockouts or accounts that already accumulated 2..4 failed attempts.
    if (attemptStore.size >= MAX_TRACKED_IDENTIFIERS) {
      let minKey: string | undefined;
      let minAttempts = Infinity;
      for (const [candidateKey, candidateRec] of attemptStore) {
        if (candidateRec.lockedUntil === null && candidateRec.attempts < minAttempts) {
          minAttempts = candidateRec.attempts;
          minKey = candidateKey;
          if (minAttempts <= 1) break;
        }
      }
      if (minKey !== undefined) {
        attemptStore.delete(minKey);
      }
    }
    // If every tracked slot is an active lockout, evict the soonest-to-expire entry
    // so new target accounts are still tracked and locked after 5 failed attempts.
    if (attemptStore.size >= MAX_TRACKED_IDENTIFIERS) {
      let soonestKey: string | undefined;
      let soonestExpiry = Infinity;
      for (const [candidateKey, candidateRec] of attemptStore) {
        const exp = candidateRec.lockedUntil ?? candidateRec.lastAttemptAt + LOCKOUT_DURATION_MS;
        if (exp < soonestExpiry) {
          soonestExpiry = exp;
          soonestKey = candidateKey;
        }
      }
      if (soonestKey !== undefined) {
        attemptStore.delete(soonestKey);
      }
    }
  }

  let record = attemptStore.get(key);
  if (!record || isExpired(record, now)) {
    record = { attempts: 0, lockedUntil: null, lastAttemptAt: now };
  }

  record.attempts += 1;
  record.lastAttemptAt = now;

  if (record.attempts >= maxAttempts) {
    record.lockedUntil = now + lockoutDurationMs;
  }

  // Re-insert so Map iteration order reflects most recently touched keys
  attemptStore.delete(key);
  attemptStore.set(key, record);

  return {
    attempts: record.attempts,
    locked: record.lockedUntil !== null && now < record.lockedUntil,
    lockedUntil: record.lockedUntil,
  };
}

/**
 * Clears failed login attempts for an identifier upon successful authentication.
 */
export function clearFailedAttempts(identifier: string): void {
  if (!identifier) return;
  const key = normalizeIdentifier(identifier);
  if (!key) return;
  attemptStore.delete(key);
}

/**
 * Returns current failed attempts count for an identifier.
 */
export function getFailedAttempts(identifier: string): number {
  if (!identifier) return 0;
  const key = normalizeIdentifier(identifier);
  if (!key) return 0;
  const record = attemptStore.get(key);
  if (!record) return 0;

  if (isExpired(record, Date.now())) {
    attemptStore.delete(key);
    return 0;
  }

  return record.attempts;
}

function isDevTestingEnabled(): boolean {
  return process.env.DEV?.trim().toLowerCase() === "true";
}

/**
 * Resets all lockout records (only allowed when DEV=true for testing).
 */
export function resetAllLockouts(): void {
  if (!isDevTestingEnabled()) {
    throw new Error("resetAllLockouts() is only allowed when DEV=true");
  }
  attemptStore.clear();
}
