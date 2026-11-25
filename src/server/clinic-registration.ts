import "server-only";

import { getDatabase, withTenant } from "@/db/client";
import {
  auditEvents,
  locations,
  outboxEvents,
  memberships,
  practitionerLocations,
  practitioners,
  tenants,
} from "@/db/schema";
import { parseClinicSlug, practitionerInitials } from "@/lib/clinic-slug";
import { authIsConfigured } from "@/lib/auth";

import { ApiError, getPostgresConstraint } from "./api-error";
import { currentTraceParent } from "./tracing";
import { createTrialSubscription } from "./billing/subscriptions";
import { insertCredentialUser } from "./staff-credentials";
import { createOpaqueToken } from "./crypto";
import type { SignUpProof } from "./sign-up-check";
import { emailIsConfigured, env } from "./env";
import { isPreviewMode } from "./preview-repository";

export { clinicRegistrationSchema } from "@/lib/clinic-registration";
import { firstLocationName, type ClinicRegistrationInput } from "@/lib/clinic-registration";
import { applyWorkflowPresets } from "./workflows/presets";
import { defaultTemplateFor, getOnboardingTemplate } from "@/lib/onboarding-templates";
import { ONBOARDING_EMAIL_EVENT } from "./onboarding/events";
import { seedFromTemplate } from "./onboarding/seed";
import { drizzleRunner } from "./workflows/runner";
export type { ClinicRegistrationInput } from "@/lib/clinic-registration";

export function isClinicRegistrationOpen(): boolean {
  if (isPreviewMode()) return false;
  if (!authIsConfigured || !getDatabase()) return false;
  const settings = env();
  if (settings.KALENDR_ALLOW_CLINIC_REGISTRATION === "false") return false;
  if (settings.NODE_ENV === "production") {
    return (
      settings.KALENDR_ALLOW_CLINIC_REGISTRATION === "true" &&
      settings.BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION !== "false" &&
      emailIsConfigured()
    );
  }
  return true;
}

export interface ClinicRegistrationResult {
  tenantId: string;
  slug: string;
  clinicName: string;
  email: string;
}

export async function registerClinic(
  input: ClinicRegistrationInput,
  /** Proof the owner controls `input.email` (the sign-up code, or Google or Microsoft). The public route requires it. */
  proof?: SignUpProof | null,
): Promise<ClinicRegistrationResult> {
  if (!isClinicRegistrationOpen()) {
    throw new ApiError(
      403,
      "registration_closed",
      "Sign-up is not open on this deployment.",
    );
  }
  const slug = parseClinicSlug(input.slug);
  if (!slug.ok) {
    throw new ApiError(400, "validation_error", slug.message, {
      slug: [slug.message],
    });
  }
  const tenantId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const locationId = crypto.randomUUID();
  const legalName = input.legalName?.trim() || input.clinicName;
  // The template decides the broad type when the form named one; otherwise the type picks a template (feature 11).
  const template = getOnboardingTemplate(input.template ?? defaultTemplateFor(input.businessType));
  const businessType = input.template ? template.businessType : input.businessType;
  const email = input.email.trim().toLowerCase();
  if (proof && proof.email !== email) {
    throw new ApiError(422, "email_not_verified", "Confirm your email with the code we sent before creating your business.", { email: ["Confirm this email first."] });
  }
  // An email owner chose a password; a Google or Microsoft owner gets a random placeholder until they set one.
  if (!input.password && proof?.method !== "google" && proof?.method !== "microsoft") {
    throw new ApiError(400, "validation_error", "Choose a password.", { password: ["Use at least 12 characters."] });
  }
  const password = input.password ?? createOpaqueToken();
  try {
    await withTenant(tenantId, async (transaction) => {
      await transaction.insert(tenants).values({
        id: tenantId,
        slug: slug.value,
        name: input.clinicName,
        businessType,
        legalName,
        phone: input.phone,
        email,
        timezone: input.timezone,
        locale: input.locale,
        // This business is in the guided first run (feature 11): checklist, tour and onboarding emails.
        onboardingStartedAt: new Date(),
      });
      // Every new business starts a 14-day Growth trial, no card needed (feature 14).
      await createTrialSubscription(transaction, tenantId);
      await transaction.insert(locations).values({
        id: locationId,
        tenantId,
        name: firstLocationName(businessType),
        address: input.address,
        city: input.city,
        timezone: input.timezone,
        accessibleEntrance: false,
      });
      await insertCredentialUser(transaction, {
        id: userId,
        name: input.ownerName,
        email,
        password,
        passwordChosen: Boolean(input.password),
        emailVerified:
          Boolean(proof) ||
          (env().NODE_ENV !== "production" &&
            env().BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION === "false"),
      });
      await transaction.insert(memberships).values({
        tenantId,
        userId,
        role: "owner",
      });
      let ownerPractitionerId: string | null = null;
      if (input.ownerPractices && input.practice) {
        const practitionerId = crypto.randomUUID();
        ownerPractitionerId = practitionerId;
        await transaction.insert(practitioners).values({
          id: practitionerId,
          tenantId,
          authUserId: userId,
          name: input.practice.name,
          title: input.practice.title,
          initials: practitionerInitials(input.practice.name),
          specialty: input.practice.specialty,
        });
        await transaction.insert(practitionerLocations).values({
          tenantId,
          practitionerId,
          locationId,
        });
      }
      // Every new business starts with reminders and a review request switched on (feature 5).
      await applyWorkflowPresets(drizzleRunner(transaction), tenantId, businessType);
      // Typical services, hours, a booking question and the business's own words, so the owner edits rather than starts from blank (feature 11).
      await seedFromTemplate(transaction, { tenantId, locationId, practitionerId: ownerPractitionerId, timezone: input.timezone, template });
      await transaction.insert(outboxEvents).values({
        tenantId, aggregateType: "onboarding", aggregateId: tenantId, eventType: ONBOARDING_EMAIL_EVENT, payload: { kind: "onboarding_welcome" },
        dedupeKey: "onboarding.email:welcome", traceParent: currentTraceParent(),
      }).onConflictDoNothing();
      await transaction.insert(auditEvents).values({
        tenantId,
        actorUserId: userId,
        actorType: "staff",
        action: "clinic.registered",
        outcome: "success",
        metadata: { slug: slug.value, businessType, template: template.id, ownerPractices: input.ownerPractices },
      });
    });
  } catch (error: unknown) {
    if (error instanceof ApiError) throw error;
    const constraint = getPostgresConstraint(error);
    if (constraint === "tenants_slug_uq") {
      throw new ApiError(
        409,
        "slug_taken",
        "That booking address is already in use. Choose another.",
        { slug: ["That booking address is already in use."] },
      );
    }
    if (constraint === "auth_users_email_uq") {
      throw new ApiError(
        409,
        "email_taken",
        "This email already has an account. Sign in, or use a different email.",
        { email: ["This email already has an account."] },
      );
    }
    throw error;
  }
  return { tenantId, slug: slug.value, clinicName: input.clinicName, email };
}
