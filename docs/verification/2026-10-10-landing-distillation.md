# Landing distillation — 10 October 2026

Reduced default-visible copy and repeated explanations following the user's
feedback that the landing had too many small details. Kept the existing clinic
demo and product identity, with a shorter headline, larger type, four feature
sentences, and native disclosures for secondary details.

## Scope

- Landing, demonstration copy/layout, related styles and design guidance only.
- Removed the demo sidebar, feature inventories, duplicate readiness checklist,
  setup prose, and standalone scheduling-boundary section. Relevant constraints
  remain in the FAQ and installation disclosure.
- All four demo tabs, appointment actions, search, patient selection, schedule
  navigation, booking choices, reset, and clinic creation links remain.
- Fictional-data disclosure now stays present after demo actions; medical-record
  and delivery boundaries are available in concise FAQ answers.
- No backend, schema, registration, or appointment-operation changes.

## Measurements

At 1440 × 1000, with Today selected and disclosures closed, the main element's
rendered text fell from **672 to 194 words** (about **71% fewer**). The document
height fell from 4271 to 2746 pixels. This measures default-visible text, not
metadata, accessible names, or the total text of every hidden panel/answer.

Fresh captures at 1440, 920, and 390 pixels showed no document-level horizontal
overflow. Full-page and viewport captures are `.impeccable/review/distilled-*.png`.
Each was opened and checked for the correct route, loaded content, and complete
capture. Headed browser checks exercised approval → patient status, search-empty
state, next-day schedule, booking service/time choices, and native installation
and reminder disclosures. Those interactions produced no page errors.

## Verification

```sh
KALENDR_NEXT_DIST_DIR=.next-onboarding-build pnpm check
git diff --check
```

Lint, strict types, **102 unit/component tests**, and the production build passed.
Four database cases remained skipped in the default suite; no database code
changed in this refinement and the earlier PostgreSQL 18.6 acceptance was not
rerun. Existing design hooks reported no deterministic issues. A fresh
independent screenshot/source finish review and documentation handoff accompany
this change.

No new dependencies or environment variables. No database writes, outbound
messages, deployment, or hosted-repository creation in this pass.
