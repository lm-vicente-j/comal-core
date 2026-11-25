import type { UserRole } from "@/lib/auth-types";

/** Capabilities which can be delegated by the owner. Keep this Edge-safe. */
export const CAPABILITIES = [
  "sales.create",
  "sales.managePending",
  "sales.manageDebt",
  "expenses.create",
  "debts.collect",
  "jornada.open",
  "jornada.close",
  "jornada.reconcile",
  "jornada.viewCash",
  "savings.deposit",
  "savings.manage",
  "reports.operational",
  "catalog.manage",
  "inventory.manage",
  "customers.manage",
  "payrolls.manage",
  "settings.manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];
export type RolePermissions = Record<Capability, boolean>;

const all = (enabled: boolean): RolePermissions => Object.fromEntries(
  CAPABILITIES.map((capability) => [capability, enabled]),
) as RolePermissions;

export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, RolePermissions> = {
  ADMIN: all(true),
  SUPERVISOR: {
    ...all(false),
    "sales.create": true,
    "sales.managePending": true,
    "expenses.create": true,
    "debts.collect": true,
    "jornada.open": true,
    "jornada.close": true,
    "jornada.reconcile": true,
    "jornada.viewCash": true,
    "savings.deposit": true,
    "reports.operational": true,
  },
  STAFF: {
    ...all(false),
    "sales.create": true,
    "sales.managePending": true,
    "expenses.create": true,
    "debts.collect": true,
    "jornada.reconcile": true,
  },
};

const CONFIGURABLE_BY_ROLE: Record<UserRole, ReadonlySet<Capability>> = {
  ADMIN: new Set(CAPABILITIES),
  SUPERVISOR: new Set([
    "sales.managePending", "expenses.create", "debts.collect",
    "jornada.open", "jornada.close", "jornada.reconcile", "jornada.viewCash",
    "savings.deposit", "reports.operational", "catalog.manage", "inventory.manage", "customers.manage",
  ]),
  STAFF: new Set([
    "sales.managePending", "expenses.create", "debts.collect",
    "jornada.open", "jornada.close", "jornada.reconcile",
  ]),
};

/** True only for controls the owner may change for a role. */
export function isConfigurable(role: UserRole, capability: Capability): boolean {
  return CONFIGURABLE_BY_ROLE[role].has(capability);
}

interface RoutePermission { prefix: string; roles: readonly UserRole[] }

// Route-level checks provide a coarse role boundary. Page and action checks
// resolve persisted, per-role capabilities on the server for every request.
export const ROUTE_PERMISSIONS: readonly RoutePermission[] = [
  { prefix: "/admin/access", roles: ["ADMIN"] },
  { prefix: "/admin/roster", roles: ["ADMIN"] },
  { prefix: "/admin/settings", roles: ["ADMIN"] },
  { prefix: "/admin/crm", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/admin/inventory", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/admin/menu", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/admin/savings", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/admin/statistics", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/admin/reports", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/admin/jornada", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/pos", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/expenses", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
  { prefix: "/debtors", roles: ["ADMIN", "SUPERVISOR", "STAFF"] },
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function canAccessRoute(role: string, pathname: string): boolean {
  const rule = ROUTE_PERMISSIONS.find((r) => matchesPrefix(pathname, r.prefix));
  return !rule || (rule.roles as readonly string[]).includes(role);
}

export function canAccessDashboardRoute(role: string, pathname: string, permissions?: RolePermissions): boolean {
  if (!canAccessRoute(role, pathname)) return false;
  if (!permissions) return true;
  const can = (...caps: Capability[]) => caps.some((cap) => permissions[cap]);
  if (matchesPrefix(pathname, "/admin/access")) return role === "ADMIN";
  if (matchesPrefix(pathname, "/admin/roster") || matchesPrefix(pathname, "/admin/settings")) return role === "ADMIN";
  if (matchesPrefix(pathname, "/admin/inventory")) return can("inventory.manage");
  if (matchesPrefix(pathname, "/admin/menu")) return can("catalog.manage");
  if (matchesPrefix(pathname, "/admin/crm")) return can("customers.manage");
  if (matchesPrefix(pathname, "/admin/savings")) return can("savings.deposit", "savings.manage");
  if (matchesPrefix(pathname, "/admin/statistics") || matchesPrefix(pathname, "/admin/reports")) return can("reports.operational");
  if (matchesPrefix(pathname, "/admin/jornada")) return can("jornada.open", "jornada.close", "jornada.reconcile", "jornada.viewCash");
  if (matchesPrefix(pathname, "/expenses")) return can("expenses.create", "reports.operational");
  if (matchesPrefix(pathname, "/debtors")) return true;
  if (matchesPrefix(pathname, "/pos")) return true;
  return true;
}

/** Owner-only authority is never delegated through the role permission table. */
export function isAdmin(role?: string | null): boolean {
  return role === "ADMIN";
}
