# Walk-in queue (feature 22) merged onto the trunk's queue — 19 November 2026

Feature 22 was built a week before the trunk grew its own queue (`queue_tickets`, `queue_counters`,
`queue_displays`, migrations 0019 and 0024, `src/server/queue.ts`, `queue-screens.ts`, `/q/[token]`,
`/queue/[token]`, the board on Today). The two designs differ in a way that cannot be mixed: feature 22's
tickets stand on their own (a status column, a patient, an optional visit); the trunk's tickets always belong
to a visit, and where the person is is the visit's own status. The trunk's queue is the base. Branch
`claude/feat-22-walk-in-queue-6aa78c` is recorded as merged (`-s ours`), and only what the trunk lacked was
ported by hand.

## Brought over (migration 0029, `queue_door`)

- **Door QR code (join links).** `join_token_hash` and `self_join_enabled` on the location's live `queue_displays`
  row; `kalendr_resolve_queue_join()`. Someone at the door gives a first name and phone number and gets a
  checked-in walk-in visit plus the next token, then lands on the trunk's own `/q/<token>` page.
  `src/server/queue-door.ts`, `/q/join/[joinToken]`, `/api/public/queue/join/[token]`,
  `/api/staff/queue/join-link`. Replacing the waiting-room screen link carries the door code over.
  Limits use feature 9's limiter (`queue_read.ip`, `queue_join.ip`, `queue_join.link`).
- **Close the queue for the day.** `closed_at` and `closed_reason` on `queue_counters`;
  `/api/staff/queue/close-day`. Door sign-ups are refused, everyone still waiting is let go (visit cancelled,
  with the same audit and outbox event as Left), and a short report comes back. The free-text reason stays on the
  counter row, not in the audit trail.
- **Screens.** Today's ⋯ menu gets "Door QR code…" and "Close the queue…" (`queue-link-dialog.tsx`).
- **Tests.** `src/server/queue-door.integration.test.ts` (4 tests, added to `scripts/verify-postgres18.sh`):
  token numbers per join, no names on the screen, door code survives a screen-link change, a new code turns the old
  one off, sign-ups off, closed day.

## Dropped, and why

| Feature 22 piece | Why it was dropped |
| --- | --- |
| Its own `queue_tickets` / `queue_counters` / `queue_displays` tables, `queue_ticket_status` enum, `0015_walk_in_queue` migration | Would give two queue tables. The trunk's tables stay. |
| `src/server/queue.ts` (1,205 lines), `src/lib/queue.ts`, `src/lib/queue-contracts.ts` | Same job as the trunk's `queue.ts`, `queue-screens.ts`, `queue-notify.ts`. Two APIs would clash on `/api/staff/queue/call-next` and `tickets/[id]`. |
| Desk walk-in without a visit (`addWalkIn`, `/walk-ins` page, `/api/staff/queue/walk-ins`) | The trunk adds a desk walk-in as a checked-in `walk_in` visit with a token (Today → Add walk-in). A ticket with no visit would break the board, Start, Done and Left. |
| Call-next with rooms, ticket status machine, versions, `order_mode` | The trunk's Call next already locks with `SKIP LOCKED`, orders urgent / booked-on-time / token, and filters by practitioner. Status stays the visit's own. |
| Booking tokens (`giveTokenForBooking`, `joinFromCheckIn`, check-in page offer, `/api/staff/queue/booking-tokens`, `/api/public/appointments/[token]/queue`) | Checking a booked customer in already issues their token on the trunk (`issueQueueTicket`), from the desk or the check-in page. |
| Customer leaves / asks to be told (`updateOwnTicket`), worker `queue-alert.ts` | The trunk has `setTicketNotify` and `sendAlmostNext`; a second alert path would message people twice. |
| `queue-workspace.tsx`, `queue-wall.tsx`, `use-polling.ts`, `queue-ticket.tsx` | The trunk's board, screen and ticket pages (with live updates) replace them. |
| `src/server/queue-limit.ts` (in-memory limits) | Feature 9's shared limiter is on the trunk. |
| Feature 22's tests (`queue.integration.test.ts`, `queue.test.ts`, `queue-screens.test.tsx`, `queue-alert.test.ts`, `e2e/walk-in-queue.spec.ts`) | They test the dropped model. The trunk's `queue-screens.integration.test.ts` and `queue-wait.test.ts` cover its own queue. |
| The "booked-first / arrival" ordering switch | The trunk has one order, defined in `waitingOrder`. |

## Not done

- No Playwright journey for the door QR code yet.
- Closed days only stop door sign-ups; a booked customer can still check in on a closed day.
