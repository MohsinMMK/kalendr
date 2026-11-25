import "server-only";

import { z } from "zod";

import { getDatabase, type KalendrDatabase } from "@/db/client";

import { ApiError, getPostgresErrorCode } from "../api-error";

/** The console's one way to reach the database. Every cross-business read goes through an `admin_*` function. */
export function adminDatabase(): KalendrDatabase {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Business data is unavailable.");
  return database;
}

/** A timestamp as an ISO string, whether the driver gave a Date (columns) or a string (inside jsonb). */
export const isoTime = z.union([z.date(), z.string()]).transform((value) => new Date(value).toISOString());
export const isoTimeOrNull = isoTime.nullable();
/** bigint counts come back from the driver as strings. */
export const count = z.coerce.number().int();

/**
 * What the database functions refuse with. A caller who is not an operator gets the same 404 as a missing page; a
 * missing reason is the person's mistake and gets a 400.
 */
export function mapAdminDatabaseError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = getPostgresErrorCode(error);
  if (code === "42501" || code === "P0002") throw new ApiError(404, "not_found", "That page could not be found.");
  if (code === "23514") throw new ApiError(400, "validation_error", "Please give a reason of a few words.");
  throw error;
}

/** Runs one admin query and turns the function's refusals into API errors. */
export async function adminCall<T>(operation: (database: KalendrDatabase) => Promise<T>): Promise<T> {
  try {
    return await operation(adminDatabase());
  } catch (error: unknown) {
    return mapAdminDatabaseError(error);
  }
}
