import { describe, expect, it } from "vitest";

import { weeklyHoursSchema } from "./availability-setup";
import { businessTypes } from "./business-types";
import { clinicRegistrationSchema } from "./clinic-registration";
import { defaultTemplateFor, getOnboardingTemplate, onboardingTemplateIds, onboardingTemplates, questionField } from "./onboarding-templates";
import { cleanTerminologyOverrides, profileWords, resolveBusinessProfile } from "./terminology";
import { formFieldTypes } from "./booking-forms";
import { workflowPresetsFor } from "./workflow-presets";

describe("onboarding templates", () => {
  it("covers the nine kinds of business the spec names, plus something else", () => {
    expect(onboardingTemplateIds).toEqual(["general_practice", "dental", "physiotherapy", "salon", "spa", "barber", "tutoring", "consulting", "fitness", "other"]);
  });

  it.each(onboardingTemplateIds)("%s has typical services, valid hours, one booking question, and words that read right", (id) => {
    const template = onboardingTemplates[id];
    expect(template.id).toBe(id);
    expect(template.services.length).toBeGreaterThan(0);
    for (const service of template.services) {
      expect(service.durationMinutes).toBeGreaterThanOrEqual(10);
      expect(service.durationMinutes).toBeLessThanOrEqual(120);
      expect(service.name.length).toBeGreaterThan(2);
      if (service.priceRupees !== undefined) expect(Number.isInteger(service.priceRupees) && service.priceRupees > 0).toBe(true);
    }
    expect(new Set(template.services.map((service) => service.name)).size).toBe(template.services.length);
    expect(weeklyHoursSchema.safeParse(template.hours).success).toBe(true);
    expect(Object.values(template.hours).some((ranges) => ranges.length > 0)).toBe(true);
    expect(formFieldTypes).toContain(template.question.type);
    expect(questionField(template.question)).toMatchObject({ label: template.question.label, required: false });
    // The words the owner sees must be usable terms.
    expect(Object.keys(cleanTerminologyOverrides(template.words)).sort()).toEqual(Object.keys(template.words).sort());
    expect(businessTypes[template.businessType]).toBeDefined();
    expect(workflowPresetsFor(template.businessType).length).toBeGreaterThan(0);
    const words = profileWords(resolveBusinessProfile({ businessType: template.businessType, terminology: template.words }));
    expect(words.provider.length).toBeGreaterThan(2);
  });

  it("gives each business a broad type that matches how it talks", () => {
    expect(onboardingTemplates.salon.words.provider?.singular).toBe("stylist");
    expect(onboardingTemplates.tutoring.words.customer?.singular).toBe("student");
    expect(onboardingTemplates.dental.businessType).toBe("dental");
    expect(onboardingTemplates.general_practice.businessType).toBe("healthcare");
    expect(onboardingTemplates.consulting.businessType).toBe("professional_services");
    // Only the clinical templates carry clinical words and features.
    for (const id of onboardingTemplateIds) {
      const clinical = ["healthcare", "dental"].includes(onboardingTemplates[id].businessType);
      expect(clinical).toBe(["general_practice", "dental", "physiotherapy"].includes(id));
    }
  });

  it("falls back to a template for any broad type, and for an unknown id", () => {
    expect(defaultTemplateFor("healthcare")).toBe("general_practice");
    expect(defaultTemplateFor("dental")).toBe("dental");
    expect(defaultTemplateFor("real_estate")).toBe("other");
    expect(getOnboardingTemplate("nonsense").id).toBe("other");
    expect(getOnboardingTemplate(undefined).id).toBe("other");
  });

  it("accepts a registration with only the four details, and refuses an unknown template", () => {
    const base = { clinicName: "Glow Studio", slug: "glow-studio", ownerName: "Asha Rao", email: "asha@example.com", password: "a-long-example-password" };
    expect(clinicRegistrationSchema.safeParse({ ...base, template: "salon" }).success).toBe(true);
    expect(clinicRegistrationSchema.safeParse({ ...base, template: "airline" }).success).toBe(false);
    expect(clinicRegistrationSchema.safeParse({ ...base, phone: "12" }).success).toBe(false);
    expect(clinicRegistrationSchema.safeParse({ ...base, city: "P" }).success).toBe(false);
    expect(clinicRegistrationSchema.safeParse({ ...base, phone: "+91 90000 00000", city: "Pune", address: "1 Main Road" }).success).toBe(true);
  });
});
