# Services page and full-page service editor (25 Nov 2026)

Lane A of the [Cal.com parity wave](../build-plan/calcom-parity-wave.md). Branch `claude/parity-a-services-301db0`, with the latest `master` merged in.

## What was run

- `pnpm check` (lint, types, unit tests, build): green. 3223 tests passed, 0 failed.
- A production build (`next build`, then `next start`) against a scratch PostgreSQL made with `scripts/e2e-database.mjs`. `.local-db` was not touched.
- Playwright, desktop project, 9 tests passed:
  - `e2e/services-page.spec.ts` (2, new): the list journey and the editor journey.
  - `e2e/service-setup.spec.ts` (2), `e2e/booking-limits.spec.ts` (1), `e2e/picture-editor.spec.ts` (4): moved from the old drawer to `/services/{id}`.
- Screenshots in [2026-11-25-services-page/](2026-11-25-services-page/):
  - `services-1440.png`, `services-375.png`: the list.
  - `editor-1440.png`: the editor with the live preview on the right.
  - `editor-375.png`, `editor-preview-drawer-375.png`: the editor on a phone, and the preview in its Drawer.

## Done-when, item by item

| Item | How it was checked |
| --- | --- |
| Each business sees its own word for services | Every label goes through `useTerms()`. Unit tests in `services-workspace.test.tsx` and `service-editor.test.tsx` render with different terms. |
| Duplicate, hide, reorder, search and switch off from the list | `services-page.spec.ts` searches the list, switches a service off and hides it (both checked through the API), duplicates it, deletes the copy from its editor and the original from the list. Hide and Show, and reordering, are also covered by `services-workspace.test.tsx` (the order is saved in the workspace layout). |
| Name, length or price show in the preview before saving | Unit test changes name, length and price and reads `data-testid="service-preview"`. The e2e test renames the service and sees the new name in the preview before saving. |
| Searching "cancel" jumps to the cancellation setting | Unit test and e2e test: typing "cancel" in "Search settings" and picking the match opens the Cancelling tab (`?tab=cancelling`) and scrolls to the setting; Enter jumps to the first match. |
| Resetting a customized setting restores the business default | `service-business-default.test.tsx`: Hours → Customize picks a schedule; Reset sets it back to the business hours. |
| Old drawer links open the new page on the same tab | `/settings?section=patient&service={id}` redirects to `/services/{id}`; `?tab=` deep links open that tab (unit and e2e). |
| Every editor section works at 375px | The e2e test opens each of the 14 tabs at 375px and checks the page has no horizontal scroll. |

## Known limits

- Only Hours has a real business default, so only Hours shows Customize and Reset. Cancel cutoffs, approval and limits are stored per service with fixed defaults; there is no business-level value to go back to.
- Delete is refused (409 `service_in_use`) when a service has bookings or links. Hiding or switching off is the way out for those.
- The `deleteService` integration test is skipped outside the local test databases (ports 5544 and 5545), like the other integration tests.
- The preview needs the service's catalog row, so a service the catalog does not list yet shows no preview until it is saved.
- The phone Playwright project was not run; both widths are covered inside the desktop project by resizing the viewport.

## Hooks in files other lanes own

- Sidebar: one entry each in `src/lib/sidebar.ts`, `src/features/clinic/sidebar-nav.tsx` and `active-route.ts`. `clinic-frame.tsx` (lane C) needed no change.
- `why-no-slot-sheet.tsx`: an optional `serviceId` prop.
- `entity-links.tsx`: a service links to `/services/{id}`; `appointment-card.test.tsx` expects that link.
- Markers for lanes B and C in the editor tab files: `Lane B: optimized slots field goes here` (Timing), `Lane B: rebook-from-old-link field goes here` (Booking page), `Lane C: field goes here` (Calendar).
