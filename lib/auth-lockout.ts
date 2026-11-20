// lib/auth-lockout.ts

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

interface AttemptRecord {
  attempts: number;
  lockedUntil: number | null;
}

// In-memory store for tracking failed login attempts
const attemptStore = new Map<string, AttemptRecord>();

function normalizeIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase();
}

/**
 * Checks whether an identifier is currently locked out.
 */
export function isLockedOut(identifier: string): boolean {
  if (!identifier) return false;
  const key = normalizeIdentifier(identifier);
  const record = attemptStore.get(key);
  if (!record) return false;

  if (record.lockedUntil !== null) {
    if (Date.now() < record.lockedUntil) {
      return true;
    }
    // Lockout expired: clean up
    attemptStore.delete(key);
    return false;
  }

  return false;
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
  const now = Date.now();

  const record = attemptStore.get(key) ?? { attempts: 0, lockedUntil: null };

  // If previous lockout expired, start fresh
  if (record.lockedUntil !== null && now >= record.lockedUntil) {
    record.attempts = 0;
    record.lockedUntil = null;
  }

  record.attempts += 1;

  if (record.attempts >= maxAttempts) {
    record.lockedUntil = now + lockoutDurationMs;
  }

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
  attemptStore.delete(key);
}

/**
 * Returns current failed attempts count for an identifier.
 */
export function getFailedAttempts(identifier: string): number {
  if (!identifier) return 0;
  const key = normalizeIdentifier(identifier);
  const record = attemptStore.get(key);
  if (!record) return 0;

  if (record.lockedUntil !== null && Date.now() >= record.lockedUntil) {
    attemptStore.delete(key);
    return 0;
  }

  return record.attempts;
}

/**
 * Resets all lockout records (primarily for testing).
 */
export function resetAllLockouts(): void {
  attemptStore.clear();
}
