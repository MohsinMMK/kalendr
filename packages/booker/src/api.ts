/** A small client for the public booking API. It sends no key: everything it calls is open to any visitor. */

export interface BookerService {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  priceLabel: string | null;
  priceMinor: number | null;
  category: string | null;
  personIds: string[];
  locationIds: string[];
}
export interface BookerPerson { id: string; name: string; title: string; specialty: string }
export interface BookerLocation { id: string; name: string; timezone: string }
export interface BookerCatalog {
  business: { name: string; timezone: string };
  locations: BookerLocation[];
  services: BookerService[];
  people: BookerPerson[];
}
export interface BookerSlot { id: string; startsAt: string; endsAt: string; practitionerId: string }

export interface BookerDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export class BookerApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "BookerApiError";
  }
}

export interface BookerApi {
  catalog(): Promise<BookerCatalog>;
  slots(input: { serviceId: string; locationId: string; personId?: string | undefined; from: Date; to: Date }): Promise<BookerSlot[]>;
  book(input: { serviceId: string; locationId: string; slot: BookerSlot; details: BookerDetails; agreedToPrivacyNotice: boolean; idempotencyKey: string }): Promise<{ appointmentId: string; status: string; startsAt: string }>;
}

async function unwrap<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // fall through to the generic error below
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as { data?: T; error?: { code?: string; message?: string } };
  if (!response.ok || record.data === undefined) {
    throw new BookerApiError(record.error?.code ?? "request_failed", record.error?.message ?? "Something went wrong. Please try again.", response.status);
  }
  return record.data;
}

export function createBookerApi(options: { baseUrl: string; clinicSlug: string; fetch?: typeof fetch }): BookerApi {
  const base = options.baseUrl.replace(/\/$/, "");
  const call = (input: string, init?: RequestInit) => (options.fetch ?? globalThis.fetch)(`${base}${input}`, init);
  return {
    async catalog() {
      return unwrap<BookerCatalog>(await call(`/api/public/catalog?clinicSlug=${encodeURIComponent(options.clinicSlug)}`));
    },
    async slots(input) {
      const query = new URLSearchParams({
        clinicSlug: options.clinicSlug, locationId: input.locationId, serviceId: input.serviceId,
        practitionerId: input.personId ?? "first_available", from: input.from.toISOString(), to: input.to.toISOString(),
      });
      return (await unwrap<{ slots: BookerSlot[] }>(await call(`/api/public/availability?${query.toString()}`))).slots;
    },
    async book(input) {
      const { details, slot } = input;
      return unwrap(await call("/api/public/appointments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify({
          clinicSlug: options.clinicSlug, patientType: "new", bookingFor: "self", locationId: input.locationId, serviceId: input.serviceId,
          practitionerId: slot.practitionerId, slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt,
          firstName: details.firstName, lastName: details.lastName, phone: details.phone, email: details.email,
          preferredChannel: details.email ? "email" : "sms", acceptedPrivacyNotice: input.agreedToPrivacyNotice, messagingConsent: false,
          origin: { channel: "widget", utmSource: "booker" },
        }),
      }));
    },
  };
}
