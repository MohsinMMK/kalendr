import { z } from "zod";

import { businessTypeIds, type BusinessTypeId } from "./business-types";
import { profileWords, resolveBusinessProfile } from "./terminology";
import { parseClinicSlug } from "./clinic-slug";
import { onboardingTemplateSchema } from "./onboarding-templates";

const ownerPracticeSchema = z.object({
  name: z.string().trim().min(2).max(160),
  title: z.string().trim().min(2).max(120),
  specialty: z.string().trim().min(2).max(160),
});

/** Shared by the registration form and API; contains no server dependencies. */
export const clinicRegistrationSchema = z
  .object({
    businessType: z.enum(businessTypeIds).default("healthcare"),
    /** The starting point for services, hours and words (feature 11). When given, its broad type replaces `businessType`. */
    template: onboardingTemplateSchema.optional(),
    clinicName: z
      .string()
      .trim()
      .min(2, "Enter the business name your customers know.")
      .max(160),
    legalName: z.string().trim().max(200).optional(),
    slug: z.string().trim().min(2).max(80),
    /** Asked later (when the owner makes a test booking, or in the business profile). Empty until then. */
    phone: z
      .string()
      .trim()
      .max(32)
      .default("")
      .refine(
        (value) =>
          value === "" ||
          (/^\+?[\d\s().-]+$/.test(value) && value.replace(/\D/g, "").length >= 7),
        "Enter a business phone number, including the country code.",
      ),
    email: z.email("Enter a valid work email.").max(254),
    /** Set when the owner signed up with their email. Google or Microsoft owners have none until they choose one. */
    password: z.string().min(12, "Use at least 12 characters.").max(128).optional(),
    ownerName: z.string().trim().min(2, "Enter your name.").max(160),
    /** Asked later, in the business profile. Empty until then; the go-live check reminds the owner. */
    city: z.string().trim().max(120).default("").refine((value) => value === "" || value.length >= 2, "Enter your city or town."),
    address: z
      .string()
      .trim()
      .max(300)
      .default("")
      .refine((value) => value === "" || value.length >= 4, "Enter the street address customers should come to."),
    timezone: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .default("Asia/Kolkata")
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch (error: unknown) {
          if (error instanceof RangeError) return false;
          throw error;
        }
      }, "Choose a valid timezone."),
    locale: z.string().trim().min(2).max(32).default("en-IN"),
    ownerPractices: z.boolean().default(false),
    practice: ownerPracticeSchema.optional(),
  })
  .superRefine((value, context) => {
    const slug = parseClinicSlug(value.slug);
    if (!slug.ok)
      context.addIssue({
        code: "custom",
        path: ["slug"],
        message: slug.message,
      });
    if (value.ownerPractices && !value.practice) {
      context.addIssue({
        code: "custom",
        path: ["practice"],
        message: "Add the name, title, and specialty to show on your calendar.",
      });
    }
  });

export type ClinicRegistrationInput = z.infer<typeof clinicRegistrationSchema>;

/** The first place a new business gets: "Main clinic", "Main salon", "Main office", "Main store". */
export function firstLocationName(businessType: BusinessTypeId): string {
  const t = profileWords(resolveBusinessProfile({ businessType }));
  const word = t.location === "location" && businessType !== "other" ? t.business : t.location;
  return `Main ${word}`;
}
