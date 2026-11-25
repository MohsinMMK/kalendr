# Branding and own web address (13): verification

Branch `claude/wave3b-brand-onboarding-25327b`. Migration `0055_branding_domains`.

What was run:

- `pnpm lint`, `pnpm typecheck`, `pnpm build` (the Next 16 proxy, now with database lookups, builds on the Node runtime), plain `pnpm test`.
- Unit and component tests: accent contrast (a coarse sweep of 216 colours all reach 4.5 to 1; a yellow accent gets black text and a note), parsing of stored brands, hostname and origin rules (IPs, ports, single labels, Kalendr's own hosts, header-injection attempts), verification hashing and the "failed lookup is not a missing record" rule, host routing and the paths refused on a business's address, the proxy itself (unknown host 404, rewrite to `/b/<slug>` and `/book/<slug>`, per-business `frame-ancestors`, 503 on an outage), the certificate check route (yes only for live addresses, token compare), the branding and own-address screens (live preview variables, plan-limit upgrade, steps, errors, retry), and the website guide saving the allowed site.
- Integration tests against a scratch PostgreSQL 17 on port 5601 with the web and worker roles without BYPASSRLS (`src/server/domains/identity.integration.test.ts`, 19 tests): brand save and plan gate, the badge flag lapsing with the plan, one business's look away from another, an email in the business's colour with black text on yellow and no "using Kalendr", an address refused on a plan without it and when no target is set, going live only with both records (a fake resolver), the certificate lookup refusing an unverified address, "Check now" through the outbox and handler, a lapsed claim not blocking the rightful owner, a live address never taken, records disappearing (one warning, 7 days of serving, then off and an email), 72-hour give-up and "show the records again", cross-business reads and removals refused, read-only support session refused, embed origins saved and fed into `frame-ancestors`, bad origins refused in code and by the database constraint.
- Browser journeys `e2e/branding-and-address.spec.ts` (desktop): the owner picks yellow, sees the note and a preview with black foreground (axe clean), and the public page and a staff screen differ; a business's own address (`http://book-xxxx.localhost:<port>`) is refused while pending and unknown hosts get a plain 404, then serves the business page and booking flow once active while `/sign-in`, `/dashboard`, `/settings`, `/api/staff/...`, `/api/auth/...` and another business's page are 404, and the certificate check says 404 then 200 then 404 after removal; the booking widget loads inside a page on the saved site and is blocked by Chrome (`frame-ancestors`) on another.

Not verified: a real certificate (needs the hosting provider), a real DNS lookup, the phone project of the browser journeys, PostgreSQL 18 (17 was used).

## Known limits

See [../branding-and-address.md](../branding-and-address.md#known-limits).
