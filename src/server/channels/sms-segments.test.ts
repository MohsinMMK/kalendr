import { describe, expect, it } from "vitest";

import { countSmsSegments, fillApprovedText } from "./sms-segments";

describe("countSmsSegments", () => {
  it("counts plain GSM-7 text as one segment up to 160 characters", () => {
    expect(countSmsSegments("a".repeat(160))).toEqual({ encoding: "gsm7", units: 160, segments: 1 });
    expect(countSmsSegments("a".repeat(161)).segments).toBe(2);
    expect(countSmsSegments("a".repeat(306)).segments).toBe(2);
    expect(countSmsSegments("a".repeat(307)).segments).toBe(3);
  });

  it("counts extension characters twice", () => {
    expect(countSmsSegments("{").units).toBe(2);
    expect(countSmsSegments("€".repeat(80))).toMatchObject({ encoding: "gsm7", units: 160, segments: 1 });
    expect(countSmsSegments("€".repeat(81)).segments).toBe(2);
  });

  it("does not split an extension character across two parts", () => {
    // 152 plain characters then "{" (2 units) cannot fit in the 153-unit part, so it starts the next.
    expect(countSmsSegments(`${"a".repeat(152)}{${"a".repeat(10)}`).segments).toBe(2);
    // Short enough for one 160-unit segment, so no split happens at all.
    expect(countSmsSegments(`${"a".repeat(152)}{`).segments).toBe(1);
  });

  it("counts Hindi as Unicode: 70 then 67 per part", () => {
    const hindi = "नमस्ते";
    expect(countSmsSegments(hindi)).toMatchObject({ encoding: "ucs2", units: hindi.length, segments: 1 });
    expect(countSmsSegments("अ".repeat(70)).segments).toBe(1);
    expect(countSmsSegments("अ".repeat(71)).segments).toBe(2);
    expect(countSmsSegments("अ".repeat(134)).segments).toBe(2);
    expect(countSmsSegments("अ".repeat(135)).segments).toBe(3);
  });

  it("switches the whole text to Unicode for one non-GSM character", () => {
    expect(countSmsSegments(`${"a".repeat(100)}😀`)).toMatchObject({ encoding: "ucs2", units: 102, segments: 2 });
  });

  it("counts an empty text as no segments", () => {
    expect(countSmsSegments("").segments).toBe(0);
  });
});

describe("fillApprovedText", () => {
  it("fills slots in order", () => {
    expect(fillApprovedText("Hi {#var#}, see {#var#}.", ["Asha", "x.in/m/abc"])).toBe("Hi Asha, see x.in/m/abc.");
  });
  it("leaves a slot empty when a value is missing", () => {
    expect(fillApprovedText("Hi {#var#}!", [])).toBe("Hi !");
  });
});
