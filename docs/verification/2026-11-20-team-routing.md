# Team routing (20): verification

Branch `claude/wave3a-routing-groups-816232`. Migration `0053_team_routing`.

What was run:

- `src/lib/routing-rank.test.ts` (pure ordering: priority, fair share against weight, tie-breaks, returning customer, cover, new member, 30 bookings at weights 2:1:1 and equal weights).
- `src/server/routing.integration.test.ts` against a scratch PostgreSQL 17 with every migration applied and the web role without BYPASSRLS:
  - three stylists' free times are shown as one union, each time once;
  - thirty "anyone" bookings spread 15 / 7.5 / 7.5 within one at weights 2:1:1;
  - five customers racing for the same time with three stylists: exactly three succeed with three different stylists, two get `slot_unavailable`; two racing customers get two different stylists;
  - an "anyone" hold keeps its stylist and the next customer gets another;
  - a returning customer gets the stylist they saw when the service asks for it;
  - a week off with a cover person moves three bookings in one action (same time and manage link, version +1, outbox rows for the customers), leaves the one the cover could not take as "needs a person", repeats safely with the same key, and sends a new "anyone" booking to the cover;
  - saving routing settings checks the version, rejects people who do not offer the service and writes only ids and numbers to the audit trail; cross-business reads are refused.
- Component tests: the routing tab, the share card, the provider step's next-free times, the time-off reassign dialog; the existing booking and service-editor suites.

Not verified: the new screens in a browser (desktop and phone width); a Playwright journey for team routing; PostgreSQL 18 (this run used 17).
