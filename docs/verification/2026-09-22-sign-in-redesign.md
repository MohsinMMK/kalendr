# Staff sign-in redesign

The user requested a premium left/right sign-in page, then supplied [TimeTracker by Rafiqur Rahman / Filllo](https://dribbble.com/shots/20448736-TimeTracker-Sign-Up-Sign-In-Page) as the primary reference. Its white form-left / inset blue preview-right composition was visually inspected in the browser. Kalendr adopts that structure using its shared Manrope and cobalt palette, native UI, and clearly illustrative clinic scheduling content. No third-party artwork, customer claims, social authentication, or password-reset endpoint is introduced.

## Scope

- `src/app/sign-in/page.tsx`: two-panel layout, existing preview/unconfigured authentication branches, actual home/registration links, and static example schedule.
- `src/features/clinic/sign-in.module.css`: responsive layout, consistent field styling, preview composition, and state styling using existing shared tokens.
- `src/features/clinic/staff-auth-controls.tsx`: accessible password visibility control and redesigned form markup. Existing email/password submission, success redirect, failure copy, and sign-out behavior remain.
- Route-specific direction and review are in `.impeccable/surfaces/src-app-sign-in-page-tsx.md` and `.impeccable/review/sign-in-finish-review.md`.

## Checks

```sh
bash -c 'source .local-db/database.env; export KALENDR_TEST_OWNER_URL="postgres://kalendr_local_owner:${KALENDR_LOCAL_OWNER_PASSWORD}@127.0.0.1:5544/kalendr_local"; exec scripts/local-db.sh run pnpm check'
scripts/local-db.sh run pnpm build
impeccable detect --json src/app/sign-in/page.tsx src/features/clinic/sign-in.module.css src/features/clinic/staff-auth-controls.tsx
```

Lint, TypeScript, all 88 tests across 31 files, and the production build passed. The detector's advisory literal-radius and shadow-color findings were replaced with existing radius tokens and shared-ink color mixes. The final build after those substitutions passed. One rebuild attempt correctly stopped because the earlier build was still collecting traces; it was rerun successfully after that process finished.

Production browser checks covered 1440px, the user's 1169px browser width, 390px, and 320px. Each loaded Manrope and had no horizontal document or descendant overflow. Password visibility changes the input type without submitting. A browser-intercepted 401 verified the disabled pending state, descriptive error state, preserved entered values, enabled retry, and no redirect. No real credentials or account writes were involved; the expected mocked 401 appears in the browser console. The first alert locator also matched Next's route announcer and was narrowed to the named form before confirming the result.

Evidence: `.impeccable/review/sign-in-{1440,1169,390,320}.png`, plus `sign-in-pending-390.png` and `sign-in-error-390.png`. Captures were checked for loaded content before review. New runtime dependencies and environment variables: none. External deployment: none.

An earlier photo direction was superseded when the user supplied the TimeTracker reference. The generated photo and its sidecar were removed from the served asset directory; the final page ships no new raster imagery.

## Final visual review

The independent review found one phone-size issue: the overlapping appointment card obscured schedule descriptions. The existing phone breakpoint now stacks those cards in normal flow with a 16px gap; desktop overlap remains unchanged. The production build passed after this CSS correction. All six captures were replaced and inspected by the parent and reviewer, and the four viewport checks again found no horizontal overflow. The reviewer marked F1 resolved and the final disposition ship. This visual acceptance does not establish successful real authenticated sign-in or deployment.
