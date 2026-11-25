export const USER_ROLES = ["ADMIN", "SUPERVISOR", "STAFF"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const AUTH_MODES = ["OWNER_PASSWORD", "FIXED_PIN", "MOBILE_PIN"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export function isUserRole(role: unknown): role is UserRole {
  return typeof role === "string" && (USER_ROLES as readonly string[]).includes(role);
}

/** Kept as a compatibility alias, but invalid roles are rejected with null. */
export function normalizeUserRole(role: unknown): UserRole | null {
  return isUserRole(role) ? role : null;
}
