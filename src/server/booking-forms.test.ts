import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getAppointmentForm } from "@/app/api/staff/appointments/[id]/form/route";
import { PATCH as updateForm } from "@/app/api/staff/forms/[key]/route";
import { GET as listForms, POST as createForm } from "@/app/api/staff/forms/route";
import { POST as createBooking } from "@/app/api/public/appointments/route";
import { getPublicClinicCatalog } from "@/server/public-catalog";
import { resetPreviewFormsForTests } from "@/server/booking-forms";
import { resetPreviewStoreForTests } from "@/server/preview-repository";

const booking = {
  clinicSlug: "indiranagar-dental",
  patientType: "returning",
  bookingFor: "self",
  locationId: "loc_indiranagar",
  serviceId: "service_cleaning",
  practitionerId: "practitioner_asha",
  slotId: "slot_2026_09_01_0930_asha",
  startsAt: "2026-09-01T09:30:00+05:30",
  endsAt: "2026-09-01T10:15:00+05:30",
  firstName: "Test",
  lastName: "Customer",
  phone: "+91 90000 00000",
  email: "test.customer@example.com",
  preferredChannel: "sms",
  acceptedPrivacyNotice: true,
  messagingConsent: false,
};

const form = {
  name: "Before your appointment",
  description: "",
  appliesToAll: true,
  serviceIds: [],
  isActive: true,
  fields: [
    { id: "goal", type: "short_text", label: "What would you like done?", required: true },
    { id: "first", type: "yes_no", label: "First time?", required: false },
  ],
};

function jsonRequest(url: string, method: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

interface ApiErrorBody {
  code: string;
  fieldErrors: Record<string, string[]>;
}

async function json<T = Record<string, unknown>>(response: Response) {
  return (await response.json()) as { data: T; error: ApiErrorBody };
}

type Saved = { id: string; key: string; version: number };

const params = <T,>(value: T) => ({ params: Promise.resolve(value) });

describe("booking form routes in preview", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "");
    resetPreviewStoreForTests();
    resetPreviewFormsForTests();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("creates, lists and versions a form", async () => {
    const created = await createForm(jsonRequest("/api/staff/forms", "POST", form));
    expect(created.status).toBe(201);
    const { data: first } = await json<Saved>(created);
    expect(first).toMatchObject({ version: 1, name: form.name });

    const changed = await updateForm(
      jsonRequest(`/api/staff/forms/${first.key}`, "PATCH", { ...form, name: "Before you arrive" }),
      params({ key: first.key }),
    );
    expect(changed.status).toBe(200);
    const { data: second } = await json<Saved>(changed);
    expect(second).toMatchObject({ key: first.key, version: 2, name: "Before you arrive" });
    expect(second.id).not.toBe(first.id);

    const { data: list } = await json<Saved[]>(await listForms(new Request("http://localhost/api/staff/forms")));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: first.key, version: 2 });
  });

  it("explains what is wrong with a form", async () => {
    const response = await createForm(jsonRequest("/api/staff/forms", "POST", { ...form, fields: [] }));
    expect(response.status).toBe(422);
    const { error } = await json(response);
    expect(error.code).toBe("form_definition_invalid");
    expect(error.fieldErrors.fields).toEqual(["Add at least one question."]);
  });

  it("answers 404 for a form that does not exist", async () => {
    const response = await updateForm(jsonRequest("/api/staff/forms/form_missing", "PATCH", form), params({ key: "form_missing" }));
    expect(response.status).toBe(404);
  });

  it("puts switched-on forms on the booking page only", async () => {
    await createForm(jsonRequest("/api/staff/forms", "POST", form));
    await createForm(jsonRequest("/api/staff/forms", "POST", { ...form, name: "Off", isActive: false }));
    const catalog = await getPublicClinicCatalog("indiranagar-dental");
    expect(catalog?.forms?.map((entry) => entry.name)).toEqual([form.name]);
  });

  it("refuses a booking with missing answers, then stores good answers for staff", async () => {
    await createForm(jsonRequest("/api/staff/forms", "POST", form));

    const refused = await createBooking(jsonRequest("/api/public/appointments", "POST", booking, { "idempotency-key": "booking-key-forms-0001" }));
    expect(refused.status).toBe(422);
    const { error } = await json(refused);
    expect(error.code).toBe("form_invalid");
    expect(error.fieldErrors["formAnswers.goal"]).toEqual(["Answer this question."]);

    const body = { ...booking, formAnswers: { goal: " A trim ", first: true } };
    const accepted = await createBooking(jsonRequest("/api/public/appointments", "POST", body, { "idempotency-key": "booking-key-forms-0002" }));
    expect(accepted.status).toBe(201);
    const { data: created } = await json<{ appointmentId: string }>(accepted);

    const replay = await createBooking(jsonRequest("/api/public/appointments", "POST", body, { "idempotency-key": "booking-key-forms-0002" }));
    expect((await json<{ appointmentId: string }>(replay)).data.appointmentId).toBe(created.appointmentId);

    const answers = await getAppointmentForm(new Request("http://localhost/"), params({ id: created.appointmentId }));
    const { data } = await json<{ fields: { id: string }[] }>(answers);
    expect(data).toMatchObject({ name: form.name, version: 1, answers: { goal: "A trim", first: true } });
    expect(data.fields.map((field: { id: string }) => field.id)).toEqual(["goal", "first"]);
  });

  it("refuses answers when the service has no form, and returns null answers for a booking without one", async () => {
    const response = await createBooking(jsonRequest("/api/public/appointments", "POST", { ...booking, formAnswers: { goal: "x" } }, { "idempotency-key": "booking-key-forms-0003" }));
    expect(response.status).toBe(422);
    const plain = await createBooking(jsonRequest("/api/public/appointments", "POST", booking, { "idempotency-key": "booking-key-forms-0004" }));
    const { data: created } = await json<{ appointmentId: string }>(plain);
    const { data } = await json(await getAppointmentForm(new Request("http://localhost/"), params({ id: created.appointmentId })));
    expect(data).toBeNull();
  });
});
