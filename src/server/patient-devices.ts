import "server-only";

import { and, desc, eq, gt, ne } from "drizzle-orm";

import { getDatabase } from "@/db/client";
import { patientSessions } from "@/db/schema";

import { ApiError } from "./api-error";
import { sha256 } from "./crypto";
import { patientSessionTokenFrom, type PatientAccount } from "./patient-auth";

/** The devices a customer is signed in on (feature 8). Every statement is scoped to the account, so no id from another account matters. */

export interface PatientDevice {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  remember: boolean;
  current: boolean;
}

function connection() {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Devices are unavailable.");
  return database;
}

export async function listPatientDevices(account: PatientAccount, headers: Headers): Promise<PatientDevice[]> {
  const token = patientSessionTokenFrom(headers);
  const currentHash = token ? sha256(token) : null;
  const rows = await connection()
    .select({
      id: patientSessions.id,
      label: patientSessions.deviceLabel,
      createdAt: patientSessions.createdAt,
      expiresAt: patientSessions.expiresAt,
      remember: patientSessions.remember,
      tokenHash: patientSessions.tokenHash,
    })
    .from(patientSessions)
    .where(and(eq(patientSessions.accountId, account.id), gt(patientSessions.expiresAt, new Date())))
    .orderBy(desc(patientSessions.createdAt));
  return rows.map((row) => ({
    id: row.id,
    label: row.label ?? "Unknown device",
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    remember: row.remember,
    current: row.tokenHash === currentHash,
  }));
}

/** Signs one device out. The id must belong to this account; anything else is "not found". Returns whether it was the device in hand. */
export async function signOutPatientDevice(account: PatientAccount, headers: Headers, sessionId: string): Promise<{ current: boolean }> {
  const token = patientSessionTokenFrom(headers);
  const [removed] = await connection()
    .delete(patientSessions)
    .where(and(eq(patientSessions.id, sessionId), eq(patientSessions.accountId, account.id)))
    .returning({ tokenHash: patientSessions.tokenHash });
  if (!removed) throw new ApiError(404, "device_not_found", "That device is already signed out.");
  return { current: Boolean(token) && removed.tokenHash === sha256(token!) };
}

/** Signs out every device but this one. Returns how many went. */
export async function signOutOtherPatientDevices(account: PatientAccount, headers: Headers): Promise<number> {
  const token = patientSessionTokenFrom(headers);
  if (!token) throw new ApiError(401, "unauthorized", "Please sign in again.");
  const removed = await connection()
    .delete(patientSessions)
    .where(and(eq(patientSessions.accountId, account.id), ne(patientSessions.tokenHash, sha256(token))))
    .returning({ id: patientSessions.id });
  return removed.length;
}
