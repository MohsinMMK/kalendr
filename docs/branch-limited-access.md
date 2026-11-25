# Branch-limited staff access

An owner or admin can limit a team member to some of the business's locations. That person then sees and acts only on those locations' data. Nothing chosen means every location (the default), and an owner is never limited.

## Where it is stored

- Table `membership_locations` (migration `0080_membership_locations`): `tenant_id`, `membership_id`, `location_id`, composite foreign keys with cascade, forced row-level security like every business table. **No rows = every location.**
- `kalendr_resolve_staff_access(user_id)` returns a new last column `location_ids text[]` (empty array = every location). A function's result columns cannot change in place, so the migration drops and recreates it and re-grants EXECUTE to whoever had it. The function is `SECURITY DEFINER`, so it reads the table without a business selected; the runtime role itself sees the table only inside its own business.
- `getStaffContext` puts it on `StaffContext.locationIds` (`string[] | null`, null = all). Owners always get null. Test fixtures, preview and support sessions leave it out, which means all.

## The helper

`src/server/location-scope.ts`: `allowedLocationIds`, `canUseLocation`, `locationCondition` / `andLocation` (SQL on a column), `assertLocationVisible` (404) and `assertLocationAllowed` (403 `location_not_allowed`), `visibleCustomerCondition` (SQL), `customerVisibleHere`.

**Rule for customers:** a limited person sees a customer who has a visit or a waitlist entry at one of their locations, or who has **no visit anywhere yet** (a customer someone just made has no location, so hiding them would block the booking). A customer seen only at other locations is hidden (404). A customer seen at both an allowed and another location is visible, with their whole profile and timeline (see Known limits).

Always qualify the column you pass (`patients.id`, `recalls.patient_id`): the helper's subqueries have their own `id` and `patient_id`, and an unqualified name binds to the inner one and silently matches nothing.

## What is scoped

Read as 404 (not there):
- `scopeFor` in `bookings-list.ts` (now location AND practitioner scope): bookings list and counts, queue (call next, ticket actions), quick messages and "running late", repeating-series list.
- Staff snapshot (`getStaffSnapshot`): appointments, waitlist, recalls, customers, messages, availability, schedule blocks (a block with no location stays visible), and the catalog the pickers read (locations, rooms, people who work there, services given there). `searchStaffPatients` too.
- Customer profile, timeline, notes, tags, offers, field values, records (`loadVisibleCustomer`, `customerVisibleHere`).
- One booking: change, approve, cancel, history, video visit, payments and refunds, using a package credit, the intake form answers (`withLockedStaffAppointment`, `mutateStaffAppointment`, `updateAppointmentStatus` with `locationIds`, `getBookingHistory`, `assertAppointmentVisibleHere`). A repeating series at another location is 404 for change and preview; saving a new one there is 403. Editing a customer (`updateStaffPatient`) follows the customer rule. Queue screen and ticket links are limited to the person's locations.
- Classes: sessions, rosters, attendance, walk-ins, capacity, cancel. Waitlist offers and entries. Repeating series.
- Reports: every report reads the allowed locations only (`ReportScope.locationIds`, also for queued exports).
- Staff alerts (bell, push and email): an alert about a visit, a class seat or a waitlist offer reaches only staff whose locations include it (`staffAtLocation` in `staff-notifications.ts`). The worker's alerts follow the same rule: a customer's message goes to limited staff only when the customer rule lets them open that customer (`worker/staff-alerts.ts`); payment alerts and the "requests waiting" reminder use the visit's location (`worker/payments/alerts.ts`, `worker/request-jobs.ts`). Owners and anyone with no location rows hear everything.
- The morning digest counts and lists only the person's locations (`compose` in `worker/staff-digest-jobs.ts`).
- Inbox: thread list, opening, mark read and assign follow the customer rule (another customer's thread is 404); the next-visit line and booking a reply template read the person's locations only (`threads.ts`).
- Command-palette search: customers by the customer rule, appointments and invoices by location, services and people by where they work (none listed = everywhere); routing forms and campaigns stay business-wide (`keepOwnLocations` in `search/staff-search.ts`).
- Doctor profiles: a limited manager changes a doctor's profile, hours or locations only when every location the doctor works at is theirs (403 `cannot_manage_location`), and creates or moves a doctor only into their own locations (403 `location_not_allowed`) (`staff-team.ts`).

Refused as 403 `location_not_allowed`: booking a visit (`createStaffAppointment`, `insertStaffAppointment`), creating class sessions, adding to the waitlist, closing time (a block) at another location. A limited person can't make a block with no location (it closes everywhere).

## Giving and changing it

- Invite (`POST /api/staff/team/members`) and Edit access (`PATCH /api/staff/team/members/[id]`) take `locationIds` (`memberLocationIdsSchema`). An empty list lifts the limit.
- Same guards as the rest of Edit access: `team.manage`, a second-factor check from the last 10 minutes for a change, never yourself (`own_access`), never an owner (`owner_required`), only an owner changes an admin. Ids must be active locations of this business (`location_not_found`). A limited admin can hand out only their own locations and can't lift a limit (`cannot_grant`). Making someone the owner clears their limit.
- Audit: `staff.member.locations_changed` with `{ membershipId, locations: { from: [ids], to: [ids] } }`, or the usual action with the same `locations` key when more changed. Ids only.
- UI: `MemberLocationsField` (a coss multi-select; "All locations" by default, street under each name), shown only when the business has two or more active locations. The team list shows "Tolichowki only".

## Tests

`src/server/branch-limited-access.integration.test.ts` and `src/server/branch-limited-extras.integration.test.ts` (alerts, digest, inbox, search, doctor profiles) (two branches; a receptionist limited to the first; needs the scratch database), `src/server/location-scope.test.ts`, `src/server/member-locations-contracts.test.ts`, `src/lib/member-locations.test.ts`, `src/features/clinic/member-locations-field.test.tsx`.

## Known limits

- A deleted location would drop out of a person's list; if it was their only one they would become unlimited. Locations are switched off, not deleted, in the app.
- A customer seen at an allowed location **and** elsewhere shows their whole profile (summary, timeline, notes) to the limited person; only the visits listed elsewhere (bookings, schedule, queue) are filtered.
- Search asks `kalendr_staff_search` for its ceiling of 20 hits per kind, then keeps the person's own. When more than 20 better matches sit at other locations, a limited person sees fewer hits than there are; typing more of the name finds them. Passing the locations into the function would fix this exactly (a migration).
- Live events carry no data (only "something of this kind changed"), so the screen refetches through the scoped reads; they are not filtered by location.
- Campaigns, segments and routing forms are owner/admin features and stay business-wide.
- A limited person's own profile and settings pages are unchanged.
- Checked in a browser on 25 Nov 2026 as a receptionist limited to one of two locations (see STATUS.md).
