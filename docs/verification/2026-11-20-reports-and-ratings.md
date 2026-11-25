# Reports and analytics (26) and ratings and feedback (51)

Built on branch `claude/wave4a-reports-ratings-198b7a`. Migrations 0065 (reports) and 0066 (feedback).

## What was tested

| Done when | How |
| --- | --- |
| Last month's overview matches a hand count of bookings, revenue and no-shows | `src/server/reports/reports.integration.test.ts` seeds decoys (test, sample, entered in error, spam, another business, rows either side of local midnight, a test payment) and checks 12 bookings, 190000 minor revenue, no-show rate 2 of 11 |
| 20 booked of 40 available hours reads 50% | same file, rules Monday to Friday 09:00–17:00 and five 4-hour bookings |
| `utm_campaign=diwali` appears under that campaign | same file, Sources report |
| A practitioner cannot see revenue for others | same file: own numbers only, revenue refused, and with the permission handed over still only their own money |
| CSV opens cleanly | `src/server/reports/csv.test.ts` (byte-order mark, CRLF, quoting, formula neutralising); large ranges build in the worker and download only for the asker |
| 150,000 bookings stay fast | same integration file; a year of 150k bookings answers every report in under 4 s (overview about 0.8 s) |
| A completed visit triggers a rating message 2 hours later; one tap records 4 stars; the score shows on the appointment | `src/server/ratings.integration.test.ts`, `e2e/ratings.spec.ts` |
| A private 1-star review alerts the manager and never appears on the business page | `src/server/ratings.integration.test.ts` |
| Each person's average and satisfaction for the month | `src/server/ratings.integration.test.ts`, Satisfaction report |

## Browser journeys

`e2e/reports.spec.ts` and `e2e/ratings.spec.ts` (Playwright, with an accessibility scan).

## Known limits

- The weekly digest email (spec step 10) and the Messages report are not built.
- Utilisation counts working hours from each person's default schedule; time off, one-off date changes and blocked time are not taken away, and rooms have booked hours only through the bookings report.
- The WhatsApp and text "review request" messages still link to the manage page (their approved templates carry a fixed link); those ratings are recorded as `manage_link`.
- Staff-entered ratings (`source = staff`) are allowed by the schema but there is no screen for them yet.
- Reports are not available in preview mode (they say so).
