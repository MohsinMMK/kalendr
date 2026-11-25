/** @vitest-environment node */

import { describe, expect, it } from "vitest";

import { previewBrand } from "../emails/_shared/brand";
import { dayLabel } from "./handlers/staff-notify";
import { renderStaffEmail } from "./staff-email";

describe("staff emails", () => {
  it("renders an alert with the first name, the service and the time, and the link", async () => {
    const render = renderStaffEmail("staff.alert", JSON.stringify({ title: "New booking at 4:30 pm", detail: "Asha · Dental consultation · 4:30 pm", url: "https://kalendr.example/schedule?open=a1" }));
    const email = await render!(previewBrand);
    expect(email.subject).toBe("New booking at 4:30 pm");
    expect(email.text).toContain("Asha · Dental consultation · 4:30 pm");
    expect(email.html).toContain("https://kalendr.example/schedule?open=a1");
  });

  it("renders the morning summary with the day, the requests waiting and yesterday's cancellations", async () => {
    const body = JSON.stringify({
      dayLabel: "Friday 20 November", todayCount: 2, waiting: 1,
      today: [{ time: "9:00 am", firstName: "Asha", service: "Consultation" }, { time: "10:30 am", firstName: "Ravi", service: "Cleaning" }],
      cancelled: [{ time: "Thu 4:00 pm", firstName: "Meera", service: "Whitening" }],
      staffUrl: "https://kalendr.example/schedule",
    });
    const email = await renderStaffEmail("staff.digest", body)!(previewBrand);
    expect(email.subject).toBe("Friday 20 November: 2 bookings, 1 waiting for a yes");
    for (const text of ["9:00 am · Asha · Consultation", "10:30 am · Ravi · Cleaning", "Meera", "1 request is waiting"]) expect(email.text).toContain(text);
  });

  it("refuses a body it does not understand, so nothing odd is sent", () => {
    expect(renderStaffEmail("staff.alert", "not json")).toBeNull();
    expect(renderStaffEmail("staff.alert", JSON.stringify({ title: "" }))).toBeNull();
    expect(renderStaffEmail("staff.digest", JSON.stringify({ today: "no" }))).toBeNull();
    expect(renderStaffEmail("staff.other", "{}")).toBeNull();
  });

  it("writes the day from a plain calendar date", () => {
    expect(dayLabel("2026-11-20")).toBe("Friday 20 November");
  });
});
