"use server";

import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { actionFail, actionOk, type ActionResult } from "@/lib/action-result";
import { CAPABILITIES, DEFAULT_ROLE_PERMISSIONS, isConfigurable, type Capability, type RolePermissions } from "@/lib/permissions";
import { isUserRole, type UserRole } from "@/lib/auth-types";

async function ownerId(): Promise<number | null> {
  const session = await auth();
  if (session?.user?.role !== "ADMIN" || !session.user.id) return null;
  const id = Number(session.user.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const user = await prisma.users.findUnique({ where: { id }, select: { role: true, active: true } });
  return user?.role === "ADMIN" && user.active !== false ? id : null;
}

export async function getRolePermissions(role: UserRole): Promise<ActionResult<RolePermissions>> {
  if (!isUserRole(role)) return actionFail("Invalid role");
  if (await ownerId() === null) return actionFail("Forbidden");
  try {
    const rows = await prisma.rolePermission.findMany({ where: { role } });
    const permissions = { ...DEFAULT_ROLE_PERMISSIONS[role] };
    for (const row of rows) {
      if ((CAPABILITIES as readonly string[]).includes(row.capability)) {
        permissions[row.capability as Capability] = row.enabled;
      }
    }
    if (role !== "ADMIN") {
      for (const capability of CAPABILITIES) {
        if (!isConfigurable(role, capability)) permissions[capability] = DEFAULT_ROLE_PERMISSIONS[role][capability];
      }
    }
    return actionOk(permissions);
  } catch {
    return actionFail("Could not load permissions");
  }
}

export async function saveRolePermissions(role: UserRole, updates: Partial<Record<Capability, boolean>>): Promise<ActionResult> {
  if (!isUserRole(role) || role === "ADMIN" || !updates || typeof updates !== "object" || Array.isArray(updates)) return actionFail("Invalid permission update");
  const actorId = await ownerId();
  if (actorId === null) return actionFail("Forbidden");
  const entries = Object.entries(updates);
  if (entries.length === 0 || entries.some(([key, enabled]) => !(CAPABILITIES as readonly string[]).includes(key) || typeof enabled !== "boolean" || !isConfigurable(role, key as Capability))) {
    return actionFail("Permission cannot be changed");
  }
  try {
    await prisma.$transaction(async (tx) => {
      for (const [capability, enabled] of entries) {
        await tx.rolePermission.upsert({
          where: { role_capability: { role, capability } },
          create: { role, capability, enabled: enabled as boolean },
          update: { enabled: enabled as boolean },
        });
      }
      await tx.securityAudit.create({
        data: { actorId, action: "ROLE_PERMISSIONS_UPDATED", subjectId: role, metadata: { updates } },
      });
    });
    return actionOk();
  } catch {
    return actionFail("Could not save permissions");
  }
}
