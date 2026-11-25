# Libraries and outside services

Everything to install and every service to connect, in one place. Each row names the feature that needs it, so nothing is installed before it is used.

Versions were the latest on npm on 12 November 2026. Before installing, confirm with `pnpm view <name> version` and read the library's current docs. Libraries marked "check" were not looked up; find the version yourself.

## 1. What is already installed (keep using these)

| Job | Library |
| --- | --- |
| App framework | `next` 16.4.6, `react` 19.3.1 |
| Sign-in for staff | `better-auth` 1.7.20 |
| Database | `drizzle-orm` 0.45.4, `postgres` 4.1.0, `drizzle-kit` |
| Checking input | `zod` 4.6.7 |
| Forms | `react-hook-form`, `@hookform/resolvers` |
| Screens | `@base-ui/react` and the coss components in `src/components/ui`, `tailwindcss` 4.3, `lucide-react` |
| Dates and timezones | `date-fns`, `@date-fns/tz`, `@daypicker/react` |
| QR codes | `uqr` |
| Tests | `vitest` 5.1, `@testing-library/*`, `jsdom` |

Do not replace any of these. Do not add a second library that does the same job.

## 2. Libraries to add

### Stage 0: Safety net

| Library | Version | Feature | What it does here |
| --- | --- | --- | --- |
| `pg-boss` | 12.38.2 | 1 | Timed and repeating jobs stored in PostgreSQL (reminder sweeps, hold expiry, renewals). The existing outbox stays as the hand-off from a booking to the worker |
| `@sentry/nextjs` | 11.12.0 | 35 | Error reports from the app and the worker |
| `@vercel/otel` | 2.3.0 | 35 | Request tracing through `instrumentation.ts`. Use `@opentelemetry/sdk-node` 0.301.1 instead if not hosting on Vercel |
| `pino` | 10.4.0 | 35 | Structured logs with a request id and tenant id |
| `@playwright/test` | 1.65.0 (dev) | 35 | Browser tests |
| `@axe-core/playwright` | 4.14.0 (dev) | 35 | Accessibility scan inside browser tests |
| `knip` | 6.45.1 (dev) | 35 | Finds unused files and dependencies |
| `@upstash/ratelimit` | 2.2.0 | 9 | **Optional.** Only if the host already has Redis. The default limiter is a PostgreSQL table |

### Stage 1: Reach people

| Library | Version | Feature | What it does here |
| --- | --- | --- | --- |
| `resend` | 6.38.0 | 2 | Sends email |
| `react-email` | 6.11.16 | 2 | Email components, rendering and local preview (replaces deprecated `@react-email/components`) |
| `svix` | 2.10.0 | 2 | Verifies Resend's delivery webhooks |
| `libphonenumber-js` | 1.13.16 | 3, 4, 8 | Turns phone numbers into the international format providers need |
| `twilio` | 6.3.0 | 4 | SMS outside India |

WhatsApp and MSG91 need **no library**. Both are plain HTTPS calls with `fetch`. Meta's own Node SDK is deprecated.

### Stage 2: Trust

| Library | Version | Feature | What it does here |
| --- | --- | --- | --- |
| `better-auth` | bump to 1.7.21 | 6 | Brings the built-in `magicLink` and `twoFactor` plugins and social sign-in |
| `@better-auth/passkey` | 1.7.21 | 6 | Sign in with fingerprint, face or device PIN |
| `@aws-sdk/client-s3` | 3.1167.0 | 10 | File storage on S3, Cloudflare R2 or MinIO |
| `@aws-sdk/client-kms` | check | 10 | Managed encryption keys |
| `@aws-sdk/s3-request-presigner` | check | 10 | Short-lived upload links |
| `fflate` | check | 7 | Builds the zip for a customer's data export |

Virus scanning uses ClamAV as a container in `compose.yaml`, spoken to over its network socket. Pick the client library at build time, or write the small `INSTREAM` client by hand (about 40 lines).

### Stage 3: Earn

| Library | Version | Feature | What it does here |
| --- | --- | --- | --- |
| `razorpay` | 2.9.8 | 14, 23, 25 | Payments, payment links, subscriptions and UPI Autopay in India |
| `stripe` | 23.1.0 | 14, 23 | Payments and subscriptions outside India |
| `@react-pdf/renderer` | 4.9.0 | 24 | Invoice and receipt PDFs, made in the worker |

Do not use `@better-auth/stripe`. Kalendr's businesses live in its own `tenants` table, not in better-auth organisations.

### Stage 4: Win new businesses

| Library | Version | Feature | What it does here |
| --- | --- | --- | --- |
| `papaparse` | 5.7.1 | 12 | Reads uploaded CSV files |
| `posthog-js`, `posthog-node` | 1.447.12, 5.69.0 | 11, 26 | **Optional.** Onboarding funnel, only with consent |
| `driver.js` | 1.11.0 | 11 | **Fallback only.** Build the tour from the coss Popover first |

Custom web addresses need no library: DNS checks use Node's built-in `node:dns/promises`.

### Stage 5: Schedule anything

| Library | Version | Feature | What it does here |
| --- | --- | --- | --- |
| `googleapis` | 189.0.0 | 16 | Google Calendar |
| `@microsoft/microsoft-graph-client` | 3.0.7 | 16 | Outlook calendar |
| `tsdav` | 2.5.0 | 16 | Apple iCloud and other CalDAV calendars |
| `rrule` | 2.8.1 | 17 | Repeat rules (every week, every second Tuesday) |
| `@daily-co/daily-js` | 0.95.0 | 19 | The video call screen in the browser |

### Stage 6: Grow

| Library | Version | Feature | What it does here |
| --- | --- | --- | --- |
| `recharts` | 3.10.1 | 26 | Charts, through the coss chart composition |
| `@tanstack/react-table` | 9.3.1 | 26, 27 | Sortable, filterable tables |

### Stage 7: Stand out

| Library | Version | Feature | What it does here |
| --- | --- | --- | --- |
| `@tanstack/react-query` | 5.107.1 | 31, 32 | Fetching, caching and optimistic updates on staff screens |
| `nuqs` | 2.10.3 | 31 | Filters and views kept in the web address |
| `web-push` | 4.0.0 | 32 | Push alerts to phones and desktops |
| `@serwist/next` | 9.5.13 | 32 | Service worker for the installable app. Test with the webpack build this project uses |
| `next-intl` | 4.15.0 | 33 | Languages |
| `zod-openapi` | 6.0.2 | 34 | Builds API docs from the Zod contracts already written |
| `@scalar/nextjs-api-reference` | 0.12.17 | 34 | Shows the API docs page |
| `ai`, `@ai-sdk/anthropic`, `@ai-sdk/react` | 7.0.181, 4.0.107, 4.0.186 | 30 | The booking assistant and the staff copilot (replaced `@anthropic-ai/sdk`) |

## 3. Outside services

For each: how Kalendr proves who it is, what it calls, what the service calls back, and how to test without real customers.

### Email: Resend (feature 2)

| | |
| --- | --- |
| Proves identity with | API key in the `Authorization: Bearer` header |
| Kalendr calls | Send one email; send a batch |
| Service calls back | `email.delivered`, `email.bounced`, `email.complained` to `/api/webhooks/resend`, signed with Svix headers |
| Test without customers | Resend's test addresses; a fake adapter in tests |
| Set up first | Verify the sending domain (SPF, DKIM, DMARC records) |

### WhatsApp: Meta Cloud API (feature 3)

| | |
| --- | --- |
| Proves identity with | A permanent system-user token as `Authorization: Bearer` |
| Kalendr calls | `POST https://graph.facebook.com/v23.0/{phone-number-id}/messages` with a template name, language and variables |
| Service calls back | Message status (sent, delivered, read, failed), incoming replies and button taps, and `message_template_status_update` to `/api/webhooks/whatsapp`. A `GET` with `hub.challenge` verifies the address once |
| Signature | **Confirm in Meta's docs before building.** Expected: `X-Hub-Signature-256`, an HMAC-SHA256 of the raw body with the app secret |
| Test without customers | Meta's test number and up to five test recipients |
| Rules to respect | Customers must opt in. Business-started messages must use an approved template. Free-form replies are allowed only within 24 hours of the customer's last message. Each delivered template message is charged by category (marketing, utility, authentication) |
| Set up first | Meta Business verification, a WhatsApp Business Account, a phone number not already on WhatsApp, approved templates. Allow one to two weeks |

### SMS in India: MSG91 (feature 4)

| | |
| --- | --- |
| Proves identity with | `authkey` header |
| Kalendr calls | `POST https://api.msg91.com/api/v5/flow/` with the flow (template) id and variables |
| Service calls back | Delivery reports to `/api/webhooks/msg91` |
| Rules to respect | India's DLT rules: the business sending must be registered as a Principal Entity, with an approved header (sender name) and every template approved word for word. Variables must be tagged. Unregistered messages are blocked by the networks |
| Set up first | DLT registration (about ₹5,900, several days), then header and template approval |

### SMS elsewhere: Twilio (feature 4)

| | |
| --- | --- |
| Proves identity with | Account SID and auth token |
| Kalendr calls | Create message |
| Service calls back | Status callback to `/api/webhooks/twilio`, signed with `X-Twilio-Signature` |
| Test without customers | Twilio test credentials and magic numbers |

### Sign-in with Google and Microsoft (feature 6)

| | |
| --- | --- |
| Proves identity with | OAuth client id and secret per provider |
| Kalendr calls | Handled by better-auth at `/api/auth/callback/google` and `/api/auth/callback/microsoft` |
| Set up first | A Google Cloud project with an OAuth consent screen; a Microsoft Entra app registration. Sign-in scopes only (`openid email profile`) |

### Bot protection: Cloudflare Turnstile (feature 9)

| | |
| --- | --- |
| Proves identity with | Site key in the page, secret key on the server |
| Kalendr calls | `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with the token from the form |
| Test without customers | Cloudflare's published always-pass and always-fail test keys |

### File storage and keys: S3 and KMS (feature 10)

| | |
| --- | --- |
| Proves identity with | An access key limited to one bucket and one key, or the host's role |
| Kalendr calls | Put, get and delete objects; create data key and decrypt |
| Test without customers | MinIO in `compose.yaml`; a local key provider that mimics KMS |

### Payments in India: Razorpay (features 14, 23, 25)

| | |
| --- | --- |
| Proves identity with | Basic auth, `key_id:key_secret` |
| Kalendr calls | Orders, payment links (`POST /v1/payment_links`, amount in paise), refunds, subscriptions, and later Route transfers |
| Service calls back | `payment.captured`, `payment.failed`, `refund.processed`, `subscription.*` to `/api/webhooks/razorpay` |
| Signature | HMAC-SHA256 of the raw body in `X-Razorpay-Signature`. Remove duplicates with `x-razorpay-event-id` |
| Test without customers | Test mode keys and test cards/UPI ids |
| Rules to respect | UPI Autopay has a mandate ceiling and a lower limit for debits without a fresh approval. Read the current limits before building memberships |
| Set up first | Business KYC, which takes a few days |

### Payments elsewhere: Stripe (features 14, 23)

| | |
| --- | --- |
| Proves identity with | Secret key; Connect for each business's own account |
| Kalendr calls | Checkout Sessions, refunds, subscriptions, Connect onboarding |
| Service calls back | `checkout.session.completed`, `charge.refunded`, `invoice.*`, `customer.subscription.*` to `/api/webhooks/stripe`, verified with the signing secret over the raw body |
| Test without customers | Test mode, published test cards, and the Stripe CLI to replay webhooks |

### Calendars: Google, Microsoft, Apple (feature 16)

| | Google Calendar | Microsoft Graph | Apple iCloud (CalDAV) |
| --- | --- | --- | --- |
| Proves identity with | OAuth 2 with offline access; refresh token stored encrypted | OAuth 2; refresh token stored encrypted | App-specific password stored encrypted |
| Reads busy time | `freebusy.query`, `events.list` with a sync token | `calendarView` with a delta link | `tsdav` calendar query |
| Hears about changes | `events.watch` push channel (HTTPS only). The call carries only `X-Goog-*` headers, so fetch the changes after. **Channels expire and do not renew themselves** | Subscriptions, which also expire and must be renewed | No push. Poll every few minutes |
| Set up first | Calendar scopes are sensitive: Google's app verification can take weeks | Entra app registration with calendar permissions | Nothing |

### Video visits: Daily (feature 19)

| | |
| --- | --- |
| Proves identity with | API key on the server |
| Kalendr calls | Create a room per appointment; create a short-lived meeting token per person |
| Test without customers | Daily's free tier |

### Booking assistant: Claude API (feature 30)

| | |
| --- | --- |
| Proves identity with | `ANTHROPIC_API_KEY` |
| Kalendr calls | Messages API with tool use and streaming |
| Models | `claude-haiku-5-5` for everyday chat; `claude-sonnet-5-5` or `claude-opus-5-5` for harder requests |
| Before building | Load the `claude-api` skill for current model ids, pricing, caching and tool-use details |

### Error reports and push alerts

| Service | Feature | Notes |
| --- | --- | --- |
| Sentry | 35 | One DSN for the app and the worker. Strip personal data before sending |
| Web push | 32 | Needs no account. Generate a VAPID key pair once with `web-push` |

## 4. New environment variables

Add each to `.env.example` with a one-line comment when its feature is built. All are empty by default, and a feature with empty keys stays switched off rather than failing.

| Feature | Variables |
| --- | --- |
| 1 | `KALENDR_WORKER_MODE` (exists: add `production`), `WORKER_DATABASE_URL`, `WORKER_CONCURRENCY` |
| 2 | `RESEND_API_KEY` (exists), `EMAIL_FROM` (exists), `RESEND_WEBHOOK_SECRET`, `EMAIL_REPLY_TO` |
| 3 | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` |
| 4 | `SMS_PROVIDER` (exists: `msg91` or `twilio`), `MSG91_AUTH_KEY`, `MSG91_SENDER_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| 6 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` |
| 9 | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` |
| 10 | `KALENDR_FILE_STORE` (`disk` or `s3`), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `KMS_KEY_ID`, `CLAMAV_HOST`, `CLAMAV_PORT` |
| 13 | `KALENDR_ROOT_DOMAIN`, `KALENDR_CNAME_TARGET` |
| 14 | `RAZORPAY_PLATFORM_KEY_ID`, `RAZORPAY_PLATFORM_KEY_SECRET`, `RAZORPAY_PLATFORM_WEBHOOK_SECRET`, `STRIPE_PLATFORM_SECRET_KEY`, `STRIPE_PLATFORM_WEBHOOK_SECRET` |
| 15 | `KALENDR_ADMIN_EMAILS` (first operators only; later ones are added in the console) |
| 16 | `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `MICROSOFT_CALENDAR_CLIENT_ID`, `MICROSOFT_CALENDAR_CLIENT_SECRET`, `CALENDAR_WEBHOOK_TOKEN` |
| 19 | `VIDEO_PROVIDER` (`daily` or `none`), `DAILY_API_KEY`, `DAILY_DOMAIN` |
| 23 | `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_CONNECT_WEBHOOK_SECRET`. Each business's own Razorpay keys are stored encrypted in the database, not here |
| 30 | `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL`, `ASSISTANT_MONTHLY_TOKEN_CAP` |
| 32 | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |
| 35 | `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `LOG_LEVEL` |

Validate every variable in one place, `src/server/env.ts` (new in feature 35), with Zod. The app refuses to start in production when a switched-on feature is missing a key.

## 5. Webhook addresses to register

Every one follows the five steps in `STANDARDS.md` (raw body, signature, dedupe, record, return fast).

| Address | Service | Feature |
| --- | --- | --- |
| `/api/webhooks/resend` | Resend | 2 |
| `/api/webhooks/whatsapp` | Meta | 3 |
| `/api/webhooks/msg91`, `/api/webhooks/twilio` | SMS | 4 |
| `/api/webhooks/razorpay`, `/api/webhooks/stripe` | Payments | 14, 23 |
| `/api/webhooks/google-calendar`, `/api/webhooks/microsoft-graph` | Calendars | 16 |
| `/api/webhooks/daily` | Video (optional) | 19 |

Outgoing webhooks that Kalendr sends to its customers' own systems are feature 34.
