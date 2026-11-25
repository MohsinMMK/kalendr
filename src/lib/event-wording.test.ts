import { describe, expect, it } from "vitest";

import {
  TITLE_MAX, cleanTitle, customerEntry, escapeIcsText, lengthText, renderWording, sampleValues, staffEntry, emptyEntryWording,
} from "./event-wording";

const values = { ...sampleValues("Glow Salon", "Main St", "1 Road, Pune", "Haircut", "Priya", 45), customer: "Sharma, Priya; \"PS\" 🎉", answers: { chair: "chair 2", notes: "allergic to dye" } };

describe("renderWording", () => {
  it("fills the built-in placeholders and question keys", () => {
    const { text, unknown } = renderWording("{service} with {person} ({length}) at {business}, {chair}", values, { questionKeys: ["chair"] });
    expect(text).toBe("Haircut with Priya (45 min) at Glow Salon, chair 2");
    expect(unknown).toEqual([]);
  });

  it("leaves an unknown placeholder as typed and reports it once", () => {
    const { text, unknown } = renderWording("{service} {typo} {typo}", values, { questionKeys: [] });
    expect(text).toBe("Haircut {typo} {typo}");
    expect(unknown).toEqual(["typo"]);
  });

  it("empties question answers when notes are hidden, without flagging them", () => {
    const { text, unknown } = renderWording("{service}: {notes}", values, { questionKeys: ["notes"], hideAnswers: true });
    expect(text).toBe("Haircut: ");
    expect(unknown).toEqual([]);
  });

  it("matches placeholders without regard to case", () => {
    expect(renderWording("{SERVICE}", values).text).toBe("Haircut");
  });
});

describe("titles", () => {
  it("strips line breaks and caps at 200 characters without cutting an emoji", () => {
    expect(cleanTitle("Line one\r\nLine two\n")).toBe("Line one Line two");
    const long = cleanTitle("🎉".repeat(300));
    expect(Array.from(long)).toHaveLength(TITLE_MAX);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toContain("�");
  });
});

describe("escapeIcsText", () => {
  it("escapes backslash, comma, semicolon and newlines in one place", () => {
    expect(escapeIcsText("a\\b, c; d\ne\r\nf")).toBe("a\\\\b\\, c\; d\\ne\\nf");
    expect(escapeIcsText("Sharma, Priya 🎉")).toBe("Sharma\\, Priya 🎉");
  });
});

describe("customerEntry and staffEntry", () => {
  const wording = { ...emptyEntryWording, customerTitle: "{service} with {person} (Kalendr)", staffTitle: "{customer}: {service}, {chair}", description: "Notes: {notes}" };

  it("keeps the customer's invite separate from the staff entry", () => {
    const customer = customerEntry(wording, values, "fallback", "");
    expect(customer.title).toBe("Haircut with Priya (Kalendr)");
    const staff = staffEntry(wording, values, { title: "x", description: null }, ["chair", "notes"]);
    expect(staff.title).toBe("Sharma, Priya; \"PS\" 🎉: Haircut, chair 2");
    expect(staff.description).toBe("Notes: allergic to dye");
  });

  it("hides notes everywhere when asked", () => {
    const hidden = { ...wording, hideNotes: true };
    expect(staffEntry(hidden, values, { title: "x", description: null }, ["chair", "notes"]).description).toBe("Notes:");
    expect(customerEntry(hidden, values, "f", "", ["notes"]).description).toBe("Notes:");
  });

  it("writes only 'Busy: business' when details are hidden, whatever else is set", () => {
    const entry = staffEntry({ ...wording, hideDetails: true }, values, { title: "Full title", description: "More", location: "Somewhere" }, ["chair"]);
    expect(entry).toEqual({ title: "Busy: Glow Salon", description: null });
  });

  it("falls back to the usual wording when nothing is set", () => {
    expect(customerEntry(emptyEntryWording, values, "Haircut · Glow Salon", "Appointment with Priya.")).toEqual({ title: "Haircut · Glow Salon", description: "Appointment with Priya." });
  });
});

describe("lengthText", () => {
  it("reads naturally", () => {
    expect([lengthText(30), lengthText(60), lengthText(90)]).toEqual(["30 min", "1 h", "1 h 30 min"]);
  });
});
