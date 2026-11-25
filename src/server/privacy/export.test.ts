/** @vitest-environment node */
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildExportZip, exportReadableLines, type CustomerExport } from "./export";
import { buildTextPdf, wrapText } from "./pdf";
import { listBreachAffected, summariseAffected, validateWindow } from "./breach";

const data: CustomerExport = {
  generatedAt: "2026-11-19T10:00:00.000Z",
  business: { name: "Lotus Dental" },
  profile: { first_name: "Asha", last_name: "Rao", phone: "+919800000001" },
  consents: { current: { appointment_messages: true, marketing_messages: false, reviews: true, records_sharing: true }, history: [] },
  appointments: [{ id: "a1", service: "Check-up", notes: "Prefers mornings" }],
  formAnswers: [{ form: "intake", answers: { allergy: "None" } }],
  messages: [],
  payments: [{ id: "p1", amount_minor: 50000, currency: "INR" }],
  reviews: [],
  waitlist: [],
  classPlaces: [],
  followUps: [],
  privacyRequests: [],
  sharedRecords: [{ kind: "report", title: "Blood test", body: "Normal" }],
  notes: ["The PDF can only show Western European letters. The JSON file is the complete copy."],
};

describe("export zip", () => {
  it("holds a README, the complete JSON and a readable PDF", () => {
    const files = unzipSync(buildExportZip(data));
    expect(Object.keys(files).sort()).toEqual(["README.txt", "data.json", "summary.pdf"]);
    const json = JSON.parse(strFromU8(files["data.json"]!)) as CustomerExport;
    expect(json.profile.first_name).toBe("Asha");
    expect(json.payments).toHaveLength(1);
    expect(strFromU8(files["summary.pdf"]!).startsWith("%PDF-1.4")).toBe(true);
    expect(strFromU8(files["README.txt"]!)).toMatch(/Lotus Dental/);
  });

  it("lists every section in the readable copy", () => {
    const text = exportReadableLines(data).map((line) => line.text).join("\n");
    for (const heading of ["About you", "Bookings (1)", "Payments and refunds (1)", "Records shared with you (1)"]) expect(text).toContain(heading);
  });
});

describe("text PDF", () => {
  it("writes a cross-reference table whose offsets point at each object", () => {
    const bytes = Buffer.from(buildTextPdf("Title (with) brackets", [{ text: "Hello (world) \\ test" }, { text: "x".repeat(300) }]));
    const text = bytes.toString("latin1");
    const xref = text.indexOf("xref\n");
    const entries = text.slice(xref).split("\n").slice(3).filter((line) => /^\d{10} 00000 n/.test(line));
    expect(entries.length).toBeGreaterThan(4);
    entries.forEach((entry, index) => {
      expect(text.slice(Number(entry.slice(0, 10))).startsWith(`${index + 1} 0 obj`)).toBe(true);
    });
    expect(text).toContain("Hello \\(world\\) \\\\ test");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });

  it("prints letters outside the font as a question mark and wraps long lines", () => {
    expect(wrapText("नमस्ते Asha")[0]).toMatch(/^\?+ Asha$/);
    expect(wrapText("word ".repeat(60)).every((line) => line.length <= 92)).toBe(true);
    expect(wrapText("y".repeat(200)).length).toBe(3);
  });

  it("starts a new page when the text is long", () => {
    const lines = Array.from({ length: 200 }, (_, index) => ({ text: `line ${index}` }));
    expect(Buffer.from(buildTextPdf("Long", lines)).toString("latin1")).toMatch(/\/Count 4/);
  });
});

describe("breach window", () => {
  it("must be in order and at most 92 days", () => {
    expect(() => validateWindow(new Date("2026-11-02"), new Date("2026-11-01"))).toThrow(/after its start/);
    expect(() => validateWindow(new Date("2026-01-01"), new Date("2026-06-01"))).toThrow(/at most 92 days/);
    expect(() => validateWindow(new Date("2026-11-01"), new Date("2026-11-02"))).not.toThrow();
  });

  it("counts customers and staff per business", () => {
    const at = new Date();
    const rows = [
      { tenantId: "a", kind: "tenant" as const, subjectId: "a", firstSeen: at, lastSeen: at },
      { tenantId: "a", kind: "customer" as const, subjectId: "p1", firstSeen: at, lastSeen: at },
      { tenantId: "a", kind: "customer" as const, subjectId: "p2", firstSeen: at, lastSeen: at },
      { tenantId: "a", kind: "staff_user" as const, subjectId: "u1", firstSeen: at, lastSeen: at },
      { tenantId: "b", kind: "customer" as const, subjectId: "p3", firstSeen: at, lastSeen: at },
    ];
    expect(summariseAffected(rows)).toEqual([{ tenantId: "a", customers: 2, staff: 1 }, { tenantId: "b", customers: 1, staff: 0 }]);
    expect(typeof listBreachAffected).toBe("function");
  });
});
