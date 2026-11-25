import { beforeEach, describe, expect, it } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { ApiError } from "@/server/api-error";
import {
  createPreviewAppointment,
  getPreviewManageSnapshot,
  managePreviewAppointment,
  resetPreviewStoreForTests,
} from "@/server/preview-repository";

const booking: PublicBookingInput = {
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
  lastName: "Patient",
  phone: "+91 90000 00000",
  email: "test.patient@example.com",
  preferredChannel: "sms",
  acceptedPrivacyNotice: true,
  messagingConsent: false,
};

describe("preview appointment repository", () => {
  beforeEach(() => resetPreviewStoreForTests());

  it("replays the same booking for the same idempotency key", () => {
    const first = createPreviewAppointment(booking, "booking-key-0001", "hash-a");
    const replay = createPreviewAppointment(booking, "booking-key-0001", "hash-a");

    expect(replay).toEqual(first);
  });

  it("rejects reuse of an idempotency key with a different request", () => {
    createPreviewAppointment(booking, "booking-key-0001", "hash-a");

    expect(() =>
      createPreviewAppointment(booking, "booking-key-0001", "hash-b"),
    ).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
  });

  it("allows only one active booking for a slot", () => {
    createPreviewAppointment(booking, "booking-key-0001", "hash-a");

    try {
      createPreviewAppointment(booking, "booking-key-0002", "hash-b");
      throw new Error("Expected slot conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("slot_unavailable");
    }
  });

  it("backs patient confirmation with a versioned server mutation", () => {
    const created = createPreviewAppointment(
      booking,
      "booking-key-0001",
      "hash-a",
    );
    const before = getPreviewManageSnapshot(created.manageToken);
    const confirmed = managePreviewAppointment(created.manageToken, {
      action: "confirm",
      expectedVersion: before.appointment.version,
    });

    expect(confirmed.version).toBe(2);
    expect(
      getPreviewManageSnapshot(created.manageToken).appointment.confirmationStatus,
    ).toBe("confirmed");
    expect(() =>
      managePreviewAppointment(created.manageToken, {
        action: "cancel",
        expectedVersion: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "version_conflict" }));
  });
});
