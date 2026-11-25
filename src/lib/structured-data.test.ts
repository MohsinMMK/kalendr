import { describe, expect, it } from "vitest";

import { businessStructuredData, jsonLdScript } from "./structured-data";

const base = { name: "Smile Dental", url: "https://example.test/b/smile", businessType: "dental" as const };

describe("business structured data", () => {
  it("picks the schema.org type from the business type", () => {
    expect(businessStructuredData(base)["@type"]).toBe("Dentist");
    expect(businessStructuredData({ ...base, businessType: "healthcare" })["@type"]).toBe("MedicalClinic");
    expect(businessStructuredData({ ...base, businessType: "wellness" })["@type"]).toBe("BeautySalon");
    expect(businessStructuredData({ ...base, businessType: "other" })["@type"]).toBe("LocalBusiness");
    expect(businessStructuredData({ name: "X", url: "https://example.test" })["@type"]).toBe("MedicalClinic");
  });

  it("includes address, phone, hours and services with prices, and leaves out what is missing", () => {
    const data = businessStructuredData({
      ...base,
      phone: "+912212345678",
      address: { street: "1 Test Road", city: "Mumbai" },
      hours: [{ opens: "09:00", closes: "18:00" }, null, { opens: "10:00", closes: "14:00" }],
      services: [{ name: "Check-up", priceMinor: 50000, url: "https://example.test/book/smile/check-up" }, { name: "Free chat", priceMinor: null, url: "https://example.test/book/smile/chat" }],
      currency: "INR",
    });
    expect(data.address).toEqual({ "@type": "PostalAddress", streetAddress: "1 Test Road", addressLocality: "Mumbai" });
    expect(data.telephone).toBe("+912212345678");
    expect(data.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Monday", opens: "09:00", closes: "18:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Wednesday", opens: "10:00", closes: "14:00" },
    ]);
    const offers = data.makesOffer as { price?: string; priceCurrency?: string }[];
    expect(offers[0]).toMatchObject({ price: "500.00", priceCurrency: "INR" });
    expect(offers[1]?.price).toBeUndefined();
    expect(businessStructuredData(base)).not.toHaveProperty("address");
  });

  it("states a rating only when there are published reviews", () => {
    expect(businessStructuredData({ ...base, rating: { count: 0, average: null } })).not.toHaveProperty("aggregateRating");
    expect(businessStructuredData({ ...base, rating: null })).not.toHaveProperty("aggregateRating");
    expect(businessStructuredData({ ...base, rating: { count: 12, average: 4.6 } }).aggregateRating).toEqual({ "@type": "AggregateRating", ratingValue: 4.6, reviewCount: 12, bestRating: 5, worstRating: 1 });
  });
});

describe("JSON-LD script text", () => {
  it("cannot be broken out of by a business named </script>", () => {
    const hostile = "</script><script>alert(1)</script>";
    const text = jsonLdScript(businessStructuredData({ ...base, name: hostile, description: `<!-- ${hostile}` }));
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text.toLowerCase()).not.toContain("</script");
    // A JSON reader gets the original name back.
    expect(JSON.parse(text).name).toBe(hostile);
  });

  it("escapes ampersands and the line separators", () => {
    const separators = String.fromCharCode(0x2028, 0x2029);
    const name = `A & B${separators}C`;
    const text = jsonLdScript({ name });
    expect(text).not.toContain("&");
    expect(text).not.toContain(String.fromCharCode(0x2028));
    expect(text).not.toContain(String.fromCharCode(0x2029));
    expect(JSON.parse(text).name).toBe(name);
  });
});
