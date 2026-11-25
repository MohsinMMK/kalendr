# Appointment workflow and performance improvements — 22 September 2026

This pass preserves the current patient and staff workflows and the existing visual identity. It targets measured client work, redundant server reads, stale asynchronous results, and booking-to-staff correctness.

## Decisions and research

- [NHS question pages](https://service-manual.nhs.uk/design-system/patterns/question-pages): focused questions, an explicit way back, and reuse of previous answers. Applied as date-first time selection rather than a long list of every opening. Related questions remain grouped; this is not a claim of formal usability testing.
- [NHS check answers](https://service-manual.nhs.uk/design-system/patterns/check-answers/): preserve the existing review step and editable answers before booking. Browsing other dates does not silently replace a selected appointment time.
- [web.dev INP guidance](https://web.dev/articles/optimize-inp): reduce avoidable JavaScript and rendering work. Defer settings code, reuse date formatters, and render only the selected day's slots.
- Installed Next.js 16.3.3 guides, `01-app/02-guides/lazy-loading.md` and `01-app/01-getting-started/06-fetching-data.md`: dynamic client imports and React request-scoped memoization. Catalog reuse applies only within a server render, not across users or later requests. Availability is not persistently cached.

## Implemented

### Patient booking and management

The shared time picker now groups slots once, presents a native date selector with opening counts, and renders only that date's times. All dates in the availability response remain reachable. Returning from Details restores the selected date/time; browsing another date displays the retained selection and a way back to it. Clinic-timezone grouping handles UTC midnight correctly.

Date formatters are reused in a bounded 64-entry cache keyed by format, locale, and timezone. The cache contains configuration only, never patient information. Practitioner labels use indexed lookup rather than scanning the practitioner list for every slot.

Availability failures have an explicit retry action that keeps the patient and visit choices. Aborted responses cannot overwrite newer choices. Booking confirmation no longer claims an email was delivered when the server has only confirmed the appointment.

### Staff workspace

Settings code loads on first opening. The dialog remains named while loading, Escape still closes it, and subsequent closing/reopening retains the existing settings state.

Snapshot refresh cancels the preceding request and ignores stale results, including transports that finish after cancellation. Unmount cancels pending work. Transient errors retain the prior snapshot with an explicit stale-data message and retry; revoked access clears it.

Catalog lookup maps and converted appointment arrays remain stable while their source snapshot is unchanged. This removes repeated mapping and prevents the appointment rescheduling effect from refetching after every result-driven render. Staff availability requests pass their abort signals to fetch. Overlapping and adjacent practitioner hours are merged before describing clinic hours, preventing a false overnight lunch break. Rescheduling results are keyed to appointment, location, service, and date so old dates are not selectable while a new date loads.

### Backend and cleanup

Staff history names reuse the catalog already loaded with inactive entries included, removing three SQL reads per snapshot. Catalog relationships are indexed in single passes instead of repeatedly scanning link arrays. Public services without an eligible practitioner or active linked location are omitted; inactive services remain available in staff history.

Metadata and public booking content share one request-scoped catalog read. The staff SQL result types and mapping accept both timestamp strings and Date values: otherwise a populated appointment snapshot crashed with `row.starts_at.toISOString is not a function`. Patient confirmation and cancellation likewise normalize raw timestamps before ORM writes; integration coverage checks confirmation, cancellation, and reservation release.

Generated `.next-*` build directories are ignored by Git and ESLint. No existing features, patient records, source files, or database structures were deleted; no migrations or new application environment variables were added.

## Measurement

| Check | Before | After | Meaning |
| --- | ---: | ---: | --- |
| Today route client-reference JS chunks, uncompressed | 189,138 bytes | 126,531 bytes | 33.1% reduction; excludes common runtime chunks and is not a network/LCP measurement |
| 500 slot date keys + time labels, median of 9 runs | 37.97 ms | 1.67 ms | Local Node 24 computation benchmark; about 22.7× faster for this work only |
| Time controls rendered for the live 500-slot database response | 500 under previous picker | 8 on the initial selected date | All 10 returned dates remain selectable; a full subsequent day has 60 openings |
| Redundant history-name queries per staff snapshot | 3 | 0 | Existing inactive-inclusive catalog supplies the same names |

Machine-local timings vary. No production field Core Web Vitals or load-test claim is made. Raw observations are in `output/booking-format-benchmark.json` and `output/optimization-bundle-metrics.json`. The benchmark can run current code with `node output/booking-format-benchmark.mjs`; pass a baseline `booking-format.ts` path as its first argument for a comparison.

## Verification

Baseline: 72 tests passed, with two database tests skipped before starting the isolated database. The expanded suite includes slot-date continuity, timezone formatting, retry, stale-response protection, revoked access, unmount cancellation, settings reopen state, populated staff snapshots, inactive catalog history, conflicts, and tenant isolation.

Final consolidated check: **86 tests passed across 30 files, no skipped tests; ESLint, TypeScript, and production build passed.**

Commands used:

```sh
scripts/local-db.sh start
scripts/local-db.sh check
pnpm test
pnpm lint
pnpm typecheck
pnpm build
bash -c 'source .local-db/database.env; export KALENDR_TEST_OWNER_URL="postgres://kalendr_local_owner:${KALENDR_LOCAL_OWNER_PASSWORD}@127.0.0.1:5544/kalendr_local"; exec scripts/local-db.sh run pnpm check'
node output/booking-format-benchmark.mjs /tmp/kalendr-optimization-baseline/booking-format.ts
scripts/local-db.sh run pnpm start --hostname 127.0.0.1 --port 3000
```

Browser verification uses the local production build and fictional local clinic data. The public booking flow was walked through patient, visit, date/time, details, review, and a persisted confirmation. Preview date navigation and Back retained the selected date/time; desktop and 390×844 views had no page-level horizontal overflow. The booking appeared in the signed-in staff Today view after loading the production build. Settings opened on demand, closed with Escape, and reopened on the same Hours section. The corrected clinic-hours summary read “Mon–Sat 9 AM–5 PM.” The browser-created test appointment was then cancelled through its management page; the staff snapshot confirmed `cancelled`, version 2, and no active resource reservations. No external messages were sent.

The repository began with its application files untracked and no commit history for them. This work does not claim a deployment or a clean committed baseline. Existing production activation gates in `docs/END_TO_END_PLAN.md` remain separate from these local improvements.
