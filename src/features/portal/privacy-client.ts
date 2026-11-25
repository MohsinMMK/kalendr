import type { ConsentPurpose, DataRequestType } from "@/server/privacy/rules";
import type { PortalPrivacy } from "@/server/privacy/portal";
import type { DataRequestView } from "@/server/privacy/requests";
import type { PrivacyNoticeText } from "@/server/privacy/notice";

export type { ConsentPurpose, DataRequestType, DataRequestView, PortalPrivacy, PrivacyNoticeText };

/** A refused request, with the API's own code (such as `guardian_required`). */
export class PrivacyApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "PrivacyApiError";
  }
}

async function call<T>(path: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    });
  } catch {
    throw new PrivacyApiError("We could not reach the server. Check your connection and try again.", "network", 0);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || typeof body !== "object" || body === null || !("data" in body)) {
    let message = fallback;
    let code = "unknown";
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null) {
      const error = body.error as { message?: unknown; code?: unknown };
      if (typeof error.message === "string" && error.message.trim()) message = error.message;
      if (typeof error.code === "string") code = error.code;
    }
    throw new PrivacyApiError(message, code, response.status);
  }
  return (body as { data: T }).data;
}

export interface GuardianInput {
  name: string;
  relationship: string;
  contact: string;
}

export const portalPrivacyApi = {
  load: (language: string) => call<PortalPrivacy>(`/api/portal/privacy?language=${encodeURIComponent(language)}`, undefined, "Your privacy choices could not be loaded."),
  setConsent: (input: { clinicSlug: string; patientId: string; purpose: ConsentPurpose; granted: boolean; wordingVersion: string; guardian?: GuardianInput }) =>
    call<{ changed: boolean }>("/api/portal/privacy/consents", { method: "PUT", body: JSON.stringify(input) }, "That choice could not be saved."),
  createRequest: (input: { clinicSlug: string; patientId: string; type: DataRequestType; note?: string }) =>
    call<{ request: DataRequestView; created: boolean }>("/api/portal/privacy/requests", { method: "POST", body: JSON.stringify(input) }, "Your request could not be sent."),
  notice: (clinicSlug: string, language: string) =>
    call<PrivacyNoticeText>(`/api/public/privacy-notice?clinic=${encodeURIComponent(clinicSlug)}&language=${encodeURIComponent(language)}`, undefined, "The notice could not be loaded."),
};

/** A request waiting for a fresh sign-in code survives the trip through the sign-in page here. */
export const pendingRequestKey = "kalendr-privacy-pending-v1";
