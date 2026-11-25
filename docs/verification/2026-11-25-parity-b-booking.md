# 25 Nov 2026: Lane B, booking engine and booking card

Branch `claude/parity-b-booking-5b3c6f`. Migration `0082_services_optimized_slots` (journal `when` 1797800000000). The task text said 0080 and the plan said 0081, but both numbers were taken on `master` (`0080_membership_locations`, `0081_login_held_elsewhere`), so it was renumbered after merging master.

## What was built

| Item | Where |
| --- | --- |
| Optimized slots | `slot-engine/service-rules.ts` (`adjacentStarts`), `offerable-slots.ts` (`candidatesFor`), `types.ts` (`optimizedSlots`), `load.ts`. Extra starts are added as candidates, so every filter (hours, holidays, time off, notice, window, busy, resources, limits, first slot only) and the commit's second run apply to them unchanged. Standard bookings only; walk-ins and moves that keep their time are not affected. |
| Old reschedule link | `retired_manage_tokens` (token hash, appointment, customer; tenant isolated), `kalendr_resolve_retired_manage_token` (ids only), `src/server/old-manage-link.ts`, `manage-token.ts` (records the retired hash), `manage/[token]/page.tsx` (only on the not-found branch), `manage-link-moved.tsx`. |
| Service settings | `services.optimized_slots` (off), `services.rebook_from_old_link` (on). Fields: `service-optimized-slots-field.tsx`, `service-rebook-link-field.tsx`; route `GET/PUT /api/staff/services/[id]/booking-options`; they save themselves. |
| Compact card | `picker-header.tsx` (icon-only view switch in the corner), `slot-button.tsx` (green dot), `booking-panel.tsx` + `TimeZoneField compact` (time zone is a row among the booking details). |

"Offered first" is read as: the start next to a booking (10:45) is offered in addition to the grid and sits ahead of 11:00 in the sorted list. Times stay in time order.

## Security

An old token never matches `appointments.manage_token_hash`, so `getManageSnapshot`, `manageAppointment` (cancel, reschedule) and the rest still answer 404 for it. The landing is reached only after that 404. It shows the business, service, the new time when the same customer still holds an active booking, and the Book again link. It never returns the new token or any contact detail. Tested after two moves in a row.

## Tests

- Unit: `offerable-slots.test.ts` "optimized slots" (on and off, the 10:45 case, buffers, a neighbouring booking, working-hours edge, holiday, time off, notice, walk-in), `service-booking-option-fields.test.tsx`, `manage-link-moved.test.tsx`.
- Integration (scratch PostgreSQL 18 on port 5561, database `kalendr_e2e`): `src/server/parity-b-booking.integration.test.ts`: 10:45 commits with the setting on and is refused off; a moved booking's old tokens get 404 on read, cancel and reschedule; the landing shows the new time, hides Book again when the service switches it off, shows no time once cancelled, and another business sees no retired tokens.
- Browser: `e2e/booking-card-and-old-link.spec.ts`, screenshots in `docs/verification/screenshots/` (`booking-card-375.png`, `booking-card-1440.png`, `old-link-landing-375.png`, `old-link-landing-1440.png`).

## Left for the coordinator

Place `<ServiceOptimizedSlotsField serviceId saves />` and `<ServiceRebookLinkField serviceId saves />` in lane A's editor (timing and cancelling sections). Files outside the lane that were touched: `src/server/manage-token.ts`, `src/app/manage/[token]/page.tsx`.
