import { describe, expect, it } from "vitest";

import { createAppointmentCalendar } from "@/server/icalendar";

describe("createAppointmentCalendar", () => {
  it("exports a privacy-safe, updateable iCalendar event", () => {
    const calendar = createAppointmentCalendar(
      {
        appointmentId: "appointment_123",
        version: 3,
        status: "booked",
        startsAt: "2026-08-31T04:30:00.000Z",
        endsAt: "2026-08-31T05:00:00.000Z",
        clinicName: "Indiranagar Dental",
        clinicPhone: "+91 80 4000 2211",
        serviceName: "Dental consultation",
        practitionerName: "Dr. Meera Shah",
        locationName: "Indiranagar Clinic",
        locationAddress: "100 Feet Road",
        locationCity: "Bengaluru",
      },
      new Date("2026-08-30T12:00:00.000Z"),
    );

    expect(calendar).toContain("UID:appointment_123@kalendr.app");
    expect(calendar).toContain("DTSTAMP:20260830T120000Z");
    expect(calendar).toContain("DTSTART:20260831T043000Z");
    expect(calendar).toContain("SEQUENCE:3");
    expect(calendar).toContain("STATUS:CONFIRMED");
    expect(calendar).not.toMatch(/patient|token|email/i);
    expect(calendar.endsWith("\r\n")).toBe(true);
  });

  it("uses the business's own title and keeps the usual contact line when only a title is set (feature 50)", () => {
    const calendar = createAppointmentCalendar({
      appointmentId: "appointment_9", version: 1, status: "booked", startsAt: "2026-08-31T04:30:00.000Z", endsAt: "2026-08-31T05:00:00.000Z",
      clinicName: "Glow Salon", clinicPhone: "+91 80 4000 2211", serviceName: "Haircut", practitionerName: "Priya",
      locationName: "", locationAddress: "", locationCity: "", entry: { title: "Haircut with Priya, (Kalendr)", description: null },
    });
    expect(calendar).toContain("SUMMARY:Haircut with Priya\\, (Kalendr)");
    expect(calendar.replace(/\r\n /g, "")).toMatch(/DESCRIPTION:Appointment with Priya\. For changes\\, contact Glow Salon at \+91 80 4000 2211\./);
  });
});
