import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { timelineKinds, type TimelineEntry, type TimelineKind, type TimelinePage } from "@/lib/customer-contracts";
import { ApiError } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";

import { canSeeMoney, loadVisibleCustomer } from "./access";

/**
 * One customer's history, newest first, as a union of everything that happened to them: visits, messages, payments,
 * forms, notes and changes. Every source is read into the same shape and the whole union is paged by time, so a
 * customer with years of history opens in one query and never loads it all.
 *
 * Message bodies are never read: a message is "Reminder sent by email", not its text. Payments are left out for
 * people who cannot see money.
 */

interface Row extends Record<string, unknown> {
  key: string;
  kind: TimelineKind;
  at: Date | string;
  title: string;
  detail: string | null;
  status: string | null;
  amount_minor: number | null;
  currency: string | null;
  ref_id: string | null;
  by: string | null;
}

/** Plain words for the message templates and events a customer may have been sent. */
const messageWords: Record<string, string> = {
  "appointment.reminder": "Reminder",
  "appointment.created": "Booking confirmation",
  "appointment.confirm": "Booking confirmation",
  "appointment.status.booked": "Request approved",
  "appointment.status.declined": "Request declined",
  "appointment.status.expired": "Request expired",
  "appointment.reschedule": "Time changed",
  "appointment.suggest": "New time suggested",
  "appointment.cancel": "Cancellation",
  "appointment.status.cancelled": "Cancellation",
  "appointment.review_request": "Review request",
  "record.shared": "Record shared",
  "waitlist.offer": "Waitlist offer",
  "series.confirmation": "Repeating booking confirmation",
};

function messageTitle(templateKey: string): string {
  if (templateKey.startsWith("workflow:")) return "Automatic message";
  if (templateKey.startsWith("campaign")) return "Marketing message";
  return messageWords[templateKey] ?? "Message";
}

const changeWords: Record<string, string> = {
  "patient.created": "Profile created",
  "patient.updated": "Details changed",
  "customer.tags.changed": "Tags changed",
  "customer.fields.changed": "Extra details changed",
  "customer.blocked": "Blocked from booking online",
  "customer.unblocked": "Allowed to book online again",
  "customer.merged": "Another profile was merged in",
  "customer.merge.undone": "A merge was undone",
  "privacy.consent.granted": "Agreed to messages",
  "privacy.consent.withdrawn": "Stopped messages",
  "privacy.guardian.recorded": "Guardian recorded",
};

const changeActions = Object.keys(changeWords);

function encode(at: string, key: string): string {
  return Buffer.from(JSON.stringify([at, key]), "utf8").toString("base64url");
}

function decode(cursor: string): { at: string; key: string } | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(value) || typeof value[0] !== "string" || typeof value[1] !== "string" || Number.isNaN(Date.parse(value[0]))) return null;
    return { at: value[0], key: value[1] };
  } catch {
    return null;
  }
}

/** The customer and any profile merged into them. Money rows are never edited, so they stay on the old profile and are read through this. */
function family(tenantId: string, patientId: string): SQL {
  return sql`select id from patients where tenant_id = ${tenantId} and (id = ${patientId} or merged_into_id = ${patientId})`;
}

function branches(tenantId: string, patientId: string, kinds: ReadonlySet<TimelineKind>, money: boolean, cursor: { at: string } | null, take: number): SQL[] {
  const parts: SQL[] = [];
  // Each source stops at the page's cursor and takes only one page, so a deep page costs the same as the first.
  const until = (column: SQL) => (cursor ? sql`and ${column} <= ${cursor.at}::timestamptz` : sql``);
  const cap = sql`limit ${take}`;
  if (kinds.has("visit")) {
    parts.push(sql`(select 'visit:' || a.id as key, 'visit' as kind, a.starts_at as at, s.name as title, null::text as detail, a.status::text as status,
        null::int as amount_minor, null::text as currency, a.id as ref_id, null::text as by
      from appointments as a join services as s on s.tenant_id = a.tenant_id and s.id = a.service_id
      where a.tenant_id = ${tenantId} and a.patient_id = ${patientId} and not a.is_sample ${until(sql`a.starts_at`)}
      order by a.starts_at desc, a.id desc ${cap})`);
  }
  if (kinds.has("message")) {
    parts.push(sql`(select 'sent:' || n.id, 'message', coalesce(n.sent_at, n.scheduled_at), n.template_key, n.channel::text,
        n.status::text, null::int, null::text, a.id, null::text
      from notifications as n join appointments as a on a.tenant_id = n.tenant_id and a.id = n.appointment_id
      where n.tenant_id = ${tenantId} and a.patient_id = ${patientId} and n.status <> 'queued' ${until(sql`coalesce(n.sent_at, n.scheduled_at)`)}
      order by coalesce(n.sent_at, n.scheduled_at) desc, n.id desc ${cap})`);
    parts.push(sql`(select 'chat:' || m.id, 'message', m.created_at,
        case when m.direction = 'inbound' then 'Replied on ' || t.channel else 'Message sent on ' || t.channel end, m.template_key, m.status, null::int, null::text, m.appointment_id, null::text
      from messages as m join message_threads as t on t.tenant_id = m.tenant_id and t.id = m.thread_id
      where m.tenant_id = ${tenantId} and t.patient_id = ${patientId} ${until(sql`m.created_at`)}
      order by m.created_at desc, m.id desc ${cap})`);
  }
  if (kinds.has("message")) {
    // Marketing messages (feature 28): when one went, by which channel, and whether it was sent, held back or failed.
    parts.push(sql`(select 'mkt:' || s.id, 'message', coalesce(s.sent_at, s.send_at), 'Marketing message', 'By ' || s.channel,
        case when s.status = 'skipped' then 'skipped' else s.status end, null::int, null::text, null::text, null::text
      from campaign_sends as s
      where s.tenant_id = ${tenantId} and s.patient_id = ${patientId} and s.status in ('sent', 'failed', 'skipped') ${until(sql`coalesce(s.sent_at, s.send_at)`)}
      order by coalesce(s.sent_at, s.send_at) desc, s.id desc ${cap})`);
  }
  if (kinds.has("payment") && money) {
    parts.push(sql`(select 'pay:' || p.id, 'payment', p.created_at, 'Payment', p.method::text, 'paid', p.amount_minor, p.currency, p.appointment_id, null::text
      from payments as p left join appointments as a on a.tenant_id = p.tenant_id and a.id = p.appointment_id
      where p.tenant_id = ${tenantId} and coalesce(p.patient_id, a.patient_id) in (${family(tenantId, patientId)}) and not p.is_test ${until(sql`p.created_at`)}
      order by p.created_at desc, p.id desc ${cap})`);
    parts.push(sql`(select 'refund:' || r.id, 'payment', r.created_at, 'Refund', null::text, 'refunded', r.amount_minor, p.currency, p.appointment_id, null::text
      from payment_refunds as r join payments as p on p.tenant_id = r.tenant_id and p.id = r.payment_id
        left join appointments as a on a.tenant_id = p.tenant_id and a.id = p.appointment_id
      where r.tenant_id = ${tenantId} and coalesce(p.patient_id, a.patient_id) in (${family(tenantId, patientId)}) and not r.is_test ${until(sql`r.created_at`)}
      order by r.created_at desc, r.id desc ${cap})`);
  }
  if (kinds.has("form")) {
    parts.push(sql`(select 'form:' || f.appointment_id || ':' || f.definition_key, 'form', f.submitted_at, f.definition_key, null::text, f.status::text, null::int, null::text, f.appointment_id, null::text
      from forms as f where f.tenant_id = ${tenantId} and f.patient_id = ${patientId} and f.submitted_at is not null ${until(sql`f.submitted_at`)}
      order by f.submitted_at desc ${cap})`);
  }
  if (kinds.has("form")) {
    // Routing forms (feature 46): the customer answered a form that sent them to a service. Only the route's own name is shown, never an answer.
    parts.push(sql`(select 'routing:' || r.id, 'form', r.answered_at, 'Answered ' || v.name, r.route_name, case when r.booked_at is not null then 'booked' else 'not booked' end, null::int, null::text, r.appointment_id, null::text
      from routing_responses as r join routing_form_versions as v on v.tenant_id = r.tenant_id and v.form_id = r.form_id and v.version = r.form_version
      where r.tenant_id = ${tenantId} and r.patient_id = ${patientId} and r.answered_at is not null ${until(sql`r.answered_at`)}
      order by r.answered_at desc, r.id desc ${cap})`);
  }
  if (kinds.has("note")) {
    parts.push(sql`(select 'note:' || n.id, 'note', n.created_at, 'Note', left(n.body, 300), case when n.pinned then 'pinned' else null end, null::int, null::text, null::text, n.author_name
      from customer_notes as n where n.tenant_id = ${tenantId} and n.patient_id = ${patientId} ${until(sql`n.created_at`)}
      order by n.created_at desc, n.id desc ${cap})`);
  }
  if (kinds.has("change")) {
    parts.push(sql`(select 'change:' || e.id, 'change', e.occurred_at, e.action, null::text, null::text, null::int, null::text, null::text, u.name
      from audit_events as e left join auth_users as u on u.id = e.actor_user_id
      where e.tenant_id = ${tenantId} and e.metadata ->> 'patientId' = ${patientId} and e.outcome = 'success'
        and e.action in (${sql.join(changeActions.map((action) => sql`${action}`), sql`, `)}) ${until(sql`e.occurred_at`)}
      order by e.occurred_at desc, e.id desc ${cap})`);
  }
  return parts;
}

export async function loadTimeline(
  context: StaffContext,
  patientId: string,
  options: { kinds?: readonly TimelineKind[]; cursor?: string; limit?: number },
): Promise<TimelinePage> {
  if (context.preview) return { entries: [], nextCursor: null };
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const cursor = options.cursor ? decode(options.cursor) : null;
  if (options.cursor && !cursor) throw new ApiError(400, "invalid_cursor", "That page link is not valid.");
  const kinds = new Set<TimelineKind>(options.kinds && options.kinds.length > 0 ? options.kinds : timelineKinds);
  const money = canSeeMoney(context);

  return withTenant(context.tenantId, async (transaction) => {
    await loadVisibleCustomer(transaction, context, patientId, { allowMerged: false });
    const parts = branches(context.tenantId, patientId, kinds, money, cursor, limit + 1);
    if (parts.length === 0) return { entries: [], nextCursor: null };
    const rows = await transaction.execute<Row>(sql`
      select * from (${sql.join(parts, sql` union all `)}) as entry(key, kind, at, title, detail, status, amount_minor, currency, ref_id, by)
      ${cursor ? sql`where (entry.at, entry.key) < (${cursor.at}::timestamptz, ${cursor.key})` : sql``}
      order by entry.at desc, entry.key desc limit ${limit + 1}
    `);
    const page = rows.slice(0, limit).map((row): TimelineEntry => {
      const at = new Date(row.at).toISOString();
      const messageLike = row.kind === "message";
      return {
        key: row.key,
        kind: row.kind,
        at,
        title: row.kind === "change" ? changeWords[row.title] ?? "Change" : messageLike && row.key.startsWith("sent:") ? messageTitle(row.title) : row.title,
        detail: messageLike && row.key.startsWith("sent:") ? `By ${row.detail}` : row.detail,
        status: row.status,
        amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
        currency: row.currency,
        refId: row.ref_id,
        by: row.by,
      };
    });
    const last = page[page.length - 1];
    return { entries: page, nextCursor: rows.length > limit && last ? encode(last.at, last.key) : null };
  });
}
