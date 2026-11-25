/** The website snippets shown on the page. Attribute names are exactly those in docs/developers/embed.md and docs/EMBEDDING.md. */

export const linkSnippet = `<a href="https://booking.example.com/book/northside-studio">
  Book an appointment
</a>`;

export const inlineSnippet = `<div id="kalendr-booking"></div>
<script
  src="https://booking.example.com/embed.js"
  data-kalendr-business="northside-studio"
  data-kalendr-mode="inline"
  data-kalendr-mount="#kalendr-booking"
  defer
></script>`;

export const popupSnippet = `<script
  src="https://booking.example.com/embed.js"
  data-kalendr-business="northside-studio"
  data-kalendr-service="haircut"
  data-kalendr-mode="popup"
  data-kalendr-label="Book a haircut"
  defer
></script>`;

export const eventSnippet = `window.addEventListener("kalendr:booked", (event) => {
  // event.detail.appointmentId, serviceId, startsAt, endsAt, status
});`;
