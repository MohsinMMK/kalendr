# Landing color and typography refinement — 22 September 2026

The user requested less green, a new font, and web DESIGN.md references while explicitly preserving the central appointment journey’s layout and behavior. The landing page now uses porcelain and gray surfaces, charcoal panels, restrained cobalt actions/selections, and Manrope; application routes retain their existing design.

## Reference and implementation

Two published source files were fetched and inspected: [Nexu Neutral Modern DESIGN.md](https://raw.githubusercontent.com/nexu-io/open-design/main/plugins/_official/design-systems/default/DESIGN.md) for neutral surfaces and sparse cobalt actions, and [Ai2 Strata DESIGN.md](https://raw.githubusercontent.com/allenai/design/main/strata/DESIGN.md) for Manrope’s body/heading roles. The local adaptation and exact palette are recorded in [landing-DESIGN.md](../design/landing-DESIGN.md).

The page’s changes are its scoped font import/class and CSS color/type declarations. No appointment logic, labels, navigation destinations, section ordering, grids, or breakpoint structure changed. The existing `appointment-story.tsx` passed a before/after SHA-256 comparison. Hero font sizes were tuned for Manrope’s wider glyphs while retaining its existing two-line grouping. Fonts are self-hosted through Next.js and applied to the landing wrapper; the root font is unchanged.

## Verification

Commands:

```sh
impeccable detect --json --scope type src/app/page.tsx src/features/landing
impeccable detect --json src/app/page.tsx src/features/landing/landing.module.css
bash -c 'source .local-db/database.env; export KALENDR_TEST_OWNER_URL="postgres://kalendr_local_owner:${KALENDR_LOCAL_OWNER_PASSWORD}@127.0.0.1:5544/kalendr_local"; exec scripts/local-db.sh run pnpm check'
shasum -a 256 -c /tmp/kalendr-story-before.sha
scripts/local-db.sh run pnpm build
```

Computed palette contrast ratios:

| Pair | Ratio |
| --- | --- |
| Main text / canvas | 14.48:1 |
| Secondary text / canvas | 6.13:1 |
| Muted text / gray stage | 4.70:1 |
| White label / cobalt button | 5.91:1 |
| Cobalt text / selected surface | 5.18:1 |
| Pale text / charcoal rail | 11.72:1 |
| Strong control outline / white | 3.17:1 |
| Inactive step number / stage | 5.61:1 |
| Active step number / canvas | 5.66:1 |

Initial rendered checks at 320, 390, 820, 900, and 1440px found no horizontal document or descendant overflow. Browser-computed heading font is Manrope, and the hero remains two lines at each inspected width. Current screenshot evidence uses the `color-*` names under `.impeccable/review/`; the original first viewport is `output/playwright/landing-color-before.png`.

`pnpm check` passed lint, TypeScript, all 88 tests across 31 files, and the production build. Both Impeccable scans returned no findings. The independent visual review requested one correction: removing opacity from the small step numbers to preserve their text contrast. That CSS-only correction was applied and the final production rebuild passed.

Production confirmation at 390, 920, and 1440px verified Manrope, full-opacity step numbers, and no horizontal overflow. The final screenshots are `.impeccable/review/color-final-{390,920,1440}.png`, captured after visible controls and real interactions confirmed hydration; an initial capture caught the loading skeleton and was replaced. Selecting Friday at 2:00 PM carried that time into both subsequent stages and preserved the date/time when returning to Patient booking. No page errors occurred during this interaction check. The user's existing localhost:3000 preview was refreshed and visually inspected.

No new environment variables, runtime packages, patient data writes, or external deployment.
