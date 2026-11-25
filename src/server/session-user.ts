import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth, authIsConfigured } from "@/lib/auth";

import { getUserSecurity, hasActiveMembership, type UserSecurity } from "./staff-security";

export interface SignedInUser extends UserSecurity {
  userId: string;
  name: string;
  email: string;
  secondFactorAt: Date | null;
}

/**
 * The person behind this session, before any business is chosen. The second-factor screens use it:
 * they must work for someone who is signed in but not yet allowed into a workspace, so they can't
 * go through getStaffContext. Sends everyone else to sign in.
 */
export async function requireSignedInUser(): Promise<SignedInUser> {
  if (!authIsConfigured) redirect("/sign-in");
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || !(await hasActiveMembership(session.user.id))) redirect("/sign-in");
  const security = await getUserSecurity(session.user.id);
  return {
    ...security,
    userId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    secondFactorAt: session.session.secondFactorAt ? new Date(session.session.secondFactorAt) : null,
  };
}
