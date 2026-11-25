/**
 * The browser side of the repeating-appointment routes (feature 17). The save and change routes answer 409 with the list
 * again when a visit could not be saved; that is an answer to show, not an error, so it is returned like a success.
 */
import type { SeriesChangeResult, SeriesPreview, SeriesSaveResult, SeriesView } from "@/lib/series-contracts";
import type { RepeatRule } from "@/lib/series-rule";

import { isDataResponse, readApiError, readFieldErrors, StaffApiError, staffMutation, staffQuery } from "./queries/http";

async function send<T>(path: string, method: "POST" | "PATCH", body: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(path, { method, headers, body: JSON.stringify(body) });
  const result: unknown = await response.json().catch(() => null);
  if ((response.ok || response.status === 409) && isDataResponse(result)) return result.data as T;
  const error = typeof result === "object" && result !== null && "error" in result && typeof result.error === "object" && result.error !== null && "code" in result.error && typeof result.error.code === "string" ? result.error.code : "unknown";
  throw new StaffApiError(readApiError(result, "The change could not be saved."), response.status, error, readFieldErrors(result));
}

export interface SeriesBookingBody {
  clinicSlug: string;
  locationId: string;
  serviceId: string;
  practitionerId: string;
  startsAt: string;
  source: "phone" | "desk";
  reasonForVisit?: string;
  patientId?: string;
  newPatient?: Record<string, unknown>;
  [extra: string]: unknown;
}

export const previewNewSeries = (booking: SeriesBookingBody, rule: RepeatRule) =>
  staffMutation<SeriesPreview>("/api/staff/series/preview", "POST", { booking, rule });

export const saveNewSeries = (booking: SeriesBookingBody, rule: RepeatRule, resolutions: unknown[], idempotencyKey: string) =>
  send<SeriesSaveResult>("/api/staff/series", "POST", { booking, rule, resolutions }, idempotencyKey);

export const loadSeries = (id: string, signal?: AbortSignal) => staffQuery<SeriesView>(`/api/staff/series/${encodeURIComponent(id)}`, signal);

export interface SeriesChangeFields {
  scope: "following" | "all";
  fromAppointmentId: string;
  expectedVersion: number;
  startsAt: string;
  practitionerId?: string;
}

export const previewSeriesMove = (id: string, fields: SeriesChangeFields) =>
  staffMutation<SeriesPreview>(`/api/staff/series/${encodeURIComponent(id)}`, "POST", fields);

export const moveSeries = (id: string, fields: SeriesChangeFields, resolutions: unknown[], idempotencyKey: string) =>
  send<SeriesChangeResult>(`/api/staff/series/${encodeURIComponent(id)}`, "PATCH", { action: "change", ...fields, resolutions }, idempotencyKey);

export const cancelSeries = (id: string, fields: { scope: "following" | "all"; fromAppointmentId: string; expectedVersion: number }, idempotencyKey: string) =>
  send<SeriesChangeResult>(`/api/staff/series/${encodeURIComponent(id)}`, "PATCH", { action: "cancel", ...fields }, idempotencyKey);
