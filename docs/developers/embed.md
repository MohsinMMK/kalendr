# Website embed (feature 52)

One script puts booking on any website: on the page, in a popup behind a button, or as a floating button. The owner builds the
snippet in **Settings → Website connection → Share and embed → Website embed**, with a live preview that runs this same script.

```html
<div id="kalendr-booking"></div>
<script
  src="https://booking.example.com/embed.js"
  data-kalendr-business="lotus-dental"
  data-kalendr-service="cleaning"
  data-kalendr-mode="popup"
  data-kalendr-mount="#kalendr-booking"
  data-kalendr-theme="auto"
  data-kalendr-brand="1f6feb"
  data-kalendr-label="Book a cleaning"
  defer
></script>
```

| Attribute | Values |
| --- | --- |
| `data-kalendr-business` | The business's link name (the part after `/book/`). Required. |
| `data-kalendr-service` | One service's link name. Empty is the whole booking page. |
| `data-kalendr-mode` | `inline` (default), `popup` or `floating`. |
| `data-kalendr-mount` | CSS selector for the element to fill (not needed for `floating`). |
| `data-kalendr-theme` | `light`, `dark` or `auto` (follows the visitor's device). |
| `data-kalendr-brand` | A six-digit hex colour for the buttons, without `#`. |
| `data-kalendr-label` | Button text for `popup` and `floating`. |
| `data-kalendr-position` | `left` or `right` for `floating`. |

From code: `Kalendr.embed({ business, service, mode, mount, theme, brand, label, position, prefill })` returns `{ open, close, destroy }`.

## Events

The booking page tells the website about each step. Listen with a window event, which works wherever the listener sits on the page:

```js
window.addEventListener("kalendr:booked", (event) => {
  // event.detail.appointmentId, serviceId, startsAt, endsAt, status
});
```

or, once the script has loaded, `Kalendr.on("booked", (data) => { … })`.

| Event | Carries |
| --- | --- |
| `opened` | nothing |
| `service_selected` | `serviceId` |
| `slot_selected` | `serviceId`, `practitionerId`, `startsAt`, `endsAt` |
| `booked` | `serviceId`, `appointmentId`, `startsAt`, `endsAt`, `status` (`booked` or `requested`) |
| `rescheduled`, `cancelled` | `appointmentId`, `startsAt`, `endsAt` (reserved for the manage page) |
| `failed` | `serviceId`, `reason` (`slot_taken`, `validation`, `verification`, `rate_limited`, `network`, `unknown`) |

Messages carry ids and times only, never a name, email, phone or note. The booking page drops any other field before it posts
(`src/lib/embed/protocol.ts`). The page only talks to the one origin that opened it, after a handshake that carries its own nonce, and
the loader checks the sender's origin and window on every message.

## Prefill and campaign tags

Campaign tags (`utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`) and the booking form's built-in prefill keys
(`name`, `email`, `phone`, `notes`, `location`, `person`, `date`, `time`) on the website's own address are passed into the booking page, so
campaign tracking survives. `prefill: { … }` on `Kalendr.embed` adds more.

## After booking

On each service (**Booking page** tab): show Kalendr's confirmation, optionally with a message of your own and without the booking details, or send the
customer to your thank-you page. The address is always opened with `kalendr_booking=<booking id>`. With "also pass the service and time" it also carries
`kalendr_service`, `kalendr_start` and `kalendr_token`, a signed summary that lasts 15 minutes. Your server can check it:

```
GET /api/public/booking-summary?token=<kalendr_token>   →   { "data": { "bookingId", "serviceId", "startsAt", "expiresAt" } }
```

Never a name, email or phone in the address. Inside a website's frame the loader follows the address (https or http only, no sign-in in the address).

## Tracking pixels

**Share and embed → Tracking**: Google Analytics, Tag Manager, a Meta pixel id and a Plausible domain (ids, never script code). The official snippet is added on
`/book/…` pages only, after the visitor allows analytics cookies in the banner (undecided until they choose; "No thanks" is as easy as "Allow"). The
choice is kept in the browser, per business. The content security policy lists exactly these hosts, on booking pages only.

## Short links and "times for an email"

Short links (`/s/abc2345`, seven random characters) open a booking page with optional prefill and campaign tags. Visits are counted; no address or
visitor detail is stored. **Times for an email** copies the next six open times of a service, each linking to the booking page with that time chosen;
it is a snapshot and the booking page checks the time again.

## Allowed websites

A website may frame booking only if its origin is in `KALENDR_BOOKING_FRAME_ANCESTORS` (https only; plain http only for a local test site). Every
other page of Kalendr refuses to be framed.
