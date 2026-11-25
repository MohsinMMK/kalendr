import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { routingFormVersions, routingForms, routingResponses } from "@/db/schema";
import { checkFormAnswers, type FormAnswers } from "@/lib/booking-forms";
import {
  bookingPath,
  resolveRouting,
  routingDefinitionSchema,
  type PublicRoutingForm,
  type RoutingDefinition,
  type RoutingOutcome,
  type SubmitAnswersInput,
} from "@/lib/routing-forms";
import { ApiError } from "@/server/api-error";
import { createOpaqueToken, sha256 } from "@/server/crypto";
import { loadRecordKeys, sealText, writeKeyVersion } from "@/server/record-crypto";
import { assertTenantNotPaused } from "@/server/tenant-pause";

import { destinationServiceIds, loadDirectory } from "./directory";

/**
 * The customer's side of a routing form (feature 46). Three things are public: reading a live form, opening it (which
 * starts the funnel), and answering it. An unknown business, an unknown form, a paused form and a draft all give the same
 * "not found", so a visitor learns nothing about forms that are not live. The answer never says who was matched or why.
 */

/** A response stays usable for a day: long enough to book after thinking it over, short enough that stale rules die. */
const RESPONSE_HOURS = 24;

const notFound = () => new ApiError(404, "routing_form_not_found", "This form is not available. Ask the business for a new link.");

async function tenantFor(clinicSlug: string): Promise<string> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "This form is not available right now. Please try again shortly.");
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${clinicSlug}, null)`);
  if (!tenant) throw notFound();
  try {
    await assertTenantNotPaused(tenant.tenant_id);
  } catch {
    throw notFound();
  }
  return tenant.tenant_id;
}

interface LiveForm {
  formId: string;
  version: number;
  name: string;
  intro: string;
  definition: RoutingDefinition;
}

async function loadLiveForm(transaction: KalendrTransaction, tenantId: string, formSlug: string): Promise<LiveForm> {
  const [form] = await transaction.select().from(routingForms)
    .where(and(eq(routingForms.tenantId, tenantId), eq(routingForms.slug, formSlug), eq(routingForms.status, "live"))).limit(1);
  if (!form || form.liveVersion === null) throw notFound();
  const [version] = await transaction.select().from(routingFormVersions)
    .where(and(eq(routingFormVersions.tenantId, tenantId), eq(routingFormVersions.formId, form.id), eq(routingFormVersions.version, form.liveVersion))).limit(1);
  const parsed = version ? routingDefinitionSchema.safeParse(version.definition) : null;
  if (!version || !parsed?.success) throw notFound();
  return { formId: form.id, version: version.version, name: version.name, intro: version.intro, definition: parsed.data };
}

async function businessName(transaction: KalendrTransaction, tenantId: string): Promise<string> {
  const [row] = await transaction.execute<{ name: string }>(sql`select name from tenants where id = ${tenantId}`);
  return row?.name ?? "";
}

/** The questions of a live form, for drawing the page. Writes nothing. */
export async function getPublicRoutingForm(clinicSlug: string, formSlug: string): Promise<PublicRoutingForm> {
  const tenantId = await tenantFor(clinicSlug);
  return withTenant(tenantId, async (transaction) => {
    const live = await loadLiveForm(transaction, tenantId, formSlug);
    return { name: live.name, intro: live.intro, questions: live.definition.questions, businessName: await businessName(transaction, tenantId) };
  });
}

/** Starts a visit: the first step of the funnel. Returns an opaque token the page sends back with the answers. */
export async function openRoutingForm(clinicSlug: string, formSlug: string): Promise<{ token: string }> {
  const tenantId = await tenantFor(clinicSlug);
  return withTenant(tenantId, async (transaction) => {
    const live = await loadLiveForm(transaction, tenantId, formSlug);
    const token = createOpaqueToken();
    await transaction.insert(routingResponses).values({
      tenantId, formId: live.formId, formVersion: live.version, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESPONSE_HOURS * 3_600_000),
    });
    return { token };
  });
}

/** An existing customer's id when one of the answers is an email that belongs to them. Used only for consent-checked follow-ups. */
async function customerFor(transaction: KalendrTransaction, tenantId: string, definition: RoutingDefinition, answers: FormAnswers): Promise<string | null> {
  for (const field of definition.questions) {
    const value = answers[field.id];
    if (field.type !== "email" || typeof value !== "string") continue;
    const [row] = await transaction.execute<{ id: string }>(sql`
      select id from patients where tenant_id = ${tenantId} and lower(email) = ${value.trim().toLowerCase()} and erased_at is null and merged_into_id is null
      order by created_at limit 1
    `);
    if (row) return row.id;
  }
  return null;
}

const NOBODY: RoutingOutcome = {
  type: "message",
  title: "We could not match you just now",
  body: "Nobody is free to take this booking through the form. Please contact the business directly and they will help.",
};

/**
 * Checks the answers against the form's version, finds the route, remembers it, and says where to go next. The answers
 * are sealed with the business's key; the trace holds rule text only. Answering again before booking replaces the route.
 */
export async function submitRoutingAnswers(clinicSlug: string, formSlug: string, input: SubmitAnswersInput): Promise<RoutingOutcome> {
  const tenantId = await tenantFor(clinicSlug);
  return withTenant(tenantId, async (transaction) => {
    const live = await loadLiveForm(transaction, tenantId, formSlug);
    const checked = checkFormAnswers(live.definition.questions, input.answers);
    if (!checked.ok) {
      throw new ApiError(400, "validation_error", "Check your answers and try again.", Object.fromEntries(Object.entries(checked.errors).map(([id, message]) => [id, [message]])));
    }
    const directory = await loadDirectory(transaction, tenantId, destinationServiceIds(live.definition));
    const resolution = resolveRouting(live.definition, checked.answers, directory.byService, directory.attributes);
    const destination = resolution.destination;
    const noOne = destination.type === "service" && resolution.candidateIds.length === 0;
    const effective = noOne ? NOBODY : null;

    let token = input.responseToken ?? "";
    let existing: { id: string; formVersion: number; outcome: string } | undefined;
    if (token) {
      [existing] = await transaction.select({ id: routingResponses.id, formVersion: routingResponses.formVersion, outcome: routingResponses.outcome }).from(routingResponses)
        .where(and(eq(routingResponses.tenantId, tenantId), eq(routingResponses.formId, live.formId), eq(routingResponses.tokenHash, sha256(token)), sql`${routingResponses.expiresAt} > now()`, sql`${routingResponses.appointmentId} is null`))
        .for("update").limit(1);
    }
    if (!existing) token = createOpaqueToken();

    await loadRecordKeys(transaction, tenantId, { forWrite: true });
    const patientId = await customerFor(transaction, tenantId, live.definition, checked.answers);
    const outcome = effective ? "message" : destination.type === "service" ? "pending" : destination.type;
    const values = {
      formVersion: live.version,
      answersCiphertext: sealText(tenantId, JSON.stringify(checked.answers)),
      keyVersion: writeKeyVersion(tenantId),
      routeId: resolution.trace.matchedRouteId,
      routeName: resolution.trace.matchedRouteName,
      destinationType: effective ? "message" : destination.type,
      serviceId: destination.type === "service" && !effective ? destination.serviceId : null,
      candidateIds: effective ? [] : resolution.candidateIds,
      multipliers: effective ? {} : resolution.multipliers,
      trace: resolution.trace as unknown as Record<string, unknown>,
      outcome,
      patientId,
      answeredAt: new Date(),
      slotShownAt: null,
      expiresAt: new Date(Date.now() + RESPONSE_HOURS * 3_600_000),
    };
    if (existing) {
      await transaction.update(routingResponses).set(values).where(and(eq(routingResponses.tenantId, tenantId), eq(routingResponses.id, existing.id)));
    } else {
      await transaction.insert(routingResponses).values({ tenantId, formId: live.formId, tokenHash: sha256(token), ...values });
    }

    if (effective) return effective;
    if (destination.type === "service") return { type: "booking", url: bookingPath(clinicSlug, destination.serviceId, token) };
    if (destination.type === "external") return { type: "external", url: destination.url };
    return { type: "message", title: destination.title, body: destination.body };
  });
}
