# Connect Kalendr to a business website

> The newer one-script embed (`/embed.js`: inline, popup and floating, with events, redirects and tracking) is described in [developers/embed.md](developers/embed.md). The modes below keep working.

Kalendr supports four integration modes. Replace `booking.example.com` with the
deployed Kalendr booking origin and replace `indiranagar-dental` (the sample dental business) with the
business's verified slug. The same options work for every business type.

## 1. Hosted booking link

Use this first because it works with every website builder and requires no
JavaScript:

```html
<a href="https://booking.example.com/book/indiranagar-dental">
  Book an appointment
</a>
```

A business without a website can share that hosted page directly. Add
`?service=<service id>` to open it with one service already chosen.

## 2. Responsive iframe

Use an iframe when the business owns the page markup and wants the complete flow
inside the page:

```html
<iframe
  src="https://booking.example.com/book/indiranagar-dental?embed=1"
  title="Book an appointment with Indiranagar Dental"
  loading="lazy"
  referrerpolicy="strict-origin-when-cross-origin"
  sandbox="allow-forms allow-scripts allow-same-origin allow-popups"
  style="width:100%;min-height:760px;border:0"
></iframe>
```

## 3. Modal loader

Use the loader for a copy-paste button and accessible modal. Pin the asset
version so a reviewed website change controls upgrades:

```html
<div id="kalendr-booking"></div>
<script
  src="https://booking.example.com/kalendr-widget.js?v=3"
  data-kalendr-clinic="indiranagar-dental"
  data-kalendr-mount="#kalendr-booking"
  defer
></script>
```

`data-kalendr-clinic` takes the business slug; the attribute keeps its
original name for every business type.

The loader traps focus, closes with Escape or the close button, restores page
scroll and opener focus, and exchanges only versioned control messages plus an
opaque appointment reference. It validates the source window, exact origin,
per-instance nonce, protocol version, message type, and reference shape.

The business's site may listen for a completion event without receiving
customer details:

```js
window.addEventListener("kalendr:booking-completed", (event) => {
  const appointmentReference = event.detail.appointmentReference;
  // Optional: record an analytics conversion using the opaque reference only.
});
```

Do not place customer names, contact details, appointment reasons, booking
form answers, or manage tokens into the host page, analytics, tag managers, URLs, or `postMessage`
payloads.

## 4. Custom backend API integration

Use this when a developer owns the website booking form and its backend. The
website backend can read `GET /api/public/availability` using the exact
`clinicSlug` (the business slug; the field keeps its original name),
`locationId`, and `serviceId` query fields, with optional
`practitionerId` (default `first_available`). It returns `{ data: { slots } }`.
The customer must choose a returned slot before the backend sends
`POST /api/public/appointments` with the required customer and slot fields and
an `Idempotency-Key` header. Reuse the same key for a retry of one booking
attempt. The Settings > Website connection guide generates a copyable server
example against the configured Kalendr origin and current public route contracts.

Collect explicit privacy-notice acceptance and a valid email address before
submitting. Handle field errors and a slot conflict by refreshing availability.
These public routes do not provide cross-origin browser API access, API keys,
webhooks, or a ready-made website backend. Do not run a test POST against a
live business unless you intend to create a booking.

## Required origin and CSP setup

1. Add the business's website in Settings > Website connection (copying the inline or popup code
   saves it), or add exact HTTPS origins to the operator-wide, comma-separated
   `KALENDR_BOOKING_FRAME_ANCESTORS` value for every business. Do not use wildcards.
   Details: [branding-and-address.md](branding-and-address.md).
2. If the business website has a Content Security Policy, allow the Kalendr origin in
   `frame-src` and the versioned loader URL in `script-src`.
3. Keep staff routes outside iframes. Kalendr sends `X-Frame-Options: DENY` on the
   staff workspaces.
4. For shared custom-domain infrastructure, narrow `frame-ancestors` per
   verified tenant at the edge rather than relying only on the deployment-wide
   ceiling.

Example host policy fragment:

```text
script-src 'self' https://booking.example.com;
frame-src 'self' https://booking.example.com;
```

## Verification checklist

- Open and close with a pointer, keyboard, Escape, and the close button.
- Confirm focus returns to the booking button and host-page scrolling is
  restored.
- Complete a test booking and verify that the host receives only an opaque
  reference.
- Test the business website's real desktop and mobile breakpoints.
- Confirm the browser console has no CSP, mixed-content, frame-ancestor, or
  origin-validation errors.
- Re-test after any domain, proxy, CSP, consent-manager, or tag-manager change.

The runnable local example is available at `/embed-demo`.
