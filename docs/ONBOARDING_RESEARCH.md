# Clinic onboarding refinement — 9 October 2026

> Note: Kalendr now serves any appointment-led business, not only clinics (see [PRODUCT.md](../PRODUCT.md) and [KALENDR_PLAN.md](KALENDR_PLAN.md)). This document is kept as history and still describes the clinic-only product.

Kalendr’s first value is a clinic-owned patient booking page backed by a service,
eligible practitioner, suitable space, and confirmed availability. The flow
preserves the existing porcelain, charcoal, cobalt, and Manrope visual system.

## Sources inspected

- [shadcn/ui React Hook Form guidance](https://ui.shadcn.com/docs/forms/react-hook-form)
  and [Field documentation](https://ui.shadcn.com/docs/components/base/field):
  labelled controls, associated error messages, native constraints, pending
  states, and shared schema validation. Existing Kalendr field components are
  retained and reused; the project is not presented as an installed shadcn preset.
- [Cal.com community scheduling source](https://github.com/calcom/cal.diy):
  the original `calcom/cal.com` URL currently redirects here. Inspected
  `apps/web/modules/onboarding/personal/_components/OnboardingLayout.tsx`,
  `apps/web/modules/onboarding/personal/settings/personal-settings-view.tsx`,
  and `apps/web/modules/onboarding/store/onboarding-storage.ts`. Useful
  patterns: a bounded form, explicit stages, consistent navigation, and
  continuity through setup. Kalendr avoids persisting passwords or making calendar
  integration a prerequisite for clinic scheduling.
- [Formbricks onboarding source](https://github.com/formbricks/formbricks):
  inspected `apps/web/app/(app)/(onboarding)/lib/redirect-if-onboarding-complete.ts`
  and `organizations/components/OnboardingOptionsContainer.tsx`. Useful pattern:
  readiness is derived from actual configured resources rather than a tour
  completion flag. Kalendr derives readiness from its clinic catalog.
- [Better Auth email/password documentation](https://better-auth.com/docs/authentication/email-password)
  and [Resend email API](https://resend.com/docs/api-reference/emails/send-email):
  public owners must verify their email when verification is required;
  verification failure must preserve the already-created clinic.
- Installed Next.js 16.4 documentation under `node_modules/next/dist/docs/`:
  server/client boundaries and forms. `/start` evaluates deployment gates at
  request time instead of freezing preview status into a build.

These sources informed independently implemented patterns. No Cal.com or
Formbricks source files were copied into Kalendr, and no enterprise modules were
imported. Their repository licenses were inspected as part of the review.

## Resulting behavior

1. Clinic and owner details → actual city/address → owner credentials → review.
   Only explicit confirmation creates a clinic. Passwords stay in component
   memory and are cleared after successful registration/sign-in attempts.
2. Registration failure returns to the relevant field with the message intact.
   A saved clinic with failed sign-in has a recovery link instead of a second
   create action. Required verification has explicit inbox guidance.
3. Service setup lets owners choose duration, approval, and space requirements.
   Practitioner setup includes explicit working-day and time review. Registration
   no longer invents Monday–Saturday working hours.
4. Readiness excludes inactive services/practitioners/spaces, checks service
   assignments and location compatibility, and requires hours for eligible
   practitioners. The final page exposes patient review, link copying, policies,
   website connection, and Today.
5. Development preview rehearses registration and operational setup without
   creating accounts, sending messages, or claiming custom choices are live.
   Sample patient booking uses the existing demonstration catalog.

Production still needs an approved database, hosting, verified email sender,
provider acceptance, and clinic-specific operational/privacy policies. Local
acceptance is recorded separately; it is not a production rollout.

## Authentication upgrade compatibility

The [official Better Auth 1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide)
requires relaxing the `issuer` column added in 1.7.0–1.7.2 and removing its
uniqueness rule. The migration retains historical issuer values, makes the
column nullable, and enforces `(provider_id, account_id)` uniqueness without
merging identities. Duplicate provider identities cause migration to stop for
manual resolution. The local database migration and real browser sign-in are
part of acceptance.

## SaaS tour and component follow-up — 10 October 2026

Reviewed [shadcn/ui’s official Tabs composition](https://ui.shadcn.com/docs/components/base/tabs)
and [Base UI’s Tabs API](https://base-ui.com/react/components/tabs). The shared
Kalendr `Tabs`, `TabsList`, `TabsTrigger`, and `TabsContent` wrappers use Base UI
behavior with the existing visual tokens. Keyboard activation is explicit and
covered by the connected product-tour tests. This adds one behavior dependency
without replacing the established forms, controls, or application theme.

Registration now combines clinic type, owner name, and practicing-owner choice
into one first stage. Four live stages preserve review before account creation;
preview omits credentials. Individually editable working days use the server’s
ISO weekday contract, including Sunday (7). Website code generation uses the
actual tenant and deployment origin; exact embedded origins still need operator
approval. These choices are independently implemented within Kalendr, preserving
the existing database and authorization boundaries.
