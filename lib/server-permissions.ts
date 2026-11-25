import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { CAPABILITIES, DEFAULT_ROLE_PERMISSIONS, isConfigurable, type Capability, type RolePermissions } from "@/lib/permissions";
import type { UserRole } from "@/lib/auth-types";
import { redirect } from "next/navigation";

export interface AuthorizationContext {
  userId: number;
  role: UserRole;
  permissions: RolePermissions;
}

/**
 * Loads the authenticated role's persisted permissions for this request.
 * auth() performs live account/session validation, so no role or permission
 * state is trusted from a stale client payload.
 */
export async function getCurrentAuthorization(): Promise<AuthorizationContext | null> {
  const session = await auth();
  if (!session?.user?.id || !["ADMIN", "SUPERVISOR", "STAFF"].includes(session.user.role)) return null;
  const role = session.user.role as UserRole;
  const permissions: RolePermissions = { ...DEFAULT_ROLE_PERMISSIONS[role] };

  if (role !== "ADMIN") {
    const saved = await prisma.rolePermission.findMany({
      where: { role },
      select: { capability: true, enabled: true },
    });
    for (const row of saved) {
      if (CAPABILITIES.includes(row.capability as Capability) && isConfigurable(role, row.capability as Capability)) {
        permissions[row.capability as Capability] = row.enabled;
      }
    }
  }

  return { userId: Number(session.user.id), role, permissions };
}

export async function canCurrentUser(capability: Capability): Promise<boolean> {
  const context = await getCurrentAuthorization();
  return Boolean(context?.permissions[capability]);
}

export async function hasCurrentRole(...roles: UserRole[]): Promise<boolean> {
  const context = await getCurrentAuthorization();
  return Boolean(context && roles.includes(context.role));
}

export async function requirePageCapability(capability: Capability, fallback = "/pos"): Promise<AuthorizationContext> {
  const context = await getCurrentAuthorization();
  if (!context) redirect("/login");
  if (!context.permissions[capability]) redirect(fallback);
  return context;
}

export async function requireAnyPageCapability(capabilities: Capability[], fallback = "/pos"): Promise<AuthorizationContext> {
  const context = await getCurrentAuthorization();
  if (!context) redirect("/login");
  if (!capabilities.some((capability) => context.permissions[capability])) redirect(fallback);
  return context;
}
