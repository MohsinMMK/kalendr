# Booker components

`packages/booker` is a small React package that puts Kalendr booking inside your own app without an iframe. It talks only to the public API, with no API key, so it is safe to ship to a browser.

```tsx
import { Booker } from "@kalendr/booker";
import "@kalendr/booker/src/booker.css";

<Booker
  clinicSlug="lotus-dental"
  baseUrl="https://YOUR-KALENDR-HOST"
  onEvent={(event) => analytics.track(event.type, event)}
/>
```

Props: `clinicSlug` (the part after `/book/`), `baseUrl` (defaults to the page's own origin), `serviceId` (skip the service list), `onEvent`, `className`.

`AvailabilityPicker` is also exported: open times grouped by day as real buttons, given `slots`, `timeZone` and `onSelect`.

## What it calls

| Call | Used for |
| --- | --- |
| `GET /api/public/catalog?clinicSlug=…` | Business name, places, services and people. No customer data. |
| `GET /api/public/availability?…` | Open times for a service, a week at a time. |
| `POST /api/public/appointments` | The booking, with an `Idempotency-Key` so a double click books once. |

It books through the same endpoint as the hosted page, so rate limits and the business's rules apply. A service that needs a form, an email check or an online payment is refused by the server with a clear message; send those customers to the hosted booking page.

## Events

`opened`, `service_selected`, `slot_selected`, `booked`, `failed` (and `rescheduled`, `cancelled` in the shared list), with the same names the website embed uses. Payloads carry ids and times only: `serviceId`, `personId`, `startsAt`, `endsAt`, `appointmentId`, and an `errorCode` on failure. Never a name, email or phone number.

## Styling

Every colour, radius and the font come from CSS variables on `.kalendr-booker`:

```css
.kalendr-booker {
  --kalendr-booker-accent: #7c3aed;
  --kalendr-booker-radius: 4px;
}
```

Variables: `accent`, `accent-text`, `text`, `muted`, `surface`, `border`, `danger`, `radius`, `font`. Buttons and fields are at least 44px tall and have visible focus rings.

## Try it

Run the app and open `/booker-demo` (`?business=<slug>` picks the business). The page shows the events it receives. Tests: `pnpm vitest run packages/booker`.

Publishing to npm waits until the owner asks; until then, import it from this repository.
