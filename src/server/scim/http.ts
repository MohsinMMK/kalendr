import "server-only";

import { appOrigin } from "@/server/env";

import { getScimContext, type ScimContext } from "./auth";
import { scimFailure } from "./protocol";

export const scimBaseUrl = (): string => `${appOrigin()}/api/scim/v2`;

/** One place for the shape every directory route shares: find the business from the token, do the work, answer in SCIM. */
export async function scimRoute(request: Request, work: (context: ScimContext, baseUrl: string) => Promise<Response>): Promise<Response> {
  try {
    return await work(await getScimContext(request.headers), scimBaseUrl());
  } catch (error: unknown) {
    return scimFailure(error);
  }
}
