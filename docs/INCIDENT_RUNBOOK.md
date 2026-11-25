# Incident runbook: a breach of personal information

For the person running Kalendr (the platform operator) when customer or staff information may have been seen, copied or changed by someone who should not have had it. It is a working checklist, not legal advice: have a lawyer review it and fill in the names and contacts before launch.

Fill in (TODO before launch): incident lead, deputy, legal adviser, the regulator's reporting address, and each business's contact for incidents.

## 1. Who decides

| Role | Does |
| --- | --- |
| Incident lead (the operator's founder or on-call engineer) | Declares the incident, owns the clock, signs off every message. |
| Engineer on call | Contains the problem (section 3) and runs the lookups (section 4). |
| Legal adviser | Decides whether and when the regulator and the customers must be told, and approves the wording. |
| Each business's owner | Is told first, because the business is responsible to its own customers. Kalendr tells customers directly only when the business asks or cannot. |

Declare an incident when any of these is true: a database, backup, key or token may have leaked; someone saw another business's data; a staff or customer account was taken over; a file store was exposed; a provider tells you they were breached. When in doubt, declare it. A false alarm costs an hour; a late one costs far more.

## 2. The clock

Write the time you first knew in the incident log (a private document, not in the product). The reporting step (section 5) must be done within **72 hours of that moment**. Do not wait until the investigation is finished: report what you know and say what you are still finding out.

## 3. Contain first (first hour)

1. Stop the leak: revoke the key, token or session; block the address; turn off the route or feature; take the exposed bucket private.
2. Keep evidence: do not delete logs, do not restart databases you still need to inspect, take a snapshot of the audit log and access logs for the time range.
3. Rotate what may be known to the attacker: `BETTER_AUTH_SECRET` signs sessions (changing it signs everyone out); each business's data key can be rotated from Settings, Data protection or by the `key-rotation` job; provider keys (email, SMS, storage) at the provider.
4. Write down every action and time.

## 4. Find who was affected

Use two sources: the **activity log** (`audit_events`, which nobody can edit or delete) and the **access logs** of the web host, the database and the file store.

### From the activity log

The function `kalendr_breach_affected(from, to)` is a narrow definer function that only the worker role can run. It returns ids and times, never names, contacts or content: one row per business that had activity in the window, one per customer whose bookings or records were touched (found through the booking, the record id or a `patientId` in the event), and one per staff member who acted.

```sh
# As the worker role (WORKER_DATABASE_URL), against production:
psql "$WORKER_DATABASE_URL" -c "select tenant_id, kind, subject_id, first_seen, last_seen
  from kalendr_breach_affected('2026-11-18T00:00:00Z', '2026-11-19T00:00:00Z') order by tenant_id, kind"
```

Or from code: `listBreachAffected(database, from, to)` and `summariseAffected(rows)` in `src/server/privacy/breach.ts`. A window can be at most 92 days; run longer ones in parts.

Work from the counts to the businesses:

| Question | How to answer it |
| --- | --- |
| Which businesses? | Rows with `kind = 'tenant'`. Narrow the window to the time the attacker was active. |
| How many customers in each? | `summariseAffected` gives customers and staff per business. |
| Which customers exactly? | The `customer` rows. Give each business its own list of ids; the business looks up its own people. |
| Which staff accounts acted? | The `staff_user` rows. Reset those sessions and passwords. |
| What was seen? | Record views and lists are in the log (`record.view`, `record.list`, with ids). Exports (`privacy.export.downloaded`) and downloads of record files are too. |

The admin console action for this (feature 15) is not built yet. When it is, it should call the same function and show the same table. Until then the engineer runs the query above and sends each business only its own rows.

### From access logs

Search the web host's and the file store's access logs, in the same window, for: sign-ins from unusual places, requests to `/api/staff/` or `/api/portal/` routes that return many records, and downloads from the file store. Logs hold ids and request ids but never names, contacts or message text. Match request ids to the log lines the application wrote.

### What is not in the log

The log shows what Kalendr's own code did. A database dump or a stolen backup does not show up in it. For those, assume everything in the database for the affected period was exposed: every business, every customer. Record fields are sealed with each business's data key; names, phone numbers and email addresses are not.

## 5. The 72-hour report

Do this with the legal adviser. It needs, at least:

- what happened and when it was found;
- what kinds of information were involved (names, contact details, bookings, health records, payments, files) and how many people, by business;
- what you think the effect on those people could be;
- what you have done and will do to stop it and to help them;
- who to contact for questions.

Send it to the regulator at the address the legal adviser gives you, and keep a copy and the time sent. If you do not yet know a number, say so and promise a date for the update.

## 6. Telling people

Businesses first, then customers. Customers are told without delay when the breach is likely to harm them (for example health records, payment details, or contact details being used for fraud). Keep it plain: what happened, what information, what you are doing, what they should do, who to ask.

Templates (edit and have a lawyer review; angle brackets are filled in):

**To a business owner**

> Subject: Important: a security incident that may affect your customers
>
> On <date and time> we found that <one sentence, no jargon>. It may have exposed <kinds of information> for about <number> of your customers between <start> and <end>. We have <what you did>. We have attached a list of the affected customer ids for your records; we have not sent any names. We are reporting this to <regulator> by <date>. Please <what the owner should do, for example change passwords, watch for odd calls>. Call <name and number> at any time. We will update you by <date>.

**To a customer** (when the business asks Kalendr to send it, or cannot)

> Subject: A security incident at <business name>
>
> Hello <first name>. We are writing to tell you that on <date> information held for <business name> may have been seen by someone who should not have seen it. This may include <kinds of information>. It does not include <what is known not to be involved>. We have <what was done>. We suggest you <steps>. You can ask <business name> or us at <contact> for details. We are sorry.

**To the regulator** (outline only; the legal adviser writes the real one)

> Date and time found; type of incident; businesses and approximate numbers affected; kinds of information; likely effect; steps taken and planned; contact; promise of an update.

## 7. After

- Write what happened, why, and what changes: within a week.
- Fix the cause, add a test, and check that nothing else has the same weakness.
- Tell the people you promised updates to.
- Keep the incident log, the exported rows and the messages for as long as the legal adviser says.
- Update this runbook with what was slow or missing.

## Where this is wired

- Function `kalendr_breach_affected(from, to)`: migration `drizzle/0039_privacy_centre.sql`; worker role only; revoked from the web app's role in `scripts/migrate.mjs`.
- Code: `src/server/privacy/breach.ts`.
- Test: `src/server/privacy/privacy.integration.test.ts` ("lists who a time window touched, for the worker role only").
