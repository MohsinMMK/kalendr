# Consistent landing and application theme

The user reported that Staff sign in and Get started reverted to different colors. The landing page had a local cobalt/porcelain palette and Manrope font while the root layout and shared components retained green/ivory and Source Sans 3.

The approved landing colors now live in `src/app/globals.css`. Landing aliases refer to those shared tokens, including neutral surfaces, control borders, focus, selections, and primary actions. Older `teal` utility aliases also resolve to the shared action colors. The root layout self-hosts Manrope once; the duplicate landing-only font declaration is removed. Dialog tint and the installed-app manifest now match. Error/warning semantics, component geometry, copy, and workflow code are preserved.

## Verification

Executed against the existing isolated local database:

```sh
bash -c 'source .local-db/database.env; export KALENDR_TEST_OWNER_URL="postgres://kalendr_local_owner:${KALENDR_LOCAL_OWNER_PASSWORD}@127.0.0.1:5544/kalendr_local"; exec scripts/local-db.sh run pnpm check'
shasum -a 256 -c /tmp/kalendr-internal-workflows-before.sha
impeccable detect --json --scope type src/app/layout.tsx src/features/clinic/onboarding-choice.tsx src/features/clinic/staff-auth-controls.tsx
impeccable detect --json src/app/globals.css src/app/layout.tsx src/app/page.tsx src/features/landing/landing.module.css
```

- Lint, TypeScript, 88 tests across 31 files, and the production build passed.
- Both design scans returned no findings.
- SHA-256 comparison confirmed sign-in, registration, setup, onboarding components, and the landing appointment story are unchanged.
- Production browser checks at 1440px and 390px covered sign-in and all four registration steps: practice, owner, location, account. Each rendered Manrope, `#FAFAFA` canvas, and `#315CCE` primary with no horizontal document or descendant overflow. Selected, enabled, disabled, input, focus, progress, and Back states were inspected. Returning from account to location preserved the draft clinic name. No account was created.
- No page errors occurred during these checks. Full-page screenshots are `output/playwright/internal-theme-{sign-in,practice,owner,location,account}-{1440,390}.png`.
- The root landing page also retains its palette, font, and interactive story after removing its independent font/theme values.

The application routes inherit the shared tokens; authenticated setup and staff workflows were not newly exercised with an account for this visual change. This is local verification, not a deployment. No environment variables or dependencies were added.
