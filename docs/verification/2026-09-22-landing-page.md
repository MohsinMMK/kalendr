# Landing page upgrade — 22 September 2026

The `/` landing page now demonstrates a connected patient-to-clinic appointment journey, with the selected example date/time retained across booking, clinic schedule, and private appointment views. It preserves Kalendr’s established forest/ivory identity and adds a clearer clinic-day story, website connection options, sequential setup guidance, native FAQ disclosure, and real setup/sign-in destinations.

## Design rationale and research

The primary audience is the owner or front-desk team of an independent clinic. The primary action is clinic setup; current staff have a direct sign-in path. An interactive, explicitly illustrative appointment is the central proof, without collecting patient information or making booking requests.

- [Cal.com](https://cal.com/) was inspected in a live browser: a concrete scheduling interface explains the product faster than abstract feature claims. Kalendr uses its own scheduling context, palette, and composition.
- [Linear’s interface redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) informed alignment, hierarchy, and reduced chrome.
- [NHS button guidance](https://service-manual.nhs.uk/design-system/components/buttons) informed primary-action hierarchy and mobile targets.
- [GOV.UK form structure](https://www.gov.uk/service-manual/design/form-structure) informed a staged story with retained context.

The user explicitly delegated design decisions and requested no questions. The impeccable surface brief records the chosen composition and code-led implementation, not an invented user approval of a visual comp. No new raster assets, runtime packages, environment variables, external tracking, or provider claims were introduced. The old fixture-specific booking CTA was replaced by the self-contained example; actual patient booking routes remain intact.

## Implementation boundaries

Marketing copy and FAQ HTML render on the server. A single client component holds the example’s three small state values. Demo controls make no API requests, and setup/sign-in links do not prefetch their application screens. Scoped CSS isolates the landing page from staff and patient routes. Existing Source Sans 3 loading is reused. Reduced-motion preferences disable the story transition.

## Verification

Commands executed:

```sh
pnpm lint
pnpm typecheck
pnpm test src/features/landing/appointment-story.test.tsx
bash -c 'source .local-db/database.env; export KALENDR_TEST_OWNER_URL="postgres://kalendr_local_owner:${KALENDR_LOCAL_OWNER_PASSWORD}@127.0.0.1:5544/kalendr_local"; exec scripts/local-db.sh run pnpm check'
impeccable detect --json src/app/page.tsx src/features/landing
```

- Full check: lint, TypeScript, 88 tests in 31 files, and production build passed. `/` remains statically prerendered.
- New regression tests exercise date/time continuity through all three example stages and back, plus native keyboard time selection and direct stage navigation.
- Setup CTA opens `/start` with the “What kind of practice is this?” form; staff sign-in opens `/sign-in` with “Clinic sign in”. Neither flow was submitted.
- Production browser checks at `http://127.0.0.1:3000`: no page or console errors; one H1; no API requests from the demo.
- Browser flow: Friday 25 September at 2 PM persisted into the clinic schedule, patient detail, and back to booking. FAQs opened and closed using keyboard activation.
- Responsive document widths matched 320, 390, 768, 1024 and 1440px viewports, with no horizontal page overflow.
- Impeccable static scan: no primary findings; advisory color/radius matches were aligned with incumbent tokens. The pre-existing design sidecar’s older narrative is outside this landing-page change.
- Screenshots: `.impeccable/review/desktop.png`, `desktop-viewport.png`, `mobile.png`, `mobile-viewport.png`, `mobile-clinic.png`, `mobile-manage.png`.
- Initial development screenshot timing temporarily changed input caret styles before hydration, causing a tool-induced hydration warning. Fresh production navigation and interaction before capture verified zero console errors; no suppression was added to application code.

New environment variables: none. The local runtime was rebuilt; no external deployment is claimed.

## Finish review

The independent impeccable reviewer requested three bounded fixes: explicit spacing around a responsive heading line break, a persistent border for the selected demo stage distinct from hover, and setup connectors that start below their numbered markers. All three were applied in one batch. Post-fix lint, the two walkthrough tests, and `scripts/local-db.sh run pnpm build` passed; that production build also completed TypeScript validation. All six captures were refreshed with settled transitions. Final reviewer verdict is recorded separately in `.impeccable/review/`.
