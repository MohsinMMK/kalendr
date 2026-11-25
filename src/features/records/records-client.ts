import type { PatientContactKind } from "@/lib/patient-contact";
import {
  previewAddFile,
  previewConfirmAccess,
  previewCreateRecord,
  previewDeleteRecord,
  previewEditRecord,
  previewGetRecord,
  previewListRecords,
  previewPortalConfirm,
  previewPortalRecord,
  previewPortalSignIn,
  previewPortalSignOut,
  previewRemoveFile,
  previewShareRecord,
  previewWithdrawRecord,
} from "@/lib/preview-records";
import type {
  PortalRecordDetail,
  PortalSnapshot,
  RecordFileSummary,
  RecordsList,
  VisitRecordDetail,
  VisitRecordInput,
  VisitRecordKind,
} from "@/lib/visit-records";

/** A refused request, with the server's error code (such as "challenge_required") when it sent one. */
export class ApiRequestError extends Error {
  constructor(message: string, readonly code: string | undefined) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function api<T>(path: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok || typeof result !== "object" || result === null || !("data" in result)) {
    throw new ApiRequestError(readError(result) ?? fallback, readCode(result));
  }
  return result.data as T;
}

function readCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  const error = value.error;
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function readError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = value.error;
  if (typeof error !== "object" || error === null) return null;
  if ("fieldErrors" in error && error.fieldErrors && typeof error.fieldErrors === "object") {
    for (const entry of Object.values(error.fieldErrors as Record<string, unknown>)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[0].trim()) return entry[0];
    }
  }
  return "message" in error && typeof error.message === "string" ? error.message : null;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export type NewRecord = VisitRecordInput & { patientName: string; practitionerName: string | null };

/** The staff Records page talks to this, so it doesn't need to know whether it's the database or the preview. */
export interface RecordsClient {
  list(): Promise<RecordsList>;
  get(id: string): Promise<VisitRecordDetail>;
  create(input: NewRecord): Promise<{ id: string }>;
  edit(id: string, input: { kind: VisitRecordKind; title: string; body: string }): Promise<void>;
  share(id: string): Promise<void>;
  withdraw(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  addFile(id: string, file: File): Promise<void>;
  removeFile(id: string, fileId: string): Promise<void>;
  confirmAccess(accessId: string): Promise<void>;
  fileHref(recordId: string, file: RecordFileSummary): string;
}

const recordPath = (id: string) => `/api/staff/records/${encodeURIComponent(id)}`;

export const databaseRecordsClient: RecordsClient = {
  list: () => api("/api/staff/records", undefined, "Records could not be loaded."),
  get: (id) => api(recordPath(id), undefined, "This record could not be opened."),
  create: ({ patientId, appointmentId, kind, title, body }) => api("/api/staff/records", json("POST", { patientId, appointmentId, kind, title, body }), "The record could not be saved."),
  edit: async (id, input) => { await api(recordPath(id), json("PATCH", { action: "edit", ...input }), "The record could not be saved."); },
  share: async (id) => { await api(recordPath(id), json("PATCH", { action: "share" }), "The record could not be shared."); },
  withdraw: async (id) => { await api(recordPath(id), json("PATCH", { action: "withdraw" }), "The record could not be withdrawn."); },
  remove: async (id) => { await api(recordPath(id), json("DELETE"), "The record could not be deleted."); },
  addFile: async (id, file) => {
    const body = new FormData();
    body.set("file", file);
    await api(`${recordPath(id)}/files`, { method: "POST", body }, "The file could not be uploaded.");
  },
  removeFile: async (id, fileId) => { await api(`${recordPath(id)}/files/${encodeURIComponent(fileId)}`, json("DELETE"), "The file could not be removed."); },
  confirmAccess: async (accessId) => { await api(`/api/staff/records/access/${encodeURIComponent(accessId)}`, json("POST"), "The request could not be confirmed."); },
  fileHref: (recordId, file) => `${recordPath(recordId)}/files/${encodeURIComponent(file.id)}`,
};

export function previewRecordsClient(now: string): RecordsClient {
  return {
    list: async () => previewListRecords(),
    get: async (id) => previewGetRecord(id),
    create: async (input) => previewCreateRecord(input, now),
    edit: async (id, input) => previewEditRecord(id, input, now),
    share: async (id) => previewShareRecord(id, now),
    withdraw: async (id) => previewWithdrawRecord(id, now),
    remove: async (id) => previewDeleteRecord(id),
    addFile: (id, file) => previewAddFile(id, file, now),
    removeFile: async (id, fileId) => previewRemoveFile(id, fileId, now),
    confirmAccess: async (accessId) => previewConfirmAccess(accessId),
    fileHref: (_recordId, file) => file.previewDataUrl ?? "#",
  };
}

/* Patient portal, real server. The preview portal builds its snapshot in the workspace because it needs the schedule. */

export const portalAuth = {
  /** `via: "text"` skips WhatsApp for a phone number. */
  requestCode: (kind: PatientContactKind, contact: string, headers?: Record<string, string>, via?: "text") =>
    api("/api/portal/auth/request", { ...json("POST", { kind, contact, ...(via ? { via } : {}) }), headers }, "The code could not be sent."),
  verifyCode: (kind: PatientContactKind, contact: string, code: string, remember = false) =>
    api("/api/portal/auth/verify", json("POST", { kind, contact, code, ...(remember ? { remember: true } : {}) }), "That code isn't right."),
  signOut: () => api("/api/portal/auth/sign-out", json("POST"), "Could not sign out."),
  previewSignIn: previewPortalSignIn,
  previewSignOut: previewPortalSignOut,
};

/** One signed-in device of the customer portal. */
export interface PortalDevice {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  remember: boolean;
  current: boolean;
}

export const portalDevices = {
  list: async (): Promise<PortalDevice[]> => {
    const result = await api<{ devices: PortalDevice[] }>("/api/portal/devices", undefined, "Your devices could not be loaded.");
    return Array.isArray(result?.devices) ? result.devices : [];
  },
  signOut: (id: string) => api<{ signedOut: boolean }>(`/api/portal/devices/${encodeURIComponent(id)}`, json("DELETE"), "That device could not be signed out."),
  signOutOthers: () => api<{ signedOut: number }>("/api/portal/auth/sign-out-others", json("POST"), "Other devices could not be signed out."),
};

export interface PortalClient {
  snapshot(): Promise<PortalSnapshot>;
  confirm(clinicSlug: string, patientId: string, dateOfBirth?: string): Promise<void>;
  record(clinicSlug: string, id: string): Promise<PortalRecordDetail>;
  fileHref(clinicSlug: string, recordId: string, file: RecordFileSummary): string;
}

const portalRecordPath = (clinicSlug: string, id: string) => `/api/portal/records/${encodeURIComponent(clinicSlug)}/${encodeURIComponent(id)}`;

export const databasePortalClient: PortalClient = {
  snapshot: () => api("/api/portal/me", undefined, "Your details could not be loaded."),
  confirm: async (clinicSlug, patientId, dateOfBirth) => { await api("/api/portal/identity", json("POST", { clinicSlug, patientId, dateOfBirth }), "That could not be confirmed."); },
  record: (clinicSlug, id) => api(portalRecordPath(clinicSlug, id), undefined, "This document could not be opened."),
  fileHref: (clinicSlug, recordId, file) => `${portalRecordPath(clinicSlug, recordId)}/files/${encodeURIComponent(file.id)}`,
};

export function previewPortalClient(contact: string, now: string, snapshot: () => PortalSnapshot): PortalClient {
  return {
    snapshot: async () => snapshot(),
    confirm: async (_clinicSlug, patientId, dateOfBirth) => previewPortalConfirm(contact, patientId, dateOfBirth, now),
    record: async (_clinicSlug, id) => previewPortalRecord(contact, id, now),
    fileHref: (_clinicSlug, _recordId, file) => file.previewDataUrl ?? "#",
  };
}
