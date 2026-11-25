# Customer profiles (feature 27)

One place per customer: who they are, when they were last here and next, how often they come and miss, what they owe and
what they have left on a package, their tags, one pinned note and a single timeline of everything that happened.

## What was built

| Part | Where |
| --- | --- |
| Tables (migration `0068_customer_profiles`) | `customer_tags`, `customer_tag_links`, `customer_notes`, `customer_segments`, `customer_field_definitions`, `customer_field_values`, `customer_merges`; `patients.blocked_at`, `block_reason`, `blocked_by_user_id`, `merged_into_id`, `merged_at`. All new tables have forced row-level security. |
| Server | `src/server/customers/` — `timeline.ts` (union query, keyset paging), `segment-sql.ts` + `segments.ts` (one filter compiler, saved segments), `merge.ts` (merge, undo, duplicate suggestions), `profile.ts`, `notes.ts`, `tags.ts`, `fields.ts`, `block.ts` |
| Routes | `/api/staff/customers/[id]` (summary), `…/timeline`, `…/notes`, `…/tags`, `…/fields`, `…/block`, `/api/staff/customers/merge` (GET duplicates, POST merge, `[mergeId]` DELETE undo), `/api/staff/customer-tags`, `/api/staff/customer-fields`, `/api/staff/segments` (+ `preview`, `[id]`, `[id]/members`) |
| Screens | `src/features/clinic/customer-profile.tsx`, `segments-panel.tsx`, `patients-workspace.tsx` |
| Worker | daily job `customer-merge-purge` (drops a merge's saved details after 30 days) through `kalendr_crm_tenants(job)` |
| Public API | `GET /api/v1/customers` and `/{id}` now return `tags` and `blocked`; merged customers are never returned |

## Permissions

- `customers.manage` — notes, tags, extra fields, blocking, segments. On by default for owner, admin and receptionist.
- `customers.merge` — merging and undoing a merge. Owner and admin only, and a second-factor check from the last 10 minutes.
- Reading a profile needs no extra permission (it is what the customer list already shows), but money (lifetime value, balance, payments in the timeline) is shown only to people who can take payments or issue invoices, and a practitioner only opens customers they have seen.

## Rules worth knowing

- **Notes are not clinical records.** They are internal, attributed and dated. The note box says so for healthcare businesses and points to Records. A note's text is never written to the audit trail; only its id is.
- **Segments** are validated JSON of plain conditions joined by "and" (last visit, number of visits, service used, tag, total spent, booking coming up, birthday month, agreed to marketing). `compileSegment` turns it into one parameterised query; every value reaches the database as a bound parameter and the only non-parameter text (the comparison operator) comes from a fixed map. Merged, erased and onboarding-sample customers are never in a segment.
- **Lifetime value and the average gap between visits** are worked out each time, never stored. Lifetime value is money received net of refunds, test-mode money excluded.
- **Merging** moves everything that can be edited (appointments, repeating series, forms, recalls, waitlist places, packages, memberships, records, the inbox thread, notes, tags, extra fields) to the kept profile in one transaction and seals the merged profile's phone and email, with the ids that moved, into a snapshot. Money rows (payments, invoices, coupon uses) are never edited, so they stay where they were written and every figure that reads a customer's money follows `patients.merged_into_id`. Consent history is append-only: the kept profile keeps its own answers and the merged one's are not carried over. Undo restores everything for 30 days; after that the daily job drops the snapshot. The merged row stays but loses its contact details so it is never matched as a returning customer.
- **Blocking**: a blocked customer cannot book or join the waitlist online (the page says "please call us"); the same email or phone is enough, so a new name does not get round it. Staff still see them and can book them at the desk. The reason is stored on the profile and never copied into the audit trail.
- **Search** across name, email and phone uses trigram indexes (`pg_trgm`) added in the migration.
- **Privacy**: the export includes tags, extra details and notes; an approved erasure removes notes, tag links and extra values and clears the saved merge details.

### Extra fields (the business's own columns)

- **Kinds** (migration `0077_field_kinds`): text, number, date, choice, multiple choice, yes or no, phone, email and link. Every answer is stored as text (up to 2,500 characters); `src/lib/customer-field-values.ts` says how each kind is checked, stored, shown and sorted, and the server and the screens share it. A multiple choice is a JSON list in the order of the field's choices; a yes or no is `true` or `false`; an email is lower case; a link gets `https://` when it has no scheme.
- **Who may define them**: creating, renaming, changing the kind or choices of, archiving and bringing back a field is for owners and admins (a 403 with a plain sentence otherwise), on top of `customers.manage`. Filling in a customer's answers needs only `customers.manage`, so a receptionist can. Reading the definitions and a customer's answers is open to staff who can see that customer. Up to 20 live fields per business; names are unique ignoring case.
- **Changing a field** (`PATCH /api/staff/customer-fields/{id}`, answers `{ definition, cleared }`): in one transaction, with the field locked and the version checked, stored answers are rewritten. `renames` (old choice to new choice) is applied first so a renamed choice keeps its people; then each answer is converted to the new kind (a choice becomes a list of one; a list becomes a single choice only when exactly one is picked; a number or a yes or no becomes its text; text becomes a number only if it reads as one). An answer that does not fit, or whose choice was removed, is deleted and counted in `cleared`. A choice kind keeps at least two different choices; a kind that is not a choice ends with none. Setting answers reads the field `for share`, so no old-shaped answer can slip in during a change. "Delete" is archiving: the field disappears from lists and tables, its answers stay and come back if it is restored.
- **Reading for a table**: `GET /api/staff/customer-fields/values` answers `{ [customerId]: { [fieldId]: value } }` in one query, capped at 20,000 answers (the first customers by id when a business has more). Merged-away and erased customers and archived fields are left out; a practitioner gets only customers they have had a visit with, the same rule as opening one profile. Preview mode answers `{}`.
- **Privacy coverage**: the export lists every answer by field name in readable words ("Yes", "Yoga, Spin"), archived fields included. An erasure deletes the customer's answers and the answers still held on profiles that were merged into them. A merge copies the merged profile's answers to the kept one, the kept profile's answer winning when both have one; undo removes only the answers the merge added. Retention (`privacy/retention.ts`) never deletes or anonymises a customer row (it clears booking notes, removes old messages and finished outbox rows, and removes records kept for erased customers), so no answers are left behind by it; answers go only with an erasure. Audit rows hold ids, the kind and counts only, never a field's name, choices or answers.

## Tables like Notion (customization wave, lane A)

- **One column model** (`src/lib/grid-columns.ts`, pure and tested) for Customers, Bookings and Records. A table's built-in columns can be renamed, hidden and shown again, moved and resized; what differs from the defaults is stored in the page's `columns` list of `tenants.layout` (`order`, `hidden`, `labels`, `widths`), so everyone on the team sees the owner's arrangement. Ids a table no longer has are ignored on read and dropped on write. Only owners and admins (the same people who change the workspace layout) arrange columns.
- **One header menu** (`src/components/reui/data-grid/data-grid-header-menu.tsx`): Rename inline, Sort, Filter, Move left and right, Hide, and Edit field and Delete field for the business's own fields. A grip at a header's edge drags it to a new place. Bookings sorts by Time only (the server sorts), and its Filter opens the page's one Filter menu. Reset columns (in the Columns menu) brings the defaults back.
- **Customers**: Name, Phone and Email are real columns (Email hidden until shown); the business's own fields join as columns, with a "+" at the end of the header to add one. Cells of the business's own fields edit in place for people with `customers.manage`; the grid's filter and sort cover them.
- **Fields the system needs** show a lock and can be renamed or hidden but not deleted: Name, Phone and Email on Customers, Time and Customer on Bookings, Customer and Document on Records.
- **Phones**: the cards follow the same arrangement. A hidden Phone, Email, Next booking or field stays off the card; the name always shows.
- Saved booking views keep the filters, the sort and the tab; applying one no longer changes the columns (they belong to the business now, not the browser).

## Known limits

- Follow-ups is made of plain tables, not the shared grid, so its columns cannot be arranged yet.
- A deleted (archived) field cannot be brought back from the screen yet.
- Bookings columns cannot be resized by dragging.
- Duplicate suggestions cannot be dismissed ("these are two different people") yet.
- A customer's extra fields cannot be used as segment conditions yet.
- Segments are joined by "and" only, as specified.
- The profile timeline shows the existence and state of messages, never their text.
- Money rows that follow a merge (payments, invoices) still carry the old profile id in exports and in the Public API's raw payment data.
