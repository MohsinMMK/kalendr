import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ApiError } from "@/server/api-error";
import { secondFactorErrorCodes } from "@/lib/security-policy";
import { getStaffContext, type StaffContext } from "@/server/staff-context";

/**
 * The staff context for an approval page. Someone who is not signed in is sent to sign in and brought straight back to the
 * same page, with the same request, so an app that sent them here does not have to start over.
 */
export async function staffOrSignIn(path: string, query: Record<string, string | string[] | undefined>): Promise<StaffContext> {
  try {
    return await getStaffContext(await headers());
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      const search = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : []))).toString();
      redirect(`/sign-in?next=${encodeURIComponent(search ? `${path}?${search}` : path)}`);
    }
    if (error instanceof ApiError && error.code === secondFactorErrorCodes.required) redirect("/security/second-factor");
    if (error instanceof ApiError && error.code === secondFactorErrorCodes.pending) redirect("/sign-in/verify");
    if (error instanceof ApiError && error.status === 403) redirect("/access-denied");
    throw error;
  }
}
