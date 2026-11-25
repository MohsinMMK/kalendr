import "server-only";

import { z } from "zod";

import { ApiError } from "../api-error";

export interface IdRouteContext { params: Promise<{ id: string }> }

const idSchema = z.string().min(8).max(80).regex(/^[A-Za-z0-9_-]+$/);

/** A business id from the path. A malformed one is a plain 404, like any other missing page. */
export async function businessIdFrom(context: IdRouteContext): Promise<string> {
  const parsed = idSchema.safeParse((await context.params).id);
  if (!parsed.success) throw new ApiError(404, "not_found", "That page could not be found.");
  return parsed.data;
}
