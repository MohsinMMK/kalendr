import "server-only";

import { z } from "zod";

import { ApiError } from "./api-error";

const tokenSchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9_-]+$/);

/** A manage token from the URL, or the same 404 a dead link gets. */
export function appointmentTokenSchemaFor(value: string): string {
  const parsed = tokenSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  return parsed.data;
}
