/**
 * What the checklist and the onboarding emails need to know about a business, read through a `Runner` so the web server
 * and the worker share one set of queries. Counts and flags only. No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import {
  checklistKeys, resolveSteps, summarise,
  type BookkeepingKey, type ChecklistKey, type ChecklistSummary, type OnboardingFacts, type StepView, type StoredMark,
} from "../../lib/onboarding-steps";
import { asDate, asNumber, asString, type Runner } from "../workflows/runner";

const optionalDate = (value: unknown): Date | null => (value === null || value === undefined ? null : asDate(value));

export async function loadMarks(run: Runner, tenantId: string): Promise<OnboardingFacts["marks"]> {
  const rows = await run(sql`select step_key, done_at, skipped_at from onboarding_progress where tenant_id = ${tenantId}`);
  const marks: OnboardingFacts["marks"] = {};
  for (const row of rows) {
    const key = asString(row.step_key);
    if (checklistKeys.includes(key as ChecklistKey) || key === "tour" || key === "sample_data") {
      const mark: StoredMark = { doneAt: optionalDate(row.done_at), skippedAt: optionalDate(row.skipped_at) };
      marks[key as ChecklistKey | BookkeepingKey] = mark;
    }
  }
  return marks;
}

export interface BusinessFacts {
  team: number;
  reminders: number;
  brand: boolean;
  payments: boolean;
  bookable: number;
  peopleWithHours: number;
  contact: boolean;
  testRows: number;
  realBookings: number;
  phone: string;
  liveHost: string | null;
  slug: string;
  createdAt: Date;
  /** When the guided first run started. Null for a business that was set up before it existed. */
  onboardingStartedAt: Date | null;
}

export async function loadBusinessFacts(run: Runner, tenantId: string): Promise<BusinessFacts | null> {
  const [row] = await run(sql`
    select
      (select count(*)::int from memberships where tenant_id = ${tenantId} and is_active) as team,
      (select count(*)::int from workflows where tenant_id = ${tenantId} and active) as reminders,
      (exists (select 1 from media_assets where tenant_id = ${tenantId} and kind = 'business_logo')
        or coalesce(tenant.brand ->> 'accent', '') <> '') as brand,
      exists (select 1 from tenant_payment_accounts where tenant_id = ${tenantId} and status = 'active') as payments,
      (select count(*)::int from services as service
        where service.tenant_id = ${tenantId} and service.is_active and service.visibility <> 'hidden'
          and exists (
            select 1 from practitioner_services as link
            join practitioners as person on person.tenant_id = link.tenant_id and person.id = link.practitioner_id and person.is_active
            where link.tenant_id = service.tenant_id and link.service_id = service.id
              and exists (select 1 from availability_rules as rule where rule.tenant_id = person.tenant_id and rule.practitioner_id = person.id)
          )) as bookable,
      (select count(distinct practitioner_id)::int from availability_rules where tenant_id = ${tenantId}) as people_with_hours,
      (tenant.phone <> '' and exists (select 1 from locations where tenant_id = ${tenantId} and is_active and address <> '' and city <> '')) as contact,
      ((select count(*)::int from appointments where tenant_id = ${tenantId} and is_test)
        + (select count(*)::int from patients where tenant_id = ${tenantId} and is_test)) as test_rows,
      (select count(*)::int from appointments where tenant_id = ${tenantId} and not is_test and status <> 'entered_in_error') as real_bookings,
      tenant.phone as phone,
      (select hostname from tenant_domains where tenant_id = ${tenantId} and status = 'active' and verified_at is not null and missing_since is null order by created_at limit 1) as live_host,
      tenant.slug as slug,
      tenant.created_at as created_at,
      tenant.onboarding_started_at as onboarding_started_at
    from tenants as tenant where tenant.id = ${tenantId}
  `);
  if (!row) return null;
  return {
    team: asNumber(row.team), reminders: asNumber(row.reminders), brand: row.brand === true, payments: row.payments === true,
    bookable: asNumber(row.bookable), peopleWithHours: asNumber(row.people_with_hours), contact: row.contact === true,
    testRows: asNumber(row.test_rows), realBookings: asNumber(row.real_bookings), phone: asString(row.phone),
    liveHost: row.live_host === null ? null : asString(row.live_host), slug: asString(row.slug), createdAt: asDate(row.created_at), onboardingStartedAt: optionalDate(row.onboarding_started_at),
  };
}

export interface Checklist {
  marks: OnboardingFacts["marks"];
  business: BusinessFacts;
  steps: StepView[];
  summary: ChecklistSummary;
}

/** The checklist as it stands now. Null when the business does not exist. */
export async function loadChecklist(run: Runner, tenantId: string): Promise<Checklist | null> {
  const [marks, business] = await Promise.all([loadMarks(run, tenantId), loadBusinessFacts(run, tenantId)]);
  if (!business) return null;
  const steps = resolveSteps({
    marks, activeTeamMembers: business.team, activeReminderWorkflows: business.reminders, hasLogoOrColour: business.brand, paymentsConnected: business.payments,
  });
  return { marks, business, steps, summary: summarise(steps) };
}
