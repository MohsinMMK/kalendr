import { describe, expect, it } from "vitest";

import { businessTypeIds, businessTypes, featureKeys, isClinicalBusinessType, termKeys } from "./business-types";
import {
  cleanFeatureOverrides,
  cleanTerminologyOverrides,
  defaultBusinessProfile,
  resolveBusinessProfile,
  sharedBusinessProfile,
  profileWords,
  termWords,
  withArticle,
} from "./terminology";

const clinicalWords = /\b(patients?|doctors?|clinics?|clinical|practitioners?|dental|dentist|medical|prescriptions?)\b/i;

describe("business type presets", () => {
  it.each(businessTypeIds)("%s resolves with every term, feature and at least one starter service", (id) => {
    const profile = resolveBusinessProfile({ businessType: id });
    expect(profile.businessType).toBe(id);
    for (const key of termKeys) {
      expect(profile.terms[key].singular.length).toBeGreaterThan(0);
      expect(profile.terms[key].plural.length).toBeGreaterThan(0);
    }
    for (const key of featureKeys) expect(typeof profile.features[key]).toBe("boolean");
    expect(businessTypes[id].starterServices.length).toBeGreaterThan(0);
    expect(profile.resourceKinds.length).toBeGreaterThan(0);
    for (const service of businessTypes[id].starterServices) {
      if (service.requiredResourceKind) expect(businessTypes[id].resourceKinds).toContain(service.requiredResourceKind);
    }
  });

  it.each(businessTypeIds.filter((id) => !isClinicalBusinessType(id)))("%s has no clinical words or clinical features", (id) => {
    const preset = businessTypes[id];
    const profile = resolveBusinessProfile({ businessType: id });
    const words = [
      ...termKeys.flatMap((key) => [profile.terms[key].singular, profile.terms[key].plural]),
      ...Object.values(preset.providerFields),
      ...preset.starterServices.flatMap((service) => [service.name, service.description]),
      preset.label,
      preset.description,
      preset.examples,
    ];
    for (const word of words) expect(word).not.toMatch(clinicalWords);
    expect(profile.features.records).toBe(false);
    expect(profile.features.dateOfBirth).toBe(false);
    expect(profile.features.providerCredentials).toBe(false);
  });

  it("keeps healthcare wording for existing clinics", () => {
    expect(defaultBusinessProfile.businessType).toBe("healthcare");
    const t = termWords(defaultBusinessProfile.terms);
    expect([t.Customers, t.Providers, t.business]).toEqual(["Patients", "Doctors", "clinic"]);
    expect(defaultBusinessProfile.features).toEqual({
      records: true,
      recalls: true,
      dependents: true,
      dateOfBirth: true,
      providerCredentials: true,
      customerTypes: true,
      notifyOnMove: true,
    });
    expect(resolveBusinessProfile({ businessType: "dental" }).terms.resource.singular).toBe("chair");
  });

  it("falls back to healthcare for an unknown or missing type", () => {
    expect(resolveBusinessProfile({ businessType: "spaceship" }).businessType).toBe("healthcare");
    expect(resolveBusinessProfile({ businessType: null }).businessType).toBe("healthcare");
  });
});

describe("overrides", () => {
  it("lets the owner rename words and switch features", () => {
    const profile = resolveBusinessProfile({
      businessType: "wellness",
      terminology: { provider: { singular: "barber", plural: "barbers" }, customer: { plural: "guests" } },
      features: { recalls: false, dependents: true },
    });
    expect(profile.terms.provider).toEqual({ singular: "barber", plural: "barbers" });
    expect(profile.terms.customer).toEqual({ singular: "client", plural: "guests" });
    expect(profile.features.recalls).toBe(false);
    expect(profile.features.dependents).toBe(true);
    expect(profile.terminologyOverrides).toEqual({
      provider: { singular: "barber", plural: "barbers" },
      customer: { plural: "guests" },
    });
    expect(profile.featureOverrides).toEqual({ recalls: false, dependents: true });
  });

  it("ignores unknown keys, blank or overlong words and non-boolean flags", () => {
    expect(cleanTerminologyOverrides({
      customer: { singular: "  guest  ", plural: "" },
      provider: { singular: "x".repeat(41) },
      unknown: { singular: "thing" },
      business: "salon",
    })).toEqual({ customer: { singular: "guest" } });
    expect(cleanTerminologyOverrides({ customer: { singular: "gu\u0000est\nlist" } })).toEqual({ customer: { singular: "gu est list" } });
    expect(cleanTerminologyOverrides(null)).toEqual({});
    expect(cleanTerminologyOverrides(["customer"])).toEqual({});
    expect(cleanFeatureOverrides({ records: "yes", recalls: false, extra: true })).toEqual({ recalls: false });
  });
});

describe("term words", () => {
  it("gives sentence and label forms with articles", () => {
    const t = termWords(resolveBusinessProfile({ businessType: "real_estate" }).terms);
    expect(t.Appointments).toBe("Viewings");
    expect(t.anAppointment).toBe("a viewing");
    expect(t.aProvider).toBe("an agent");
    expect(t.businesses).toBe("agencies");
  });

  it("keeps acronyms the owner typed", () => {
    const t = termWords(resolveBusinessProfile({
      businessType: "healthcare",
      terminology: { provider: { singular: "GP", plural: "GPs" }, customer: { singular: "Member", plural: "Members" } },
    }).terms);
    expect(t.provider).toBe("GP");
    expect(t.customer).toBe("member");
    expect(t.Customer).toBe("Member");
  });

  it("chooses a or an", () => {
    expect(withArticle("appointment")).toBe("an appointment");
    expect(withArticle("stylist")).toBe("a stylist");
  });
});

describe("shared profile", () => {
  it("keeps one business's words and falls back to plain words for a mix", () => {
    const dental = resolveBusinessProfile({ businessType: "dental" });
    const salon = resolveBusinessProfile({ businessType: "wellness" });
    expect(sharedBusinessProfile([])).toBe(defaultBusinessProfile);
    expect(sharedBusinessProfile([dental, dental])).toBe(dental);
    const mixed = sharedBusinessProfile([dental, salon]);
    expect(termWords(mixed.terms).customer).toBe("customer");
    expect(mixed.features.records).toBe(false);
    expect(mixed.features.recalls).toBe(true);
  });
});

describe("second words", () => {
  it("keeps visit, practitioner and practice for healthcare and dental only", () => {
    const clinic = profileWords(resolveBusinessProfile({ businessType: "dental" }));
    expect([clinic.Visits, clinic.practitioner, clinic.aPractice]).toEqual(["Visits", "practitioner", "a practice"]);
    const salon = profileWords(resolveBusinessProfile({ businessType: "wellness" }));
    expect([salon.Visits, salon.practitioner, salon.practice]).toEqual(["Appointments", "stylist", "salon"]);
  });

  it("follows the owner's rename instead of the type's second word", () => {
    const t = profileWords(resolveBusinessProfile({ businessType: "healthcare", terminology: { appointment: { singular: "session", plural: "sessions" } } }));
    expect([t.visit, t.Visits]).toEqual(["session", "Sessions"]);
    expect(t.practitioner).toBe("practitioner");
  });
});
