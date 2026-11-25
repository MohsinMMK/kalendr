/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { decodeCursor, encodeCursor, pageOf } from "@/server/api-v1";
import {
  appointmentSchema, availabilityQuery, createAppointmentBody, customerSchema, errorSchema, listOf, serviceSchema, slotSchema, staffSchema,
} from "@/server/api-v1-contracts";

describe("v1 contracts", () => {
  it("round-trips each shape", () => {
    const service = { id: "s1", name: "Cut", description: "", durationMinutes: 30, priceMinor: null, priceLabel: null, category: null, bookingMode: "instant", isActive: true };
    expect(serviceSchema.parse(service)).toEqual(service);
    const staff = { id: "p1", name: "A", title: "T", specialty: "S", isActive: true };
    expect(staffSchema.parse(staff)).toEqual(staff);
    const slot = { startsAt: "2026-12-01T09:30:00.000Z", endsAt: "2026-12-01T10:00:00.000Z", staffId: "p1" };
    expect(slotSchema.parse(slot)).toEqual(slot);
    const appointment = {
      id: "a1", status: "booked", startsAt: "2026-12-01T09:30:00.000Z", endsAt: "2026-12-01T10:00:00.000Z", serviceId: "s1", staffId: "p1",
      customerId: "c1", locationId: "l1", source: "staff", notes: null, reasonForVisit: null, version: 1, createdAt: "2026-11-20T08:00:00.000Z", cancelledAt: null,
    };
    expect(appointmentSchema.parse(appointment)).toEqual(appointment);
    const customer = { id: "c1", firstName: "A", lastName: "B", phone: "+919000000001", email: "a@example.com", dateOfBirth: null, tags: ["VIP"], blocked: false, createdAt: "2026-11-20T08:00:00.000Z" };
    expect(customerSchema.parse(customer)).toEqual(customer);
    expect(errorSchema.parse({ error: { code: "x", message: "y", fieldErrors: { a: ["b"] } } })).toBeTruthy();
    expect(listOf(serviceSchema).parse({ data: [service], nextCursor: null, hasMore: false }).data).toHaveLength(1);
  });

  it("insists on exactly one of customerId and customer when booking", () => {
    const base = { serviceId: "s1", staffId: "p1", startsAt: "2026-12-01T09:30:00+05:30" };
    expect(createAppointmentBody.safeParse(base).success).toBe(false);
    expect(createAppointmentBody.safeParse({ ...base, customerId: "c1" }).success).toBe(true);
    expect(createAppointmentBody.safeParse({ ...base, customerId: "c1", customer: { firstName: "A", lastName: "B", phone: "+919000000001", email: "a@example.com" } }).success).toBe(false);
  });

  it("rejects an availability range that is backwards or too long", () => {
    const base = { serviceId: "s1", from: "2026-12-01T00:00:00Z" };
    expect(availabilityQuery.safeParse({ ...base, to: "2026-12-02T00:00:00Z" }).success).toBe(true);
    expect(availabilityQuery.safeParse({ ...base, to: "2026-11-30T00:00:00Z" }).success).toBe(false);
    expect(availabilityQuery.safeParse({ ...base, to: "2027-03-01T00:00:00Z" }).success).toBe(false);
  });
});

describe("cursors", () => {
  it("round-trips a position", () => {
    const position = { t: "2026-12-01T09:30:00.000Z", id: "abc" };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
    expect(decodeCursor(undefined)).toBeNull();
  });

  it.each(["!!!", "bm90IGpzb24", Buffer.from("{}").toString("base64url"), Buffer.from('{"t":1,"id":2}').toString("base64url")])("refuses garbage %s", (garbage) => {
    expect(() => decodeCursor(garbage)).toThrowError(expect.objectContaining({ status: 400, code: "invalid_cursor" }));
  });

  it("gives a next cursor only when there is another row", () => {
    const rows = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const position = (row: { id: string }) => ({ t: "x", id: row.id });
    const first = pageOf(rows, 2, position);
    expect(first.items).toHaveLength(2);
    expect(decodeCursor(first.nextCursor ?? undefined)).toEqual({ t: "x", id: "2" });
    expect(pageOf(rows, 3, position).nextCursor).toBeNull();
  });
});
