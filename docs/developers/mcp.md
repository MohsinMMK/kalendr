# MCP server and command line

Kalendr runs a Model Context Protocol server so an AI assistant can find open times and hand a customer a booking link, and so a business's own assistant can read and manage its day. It is part of the web app at `POST /api/mcp` (streamable HTTP, stateless, plain JSON answers; no sessions).

## Connect an assistant

```json
{
  "mcpServers": {
    "kalendr": {
      "type": "http",
      "url": "https://YOUR-KALENDR-HOST/api/mcp",
      "headers": { "Authorization": "Bearer ${KALENDR_API_KEY}" }
    }
  }
}
```

The `Authorization` header is only needed for the staff tools. `kalendr mcp-config` (the command line below) prints this block with your host filled in.

## Tools

| Tool | Key needed | What it does |
| --- | --- | --- |
| `list_services` | no | Services with length and price. Takes `business`, the link name from the booking page address (`/book/<business>`). |
| `list_people` | no | People who take bookings, optionally for one service. Name, title and specialty only. |
| `find_open_times` | no | Open times for a service, up to 14 days at a time. Same availability the booking page shows. |
| `start_booking` | no | Holds a time for 5 minutes and returns a link. **It never books.** |
| `list_todays_bookings` | `appointments:read` | Today's bookings, in the business's time zone. |
| `reschedule_booking` | `appointments:write` | Moves a booking to another open time. |
| `cancel_booking` | `appointments:write` | Cancels a booking. |
| `add_booking_note` | `appointments:write` | Sets the note on a booking. |

Staff tools use an ordinary API key from Settings > Developers and the same scopes as `/api/v1`: a key that cannot cancel through the API cannot cancel through an assistant. A test key is read-only here too. Each tool calls the same server function as its `/api/v1` route, inside the business's own row-level security.

## Booking through an assistant

`start_booking` returns:

```json
{
  "status": "awaiting_customer_confirmation",
  "bookingLink": "https://YOUR-KALENDR-HOST/book/lotus-dental/check-up?person=…&date=2026-12-01&time=2026-12-01T05:30:00.000Z&utm_source=mcp",
  "heldUntil": "2026-12-01T04:05:00.000Z"
}
```

The assistant gives the link to the customer. The customer opens it, sees the time preselected, enters their details and confirms. The booking is made by the booking page, so spam protection, rate limits, consent and payment rules apply as for any booking. The hold keeps the time closed to other people for 5 minutes. The link carries the hold's token (`hold=`): when the customer opens it, the booking page swaps that hold for the customer's own, so the time held for them never blocks them, and nobody without the link can take it. If the customer opens the link later, the page re-checks the time.

Limits: `find_open_times` and the other public tools allow 120 calls a minute per network, and `start_booking` 10 a minute per network. Staff tools also count against the key's 600 calls a minute.

## What is logged

One line per call: tool name, business id and outcome (`ok`, `refused` or `error`). Arguments are never logged, because they carry names and times.

## Command line

`packages/cli` is a zero-dependency Node script over `/api/v1`.

```sh
export KALENDR_API_KEY=kal_live_…        # from Settings > Developers
export KALENDR_URL=https://YOUR-KALENDR-HOST
node packages/cli/bin/kalendr.mjs services
node packages/cli/bin/kalendr.mjs times --service SERVICE_ID --from 2026-12-01T00:00:00Z
node packages/cli/bin/kalendr.mjs bookings --from 2026-12-01T00:00:00Z
node packages/cli/bin/kalendr.mjs cancel APPOINTMENT_ID --reason "Customer called"
```

`kalendr help` lists every command and the scope each needs. The key is read from the environment and never printed.

## Not built yet

- The one-time-code path for assistants that collected the customer's details themselves. Only the confirm-by-link path exists.
- OAuth sign-in for staff tools. API keys are the only credential.
- Publishing `@kalendr/cli` and `@kalendr/booker` to npm. Both are built and tested in this repository only.

## Plans

The public tools work for every business. The staff tools (and creating the API keys they need) come with the plan's API feature (Growth and up); on a plan without it a staff tool answers `plan_limit`.

## What the tools cover after the wave 3 features

- **Group classes** are booked seat by seat from the class timetable, not through the one-to-one flow, so `list_services` and `start_booking` leave class services out. Staff tools reach one-to-one bookings only.
- **Special links** and hidden services: the tools only see services listed on the public page. A hidden service that has a special link is never offered to an assistant.
- **Invoices and packages** hold customers' billing details, so no tool reads them. A key's scopes stay the seven in the settings screen.
- Staff are told about class activity (a place booked online, a waiting person taking an offered place, a place cancelled) through the same alerts as one-to-one bookings; see `docs/staff-notifications.md`.
