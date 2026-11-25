# Staff notifications (feature 56)

Each person chooses, per event, whether it reaches them **in the app**, as a **push** on their phone, or by **email**. The page is **Notifications** in the profile menu
(`/profile/notifications`): a grid of events by channels, quiet hours, and a morning summary.

## Events

`new_booking`, `booking_request` (needs approval), `cancellation`, `rescheduled`, `message` (a customer's message), `low_rating` (1 or 2 stars), `waitlist_filled`, `booking_moved`, `payment`, `needs_person`. Each
event is kept to the roles who could open the thing it is about (`alertPermissions` in `src/lib/staff-alerts.ts`).

## Who is told

`planStaffAlert` (`src/lib/staff-alert-plan.ts`, shared by the web app and the worker):

- Someone who could not see the appointment under their permissions is never told, and nor is the person who did the thing.
- A practitioner hears only about appointments that are with them.
- Defaults when someone has not chosen: everyone gets the bell; a practitioner's own bookings also push; nobody gets an email per alert; owners and admins get the morning summary by email at 07:00.

## Quiet hours and the summary

Quiet hours (minutes after midnight in the business's time zone) hold **push and email** until they end: the outbox row is queued with `available_at` at the end. The bell is never held.

The morning summary is the timed job `staff-digest` (every 15 minutes, `src/worker/staff-digest-jobs.ts`). It finds businesses through `kalendr_staff_digest_tenants()` (ids only, revoked from the web role), and for each person whose time has come, queues one `staff.digest` outbox row: their day's bookings (a practitioner's own), requests waiting, yesterday's cancellations. A day with nothing to say sends nothing. `memberships.digest_sent_on` and the outbox key (`staff.digest:<membership>:<day>`) stop a day being sent twice.

The owner summary is a second email next to it: weekly or monthly counts for the business (bookings, cancellations, no-shows, new customers, revenue, each with the change from the period before). An owner who never chose gets the weekly one; "Off", "Every week" and "Every month" are set in Notifications (owners only; `memberships.summary_frequency`, migration `0083_owner_summary`). Weekly covers the Monday-to-Sunday week before and goes Monday to Wednesday; monthly covers the month before and goes on the 1st to 3rd. See [WORKER.md](WORKER.md).

## What a push or an email says

A title ("New booking at 4:30 pm") and, under it, the customer's **first name**, the service and the time. Never a phone, email, note or the words of a message or review. Free text stays out of audit rows.

## How it is built

- Migration `0064_staff_notifications`: `notification_preferences.email`, `memberships.quiet_start_minute / quiet_end_minute / digest_enabled / digest_minute / digest_sent_on`, the definer function above. The existing `staff_notifications` table is the inbox (the spec's `staff_inbox_items`) and `notification_preferences` holds the per-event choices.
- `notifyStaff` (web request) writes the bell row in the same transaction and queues `push.send` / `staff.email` outbox rows. `notifyStaffFromWorker` does the same for events that happen in the worker (a customer's message).
- Worker handlers: `push.send` (existing), `staff.email` and `staff.digest` (`src/worker/handlers/staff-notify.ts`). The email goes to the person's own sign-in address through the same delivery sink as every other email.
- Routes: `GET/PUT /api/staff/me/notifications` (all choices, quiet hours, summary), `PUT /api/staff/notifications/preferences` (one switch), the existing `/api/staff/notifications` and `/read` (the bell).
- The staff header has one bell. Its badge counts unread alerts plus what needs attention (white on red-700, red-600 in the dark theme, which clears 4.5:1) and it opens a side drawer titled Notifications, with a settings link to /profile/notifications and two tabs: Alerts (mark as read on open, Mark all read) and Needs attention (booking requests, missing forms, long waits). It opens on Needs attention when nothing is unread and something needs attention. Anyone with appointments.book can Approve or Decline a booking request right there, through the same appointment PATCH the Bookings list uses. The preview shows only Needs attention.

## Known limits

- **Out-of-office forward** and **form received** are not events yet: nothing in the product produces them. A feature that does adds a kind to `alertKinds` and calls `notifyStaff`.
- "Roles that cover the branch" is not modelled: memberships are not tied to a branch, so every person with the right permission is eligible.
- Quiet hours apply to push and email together; a person cannot have different hours for each.
- A digest that falls inside quiet hours goes out when they end.

## Class events

A place booked online in a group class raises a "New online booking" alert, a place cancelled by the customer raises "Cancellation", and a waiting person accepting an offered place raises "Waitlist filled". These alerts carry the class's teacher (`practitionerId`), so a practitioner hears only about their own classes while owners and receptionists hear about all. They open the Classes page. Joining a waiting list and an offer being sent are not alerts.
