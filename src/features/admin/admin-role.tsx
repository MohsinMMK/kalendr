"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { PlatformRole } from "@/lib/admin-contracts";

import { adminCan } from "./admin-format";

const RoleContext = createContext<PlatformRole>("support");

export function AdminRoleProvider({ role, children }: { role: PlatformRole; children: ReactNode }) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useAdminRole(): PlatformRole {
  return useContext(RoleContext);
}

export function useAdminCan() {
  return adminCan(useAdminRole());
}
