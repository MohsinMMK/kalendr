import type { Clinic } from "@/lib/domain";
import { demoClinic } from "@/lib/demo-data";

export type WebsiteMethod = "link" | "iframe" | "popup" | "api";

export interface WebsiteSetup {
  id: string;
  name: string;
  websiteOrigins: string[];
  bookingOrigin: string;
  method: WebsiteMethod;
  buttonLabel: string;
  iframeHeight: number;
}

export interface WebsiteDraft {
  id: string;
  name: string;
  websiteOriginsInput: string;
  bookingOriginInput: string;
  method: WebsiteMethod;
  buttonLabel: string;
  iframeHeightInput: string;
}

export const previewSettingsKey = "kalendr-preview-settings-v1";

export function normalizeExactOrigin(input: string, allowLocalHttp: boolean): string | null {
  try {
    const candidate = input.trim();
    if (!candidate || candidate.includes("*")) return null;
    const url = new URL(candidate);
    const localHttp = allowLocalHttp && url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function validateWebsiteDraft(draft: WebsiteDraft, saved: WebsiteSetup[], allowLocalHttp: boolean, exampleOrigin = "https://clinic.example"): { setup?: WebsiteSetup; error?: string } {
  const name = draft.name.trim();
  if (name.length < 2 || name.length > 80) return { error: "Enter a setup name between 2 and 80 characters." };
  if (saved.some((item) => item.id !== draft.id && item.name.toLocaleLowerCase("en-IN") === name.toLocaleLowerCase("en-IN"))) return { error: "Use a different setup name so each website setup is easy to identify." };
  const originInputs = draft.websiteOriginsInput.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  if (!originInputs.length) return { error: `Enter at least one exact website origin, such as ${exampleOrigin}.` };
  const websiteOrigins = originInputs.map((input) => normalizeExactOrigin(input, allowLocalHttp));
  if (websiteOrigins.some((origin) => origin === null)) return { error: "Website origins must be exact HTTPS origins without paths, wildcards, or credentials. Localhost HTTP is allowed in development." };
  const uniqueOrigins = [...new Set(websiteOrigins as string[])];
  const bookingOrigin = normalizeExactOrigin(draft.bookingOriginInput, allowLocalHttp);
  if (!bookingOrigin) return { error: "Enter the exact Kalendr booking origin. Use HTTPS in production; localhost HTTP is for development only." };
  const buttonLabel = draft.buttonLabel.trim();
  if (buttonLabel.length < 2 || buttonLabel.length > 80) return { error: "Enter a button label between 2 and 80 characters." };
  const iframeHeight = Number(draft.iframeHeightInput);
  if (!Number.isInteger(iframeHeight) || iframeHeight < 600 || iframeHeight > 1600) return { error: "Set an iframe height from 600 to 1600 pixels." };
  return { setup: { id: draft.id, name, websiteOrigins: uniqueOrigins, bookingOrigin, method: draft.method, buttonLabel, iframeHeight } };
}

export function toWebsiteDraft(setup: WebsiteSetup): WebsiteDraft {
  return { ...setup, websiteOriginsInput: setup.websiteOrigins.join("\n"), bookingOriginInput: setup.bookingOrigin, iframeHeightInput: String(setup.iframeHeight) };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function bookingUrl(setup: WebsiteSetup, embedded = false, clinic: Pick<Clinic, "slug" | "name"> = demoClinic): string {
  const url = new URL(`/book/${encodeURIComponent(clinic.slug)}`, setup.bookingOrigin);
  if (embedded) url.searchParams.set("embed", "1");
  return url.toString();
}

export function websiteSnippet(setup: WebsiteSetup, clinic: Pick<Clinic, "slug" | "name"> = demoClinic): string {
  const url = escapeHtml(bookingUrl(setup, false, clinic));
  if (setup.method === "link") return `<a href="${url}">${escapeHtml(setup.buttonLabel)}</a>`;
  if (setup.method === "iframe") {
    const sameOrigin = setup.websiteOrigins.length === 1 && setup.websiteOrigins[0] === setup.bookingOrigin;
    const sandbox = sameOrigin ? "" : '\n  sandbox="allow-forms allow-scripts allow-same-origin allow-popups"';
    return `<iframe\n  src="${escapeHtml(bookingUrl(setup, true, clinic))}"\n  title="${escapeHtml(`Book with ${clinic.name}`)}"\n  loading="lazy"\n  referrerpolicy="strict-origin-when-cross-origin"${sandbox}\n  style="width:100%;min-height:${setup.iframeHeight}px;border:0"\n></iframe>`;
  }
  if (setup.method === "popup") {
    const mountId = `kalendr-booking-${setup.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
    return `<div id="${mountId}"></div>\n<script\n  src="${escapeHtml(`${setup.bookingOrigin}/kalendr-widget.js?v=3`)}"\n  data-kalendr-clinic="${escapeHtml(clinic.slug)}"\n  data-kalendr-mount="#${mountId}"\n  data-kalendr-label="${escapeHtml(setup.buttonLabel)}"\n  defer\n></script>`;
  }
  const origin = JSON.stringify(setup.bookingOrigin);
  const slug = JSON.stringify(clinic.slug);
  return `// Run on your website server, after your own form and privacy consent.\nconst bookingOrigin = ${origin};\nconst clinicSlug = ${slug};\n\nexport async function getKalendrSlots({ locationId, serviceId, practitionerId = "first_available" }) {\n  const query = new URLSearchParams({ clinicSlug, locationId, serviceId, practitionerId });\n  const response = await fetch(\`\${bookingOrigin}/api/public/availability?\${query}\`, {\n    headers: { Accept: "application/json" },\n  });\n  if (!response.ok) throw new Error(\`Availability failed: \${response.status}\`);\n  return (await response.json()).data.slots;\n}\n\nexport async function createKalendrAppointment({ locationId, serviceId, slot, patient, patientType, bookingFor, idempotencyKey }) {\n  // Reuse the same idempotencyKey when retrying this booking attempt.\n  if (!patient.acceptedPrivacyNotice) throw new Error("Privacy notice must be accepted.");\n  const response = await fetch(\`\${bookingOrigin}/api/public/appointments\`, {\n    method: "POST",\n    headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },\n    body: JSON.stringify({\n      clinicSlug, patientType, bookingFor, locationId, serviceId,\n      practitionerId: slot.practitionerId, slotId: slot.id,\n      startsAt: slot.startsAt, endsAt: slot.endsAt,\n      firstName: patient.firstName, lastName: patient.lastName,\n      phone: patient.phone, email: patient.email,\n      preferredChannel: patient.preferredChannel,\n      accessibilityNeed: patient.accessibilityNeed || undefined,\n      acceptedPrivacyNotice: true,\n    }),\n  });\n  if (!response.ok) throw new Error(\`Booking failed: \${response.status}\`);\n  return (await response.json()).data;\n}`;
}

export function readWebsiteSetups(): WebsiteSetup[] {
  const stored = window.sessionStorage.getItem(previewSettingsKey);
  if (!stored) return [];
  const parsed: unknown = JSON.parse(stored);
  if (typeof parsed !== "object" || parsed === null || !("websiteSetups" in parsed)) return [];
  const setups = (parsed as { websiteSetups: unknown }).websiteSetups;
  if (!Array.isArray(setups)) return [];
  const allowLocalHttp = process.env.NODE_ENV !== "production";
  return setups.filter((item): item is WebsiteSetup =>
    typeof item === "object" && item !== null &&
    typeof item.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(item.id) &&
    typeof item.name === "string" && item.name.trim().length >= 2 && item.name.length <= 80 &&
    Array.isArray(item.websiteOrigins) && item.websiteOrigins.length > 0 &&
    item.websiteOrigins.every((origin: unknown) => typeof origin === "string" && normalizeExactOrigin(origin, allowLocalHttp) === origin) &&
    typeof item.bookingOrigin === "string" && normalizeExactOrigin(item.bookingOrigin, allowLocalHttp) === item.bookingOrigin &&
    ["link", "iframe", "popup", "api"].includes(item.method) &&
    typeof item.buttonLabel === "string" && item.buttonLabel.length >= 2 && item.buttonLabel.length <= 80 &&
    Number.isInteger(item.iframeHeight) && item.iframeHeight >= 600 && item.iframeHeight <= 1600,
  );
}

export function saveWebsiteSetups(setups: WebsiteSetup[]): void {
  const stored = window.sessionStorage.getItem(previewSettingsKey);
  const parsed: unknown = stored ? JSON.parse(stored) : {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Stored preview settings are invalid");
  window.sessionStorage.setItem(previewSettingsKey, JSON.stringify({ ...parsed, websiteSetups: setups }));
}
