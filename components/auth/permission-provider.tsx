"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Capability, RolePermissions } from "@/lib/permissions";

const PermissionContext = createContext<RolePermissions | null>(null);

export function PermissionProvider({ permissions, children }: { permissions: RolePermissions; children: ReactNode }) {
    return <PermissionContext.Provider value={permissions}>{children}</PermissionContext.Provider>;
}

/** Presentation only; server actions independently enforce every capability. */
export function usePermission(capability: Capability): boolean {
    return useContext(PermissionContext)?.[capability] ?? false;
}
