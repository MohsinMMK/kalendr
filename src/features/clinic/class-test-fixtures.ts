import { vi } from "vitest";

import type { SessionDetail, SessionView } from "@/lib/classes-contracts";

/** Shared by the class screen tests: a catalog that says the live database is on, and sample sessions. */
export const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

const place = { id: "l1", clinicId: "c1", name: "Studio One", address: "", city: "", timezone: "Asia/Kolkata", accessibleEntrance: true };

export const lookupsMock = () => ({
  database: true,
  clinic: { currency: "INR" },
  locations: [place],
  practitioners: [{ id: "p1", name: "Asha Rao" }],
  getLocation: (id: string) => (id === "l1" ? place : undefined),
  locationName: () => "Studio One",
  practitionerName: (id: string) => (id === "p1" ? "Asha Rao" : "Teacher"),
});

export const session = (over: Partial<SessionView> = {}): SessionView => ({
  id: "s1", version: 3, serviceId: "svc1", serviceName: "Morning yoga", teacherId: "p1", teacherName: "Asha Rao", locationId: "l1",
  startsAt: "2026-11-23T04:30:00.000Z", endsAt: "2026-11-23T05:30:00.000Z", capacity: 10, status: "scheduled", seatsTaken: 8, waiting: 3, seriesId: null, ...over,
});

export const detail = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  ...session(),
  roster: [
    { enrolmentId: "e1", version: 2, patientId: "pa1", name: "Bela Nair", status: "booked", offerExpiresAt: null, source: "online", position: null },
    { enrolmentId: "e2", version: 1, patientId: "pa2", name: "Chirag Shah", status: "attended", offerExpiresAt: null, source: "walk_in", position: null },
    { enrolmentId: "e3", version: 1, patientId: "pa3", name: "Dev Patel", status: "waitlisted", offerExpiresAt: "2026-11-23T03:30:00.000Z", source: "online", position: 1 },
  ],
  ...over,
});

/** jsdom has no matchMedia, which the bottom-sheet check reads. */
export function stubMatchMedia() {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
}
