"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { permissionKeys, type Permission, type StaffRole } from "@/lib/permissions";

export interface StaffAccess {
  role: StaffRole;
  permissions: readonly Permission[];
  userId: string | null;
  /** The bookable profile linked to this login, when they see customers here. */
  ownPractitionerId: string | null;
  can: (permission: Permission) => boolean;
}

const previewAccess: StaffAccess = {
  role: "owner",
  permissions: permissionKeys,
  userId: null,
  ownPractitionerId: null,
  can: () => true,
};

const StaffAccessContext = createContext<StaffAccess>(previewAccess);

/**
 * What the signed-in person may do, for hiding controls they can't use.
 * The server checks every request again; this only keeps the screen honest.
 */
export function StaffAccessProvider({
  role,
  permissions,
  userId,
  ownPractitionerId = null,
  children,
}: {
  role: StaffRole;
  permissions: readonly Permission[];
  userId: string | null;
  ownPractitionerId?: string | null;
  children: ReactNode;
}) {
  const value = useMemo<StaffAccess>(() => ({
    role,
    permissions,
    userId,
    ownPractitionerId,
    can: (permission) => permissions.includes(permission),
  }), [role, permissions, userId, ownPractitionerId]);
  return <StaffAccessContext.Provider value={value}>{children}</StaffAccessContext.Provider>;
}

export function useStaffAccess(): StaffAccess {
  return useContext(StaffAccessContext);
}
