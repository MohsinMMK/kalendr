# Embeds and conversion (feature 52)

How a business gets people to book from its own website, print and social bios, and how it counts what worked. The developer-facing reference is
[developers/embed.md](developers/embed.md). Summary:

- **Share and embed sheet** (Settings → Website connection, and each service's ⋯ menu): link and QR code, short links with click counts, the embed builder with a live preview, "times for an email", and tracking ids.
- **`/embed.js`** (`public/embed.js`): inline, popup and floating modes; the older `/kalendr-widget.js` keeps working.
- **Events** to the host page: `opened`, `service_selected`, `slot_selected`, `booked`, `rescheduled`, `cancelled`, `failed`; ids and times only.
- **After booking** (per service): Kalendr's confirmation with an optional message and without details, or the business's own thank-you page with the booking id (and, if chosen, service, start and a signed 15-minute summary).
- **Pixels**: Google Analytics, Tag Manager, Meta, Plausible; ids only; booking pages only; after consent.
- **Short links**: `/s/<7 characters>`; visits counted, no address stored.

## Data and security

- Migration `0063_embeds`: `services.after_booking / redirect_url / pass_details_on_redirect / success_message / hide_success_details`, `tracking_settings`, `booking_short_links` (named apart from the SMS `short_links`), forced RLS on both new tables, and the definer function `kalendr_follow_booking_link(code)` (counts the visit, returns the path, nothing else).
- Routes: `/api/staff/short-links`, `/api/staff/tracking`, `/api/staff/embed/context`, `/api/staff/embed/email-times`, `/api/public/booking-redirect`, `/api/public/booking-summary`, `/s/[code]`. Every staff write calls the support-session guard.
- The content security policy adds the analytics hosts on `/book` pages only (`tracking` in `src/lib/security-headers.ts`); frame-ancestors stay `'none'` everywhere except `/book`, which allows the hosts in `KALENDR_BOOKING_FRAME_ANCESTORS`.
- A short link's address is always built from fixed pieces and checked by the database, so it can only lead to one of the business's own booking pages.

## Known limits

- The CSP lists the analytics hosts for every business's booking pages (the proxy does not read the database per request); the script only loads for a business that saved an id and a visitor who allowed it.
- The host-page `rescheduled` and `cancelled` events exist in the protocol but the manage page does not raise them yet (the manage page is not shown inside the embed).
- Frame permission is deployment-wide (`KALENDR_BOOKING_FRAME_ANCESTORS`); a per-business list waits for saved embed origins.
- Redirects from inside a frame ask the website's loader to navigate; a plain `<iframe>` without the loader navigates the frame itself.
