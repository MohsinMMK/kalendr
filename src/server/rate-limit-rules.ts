/**
 * Every request limit in one place. Each rule counts requests for one key (an IP address,
 * a contact, an email or a link token) in a fixed window. The request that goes over the
 * limit is refused with 429 and a Retry-After header until the window ends.
 *
 * | Endpoint              | Limit                                         |
 * | --------------------- | --------------------------------------------- |
 * | Registration          | 5 per 15 minutes per IP                       |
 * | Staff sign-in         | 10 per 15 minutes per IP and per email        |
 * | Customer code request | 5 per hour per contact, per IP and per device |
 * | Booking step-up code  | 5 per hour per booking, 10 per hour per IP    |
 * | Step-up verify        | 5 per code, 30/hour/IP (+ growing delay)      |
 * | Sign-in link          | 5 per 15 minutes per email, 10 per IP         |
 * | Code verify           | 5 per code (patient_login_codes), 30/hour/IP  |
 * | Public availability   | 120 per minute per IP                         |
 * | Email check send     | 5 per hour per address, 20 per hour per IP     |
 * | Email check verify    | 5 per code, 30 per hour per IP                |
 * | Slot holds            | 40 per minute per IP                          |
 * | Public booking        | 10 per hour per IP, 5 per hour per contact    |
 * | Manage link actions   | 20 per hour per token                         |
 * | Waitlist offer link   | 30 per hour per token, 60 per hour per IP     |
 * | Waitlist sign-up      | 10 per hour per IP, 5 per day per contact     |
 * | Privacy choices       | 60 per hour per customer account              |
 * | Privacy requests      | 10 per hour per customer account              |
 * | Export download       | 30 per hour per IP                            |
 * | Privacy notice read   | 120 per minute per IP                         |
 * | Video visit screen    | 600 per 10 minutes per link token             |
 * | Queue door sign-up    | 10 per 10 min per IP, 100 per hour per link   |
 * | Queue door page read  | 120 per minute per IP                         |
 * | Calendar notifications | 600 per minute per IP                    |
 * | Calendar feed          | 120 per hour per link, 60 per minute per IP   |
 * | SMS short link (/m)  | 60 per minute per IP                          |
 * | Public API            | 600 per minute per key (plans: feature 14)    |
 * | Public API, bad key   | 60 per minute per IP                          |
 * | Assistant             | 40/10 min per IP, 12/min per chat, 60/hour per customer, 1200/hour per business |
 * | Company sign-in       | 60 per 15 minutes per IP                      |
 * | Directory sync (SCIM) | 600 per minute per token, 30 bad per IP       |
 * | Business directory    | 60 per minute per IP                          |
 * | Campaign test send    | 10 per hour per business                      |
 */

export interface RateLimitRule {
  /** Requests allowed in one window. The next one is refused. */
  readonly limit: number;
  readonly windowSeconds: number;
  /** Shown to the person who was refused. Plain words, no internal detail. */
  readonly message: string;
}

const minute = 60;
const hour = 60 * minute;

export const rateLimitRules = {
  "registration.ip": {
    limit: 5,
    windowSeconds: 15 * minute,
    message: "Too many sign-ups from this network. Wait a few minutes and try again.",
  },
  // The email code that starts a sign-up (/start).
  "sign_up_code.ip": {
    limit: 10,
    windowSeconds: hour,
    message: "Too many codes requested from this network. Try again later.",
  },
  "sign_up_code.email": {
    limit: 5,
    windowSeconds: hour,
    message: "Too many codes were sent to this address. Wait an hour, then ask for a new one.",
  },
  "sign_up_verify.ip": {
    limit: 30,
    windowSeconds: hour,
    message: "Too many attempts from this network. Try again later.",
  },
  "staff_sign_in.ip": {
    limit: 10,
    windowSeconds: 15 * minute,
    message: "Too many sign-in attempts. Wait a few minutes and try again.",
  },
  "staff_sign_in.email": {
    limit: 10,
    windowSeconds: 15 * minute,
    message: "Too many sign-in attempts. Wait a few minutes and try again.",
  },
  "magic_link.ip": {
    limit: 10,
    windowSeconds: 15 * minute,
    message: "Too many sign-in links requested. Wait a few minutes and try again.",
  },
  "magic_link.email": {
    limit: 5,
    windowSeconds: 15 * minute,
    message: "Too many sign-in links requested. Wait a few minutes and try again.",
  },
  "code_request.contact": {
    limit: 5,
    windowSeconds: hour,
    message: "Too many codes requested. Wait an hour, then ask for a new code.",
  },
  "code_request.ip": {
    limit: 5,
    windowSeconds: hour,
    message: "Too many codes requested from this network. Try again later.",
  },
  // A device is one browser, named by a cookie the first request sets (feature 8). A script that drops the cookie is
  // still stopped by the IP and contact rules.
  "code_request.device": {
    limit: 5,
    windowSeconds: hour,
    message: "Too many codes requested from this device. Try again later.",
  },
  // A one-time code sent so someone with a manage link can cancel, move or change contact details (feature 8).
  "step_up.appointment": {
    limit: 5,
    windowSeconds: hour,
    message: "Too many codes were sent for this booking. Wait an hour, or call the business.",
  },
  "step_up.ip": {
    limit: 10,
    windowSeconds: hour,
    message: "Too many codes requested from this network. Try again later.",
  },
  "step_up_verify.ip": {
    limit: 30,
    windowSeconds: hour,
    message: "Too many attempts from this network. Try again later.",
  },
  "portal_devices.account": {
    limit: 60,
    windowSeconds: hour,
    message: "Too many changes to your devices. Try again later.",
  },
  // The 5-attempts-per-code limit lives on the code itself (patient_login_codes.attempt_count).
  "code_verify.ip": {
    limit: 30,
    windowSeconds: hour,
    message: "Too many sign-in attempts. Wait a while and try again.",
  },
  "availability.ip": {
    limit: 120,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  "email_check.ip": {
    limit: 20,
    windowSeconds: hour,
    message: "Too many codes requested from this network. Try again later.",
  },
  "email_check.email": {
    limit: 5,
    windowSeconds: hour,
    message: "Too many codes were sent to this address. Wait an hour, then ask for a new one.",
  },
  "email_check_verify.ip": {
    limit: 30,
    windowSeconds: hour,
    message: "Too many attempts from this network. Try again later.",
  },
  // Checkout and payment-status calls (feature 23). The status screen polls, so this is generous per network.
  "payments.ip": {
    limit: 120,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  // The public coupon check (feature 25): tight, so codes cannot be guessed by trying them one after another.
  "coupon_validate.ip": {
    limit: 20,
    windowSeconds: 10 * minute,
    message: "Too many codes tried. Wait a few minutes and try again.",
  },
  "holds.ip": {
    limit: 40,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  // New holds from one network at one business, over one hold's lifetime: caps how many times one sender can keep closed.
  "holds_create.ip_business": {
    limit: 12,
    windowSeconds: 5 * minute,
    message: "Too many times held. Wait a few minutes and try again.",
  },
  "booking.ip": {
    limit: 10,
    windowSeconds: hour,
    message: "Too many bookings from this network. Try again later or call to book.",
  },
  "booking.contact": {
    limit: 5,
    windowSeconds: hour,
    message: "Too many bookings for these contact details. Try again later or call to book.",
  },
  "queue_read.ip": {
    limit: 120,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  "queue_join.ip": {
    limit: 10,
    windowSeconds: 10 * minute,
    message: "Too many sign-ups from this network. Please ask at the front desk.",
  },
  "queue_join.link": {
    limit: 100,
    windowSeconds: hour,
    message: "Too many sign-ups through this link. Please ask at the front desk.",
  },
  "visit.token": {
    // The call screen polls every 5 seconds and sends a heartbeat every 20, so a long visit stays well under this.
    limit: 600,
    windowSeconds: 10 * minute,
    message: "Too many requests from this call screen. Close it and open your link again.",
  },
  "short_link.ip": {
    limit: 60,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  // Printed booking links (/s/<code>, feature 52) and the after-booking redirect address and summary check.
  "booking_link.ip": {
    limit: 120,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  // Routing forms (feature 46): opening, answering, and one form's total, so a flood on one form cannot fill a business's table.
  "routing_form.read.ip": {
    limit: 120,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  "routing_form.open.ip": {
    limit: 30,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  "routing_form.submit.ip": {
    limit: 30,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  "routing_form.submit.form": {
    limit: 600,
    windowSeconds: minute,
    message: "This form is very busy right now. Wait a moment and try again.",
  },
  "booking_redirect.ip": {
    limit: 60,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  "manage_link.token": {
    limit: 20,
    windowSeconds: hour,
    message: "Too many changes to this booking. Try again later or call to change it.",
  },
  // An offered waitlist time (feature 21). The token is the only proof, so a guesser is stopped by the IP rule long before
  // 256 bits matter; the token rule keeps one link from being hammered.
  "offer.token": {
    limit: 30,
    windowSeconds: hour,
    message: "Too many requests for this link. Try again later or call the business.",
  },
  // The one-tap rating page (feature 51): the token is the only proof, so a guesser meets the IP rule first.
  "rating_link.ip": {
    limit: 60,
    windowSeconds: hour,
    message: "Too many requests from this network. Try again later.",
  },
  "rating_link.token": {
    limit: 20,
    windowSeconds: hour,
    message: "Too many changes to this rating. Try again later.",
  },
  "offer.ip": {
    limit: 60,
    windowSeconds: hour,
    message: "Too many requests from this network. Try again later.",
  },
  "waitlist_join.ip": {
    limit: 10,
    windowSeconds: hour,
    message: "Too many waitlist sign-ups from this network. Try again later or call to join.",
  },
  "waitlist_join.contact": {
    limit: 5,
    windowSeconds: 24 * hour,
    message: "These contact details have joined the waitlist several times today. Try again tomorrow or call to change it.",
  },
  "calendar_webhook.ip": {
    limit: 600,
    windowSeconds: minute,
    message: "Too many requests.",
  },
  "calendar_feed.token": {
    limit: 120,
    windowSeconds: hour,
    message: "This calendar link is being read too often. Try again later.",
  },
  "privacy_portal.account": {
    limit: 60,
    windowSeconds: hour,
    message: "Too many changes to your privacy choices. Try again later.",
  },
  "privacy_request.account": {
    limit: 10,
    windowSeconds: hour,
    message: "Too many privacy requests. Try again later.",
  },
  "privacy_download.ip": {
    limit: 30,
    windowSeconds: hour,
    message: "Too many download attempts from this network. Try again later.",
  },
  "api_key.minute": {
    limit: 600,
    windowSeconds: minute,
    message: "Too many requests for this API key. Wait for the Retry-After time and try again.",
  },
  "api_key.bad_key": {
    limit: 60,
    windowSeconds: minute,
    message: "Too many requests with an invalid API key. Wait a moment and try again.",
  },
  // OAuth for apps (feature 55): the token endpoint counts per network, and a sign-in attempt per person.
  "oauth.token.ip": {
    limit: 60,
    windowSeconds: minute,
    message: "Too many token requests from this network. Wait a moment and try again.",
  },
  // Device sign-in (feature 57): asking for and collecting a code per network, and typing a code per person.
  "oauth.device.ip": {
    limit: 30,
    windowSeconds: minute,
    message: "Too many sign-in attempts from this network. Wait a moment and try again.",
  },
  "oauth.device_code.user": {
    limit: 10,
    windowSeconds: 10 * minute,
    message: "Too many codes entered. Wait a few minutes and try again.",
  },
  "oauth.client.ip": {
    limit: 30,
    windowSeconds: minute,
    message: "Too many attempts with an app secret. Wait a moment and try again.",
  },
  "calendar_feed.ip": {
    limit: 60,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  // The MCP server (feature 54). Staff tools are also counted by `api_key.minute`, per key.
  "mcp.ip": {
    limit: 120,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  "mcp.start_booking.ip": {
    limit: 10,
    windowSeconds: minute,
    message: "Too many booking attempts from this network. Wait a moment and try again.",
  },
  "privacy_notice.ip": {
    limit: 120,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  // The unsubscribe link in a marketing message (feature 28). It needs no sign-in, so it is counted by network.
  "unsubscribe.ip": {
    limit: 60,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  // The certificate host asks before issuing a certificate for an own web address (feature 13).
  "domain_check.ip": {
    limit: 300,
    windowSeconds: minute,
    message: "Too many requests. Wait a moment and try again.",
  },
  // The AI assistant (feature 30). Each message can cost a model call, so the limits are tighter than a page read.
  "assistant.ip": {
    limit: 40,
    windowSeconds: 10 * minute,
    message: "You're sending messages quickly. Wait a few minutes, or use the booking page.",
  },
  "assistant.conversation": {
    limit: 12,
    windowSeconds: minute,
    message: "Slow down a little. Wait a minute and try again.",
  },
  "assistant.customer": {
    limit: 60,
    windowSeconds: hour,
    message: "You've sent a lot of messages. Please use the booking page, or call us.",
  },
  "assistant.tenant": {
    limit: 1200,
    windowSeconds: hour,
    message: "The assistant is very busy. Please use the booking page for now.",
  },
  "assistant.code": {
    limit: 5,
    windowSeconds: hour,
    message: "Too many codes requested. Wait an hour, or use the booking page.",
  },
  // Company sign-in (feature 53): finding the connection for an address, starting a sign-in and the provider's reply.
  "sso.ip": {
    limit: 60,
    windowSeconds: 15 * minute,
    message: "Too many company sign-in attempts. Wait a few minutes and try again.",
  },
  // The company directory (feature 53): a token may call often, a wrong one rarely.
  "scim.token": {
    limit: 600,
    windowSeconds: minute,
    message: "Too many requests. Slow down and retry after the pause.",
  },
  "scim.bad_token": {
    limit: 30,
    windowSeconds: minute,
    message: "Too many requests with an invalid token.",
  },
  // The public /explore directory (feature 29): each page view runs one search, so a person browsing is far below this.
  "directory.ip": {
    limit: 60,
    windowSeconds: minute,
    message: "Too many searches. Wait a moment and try again.",
  },
  // A campaign test send is a real WhatsApp, SMS or email, so a script can't turn it into a free bulk sender.
  "campaign_test.tenant": {
    limit: 10,
    windowSeconds: hour,
    message: "Too many test messages this hour. Wait a while and try again.",
  },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitRuleName = keyof typeof rateLimitRules;

export const rateLimitRuleNames = Object.keys(rateLimitRules) as RateLimitRuleName[];
