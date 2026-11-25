import { describe, expect, it } from "vitest";

import { previewBrand } from "../emails/_shared/brand";
import { renderEmail } from "../server/messaging/email-templates";
import { renderStaffEmail } from "./staff-email";

describe("the owner summary email", () => {
  it("renders the numbers and the change in the body", async () => {
    const body = JSON.stringify({
      periodWord: "week", periodLabel: "16 November to 22 November", reportsUrl: "https://kalendr.example/reports",
      rows: [{ label: "Bookings", value: "42", change: "up 12%" }, { label: "Revenue", value: "₹18,500", change: "down 5%" }],
    });
    const render = renderStaffEmail("staff.summary", body);
    expect(render).not.toBeNull();
    const email = await render!(previewBrand);
    expect(email.subject).toBe("Your week in numbers: 16 November to 22 November");
    expect(email.html).toContain("Bookings: 42 (up 12%)");
    expect(email.text).toContain("Revenue: ₹18,500 (down 5%)");
  });

  it("refuses a body that is not a summary", () => {
    expect(renderStaffEmail("staff.summary", "{}")).toBeNull();
    expect(renderStaffEmail("staff.summary", "not json")).toBeNull();
  });

  it("is a registered template", async () => {
    const email = await renderEmail("owner_summary", { brand: previewBrand, periodWord: "month", periodLabel: "1 November to 30 November", rows: [], reportsUrl: "https://kalendr.example/reports" });
    expect(email.subject).toContain("month");
  });
});
