# Group sessions and classes (18): verification

Branch `claude/wave3a-routing-groups-816232`. Migration `0054_group_classes`.

What was run (scratch PostgreSQL 17, every migration applied, web and worker roles without BYPASSRLS), `src/server/classes.integration.test.ts`, repeated three times with no flake:

- Twenty people take the last two seats at the same moment: exactly two succeed, eighteen get `class_full` with the waiting list on offer; three more then join the waiting list in a kept order.
- A direct write that would hold a third seat in a two-seat session is refused by the database trigger (23514); raising the seats lets it through.
- A cancellation offers the seat to the first person waiting with a 2-hour hold; the second waiting person is not offered it; a stranger cannot take the held seat; the offer message is sent through the worker; when the hold lapses the next person is offered the seat and takes it from their link, and the first person's late tap is refused.
- A teacher's class removes the time from their one-to-one availability and makes both the public booking and the desk booking refuse it; a class on top of an existing one-to-one is refused with the reason; cancelling the session gives the teacher back.
- A four-week timetable is created in one action, all or nothing (repeating it clashes on every date and creates nothing).
- One-tap attendance (version-checked, a stale tap is refused), a walk-in (a full class stays full), a message to everyone that is idempotent and never in the audit trail.
- Cancelling a session notifies everyone with a seat or waiting, releases the room, takes it off the timetable and closes it to new seats.
- Seat changes are version-checked and new seats are offered to the waiting; a business cannot see another's classes, enrolments or token lookup; the token is never stored raw or written to the audit trail.
- Component tests for the staff workspace and the public timetable, enrol dialog and seat page.

Not verified: the new screens in a browser at desktop and phone width by hand; the Playwright spec `e2e/group-classes.spec.ts` was written but its result is recorded in the final report; PostgreSQL 18 (this run used 17); no real email was sent (capture sink only).
