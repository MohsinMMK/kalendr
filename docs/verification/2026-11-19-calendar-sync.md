# Calendar sync (feature 16), verification note

Date: 19 November 2026. Built against the in-memory fake adapter and scripted transports. No real Google, Outlook or iCloud account was contacted.

## What was run

- Unit tests: privacy text, busy-time planning, outside-change classification, OAuth state signing, feed tokens, merged busy time, permissions, environment rules, webhook route answers (bad token 401, validation token echo, wrong `clientState` 401).
- Database tests (`src/server/calendar-sync.integration.test.ts`, on a throwaway PostgreSQL with the non-owner roles): every Done-when below, plus cross-business isolation on all eight new tables, webhook dedupe, two reads at once, sealed logins and key rotation, the web role refused the worker's lookup function.
- Browser: "My calendars" at desktop width and 375px against a local database with `CALENDAR_PROVIDER_MODE=fake`: connect Google (test account), the worker verifies it, the primary calendar blocks availability, "Write new bookings to" persists, no sideways scroll, 44px buttons.

## Done when

| Done-when | Result |
| --- | --- |
| An event added in Google removes that slot from the public booking page after a webhook-triggered read | Passed (also refuses the booking itself) |
| A Kalendr booking appears in Outlook and moves when rescheduled | Passed (also removed on cancel; text follows the setting) |
| Deleting the event in the calendar raises "Needs a person" and does not cancel the appointment | Passed (both actions work) |
| A revoked token shows "Needs reconnecting" and booking still works | Passed |
| A channel about to expire is renewed by the job | Passed |

## Not done

- No real provider. Needs the owner's Google OAuth client and Microsoft app registration (`.env.example`).
- The Playwright spec `e2e/calendar-connect.spec.ts` typechecks and lints but was not run (no Docker here).
