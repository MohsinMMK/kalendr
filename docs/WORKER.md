# Outbox worker and scheduler

`src/worker/run.ts` (built to `dist/worker.mjs`, started with `pnpm worker`) does two jobs:

1. It hands queued outbox rows to the message handlers.
2. It runs the repeating jobs.

It is the only part of Kalendr that sends anything. A web request never calls a provider. It writes an outbox row in the same transaction as the change, and the worker picks the row up.

## Modes

| `KALENDR_WORKER_MODE` | What a "sent" message means | Guards |
| --- | --- | --- |
| `local_capture` (default) | A `notifications` row with `provider_message_id = local:…`. Nothing leaves the machine. | Refuses `NODE_ENV=production` and any database host that is not loopback. This is the only mode tests and local runs use. |
| `production` | The message goes to the provider adapter for its channel. | Needs `NODE_ENV=production`. With no adapter for a channel, the message goes to dead letter as `provider_not_configured`. Staff see it on the Messages screen. |

Email has an adapter (feature 2, below). SMS and WhatsApp (features 3 and 4) will sit behind the same `ProviderAdapter` interface in `src/worker/delivery.ts`. The adapter receives:

- the business id and the patient id;
- the channel;
- the template key and the rendered body;
- an idempotency key that stays the same on every attempt;
- the business's database scope (`tenantDb`) and the appointment id.

It answers `sent` (with the provider's message id), `retry`, `rejected`, or `skipped` with a reason. A skipped message becomes a `cancelled` notification with `failure_code` set (for example `suppressed_bounced` or `no_destination`), and Messages shows the reason.

The adapter looks up the address itself. The worker never reads contact details. The `notifications.destination_ciphertext` column holds only a marker (`local-capture:no-recipient` or `provider:<channel>`).

## Email (feature 2)

`src/worker/email-adapter.ts` turns one message into one branded email:

1. It reads the business, the recipient and the booking inside that business's row-level security scope.
2. It checks `message_suppressions` first. A suppressed address is skipped and never reaches the provider.
3. It renders a React Email template from `src/emails/` (HTML and plain text) with the business name, logo, accent colour and the business's own words.
4. Booking emails attach `appointment.ics` (`src/server/icalendar.ts`) and carry the private manage link. The link's token is stored sealed on the booking (`appointments.manage_token_ciphertext`, AES-256-GCM bound to the business and booking, see `src/server/messaging/sealed-link.ts`), because only its hash is kept otherwise.
5. It sends through the `MessageProvider` (`src/server/messaging/`): Resend in production, the fake in unit tests, the capture server in browser tests. The sender name is the business name and Reply-To is the business's email (`EMAIL_REPLY_TO` when the business has none). The notification's semantic key is Resend's `Idempotency-Key`, so a retry after a timeout sends once.

Resend reports delivery to `POST /api/webhooks/resend`, verified with svix against the raw body (`RESEND_WEBHOOK_SECRET`). The route finds the notification by the provider's message id through the narrow `kalendr_resolve_email_notification()` lookup, records the event once in `message_delivery_events`, and marks the notification delivered or failed. A hard bounce or a spam complaint adds the address's hash to `message_suppressions`.

### WhatsApp and SMS (features 3 and 4)

All three channels sit behind one interface, `src/server/channels/types.ts` (send, signed webhook parsing, capture mode). The worker has an adapter per channel (`whatsapp-adapter.ts`, `sms-adapter.ts`) that reads the customer and booking itself, picks the approved template from `message_templates` (`src/lib/channel-templates.ts` maps an event to a template key), and sends variables only. An event with no template for the chosen channel goes by email. The channel is chosen by `notificationChannel`: the customer's choice once they agreed to messages, limited to what the business switched on (`tenant_channel_settings`) and what the worker can send; order WhatsApp, then SMS, then email.

Provider callbacks (`POST /api/webhooks/whatsapp`, `/api/webhooks/msg91/<token>`, `/api/webhooks/twilio`) verify the signature over the raw body, resolve the business from the provider's message id through narrow `SECURITY DEFINER` lookups (`kalendr_resolve_provider_message`, `kalendr_resolve_inbound_threads`), and queue one outbox row per event, keyed by the provider's event id. The worker applies them (`handlers/channel-events.ts`): delivery status (never backwards; read is `notifications.read_at`), a **Confirm** tap (appointment confirmed, version bumped, audit row, same as the customer's own confirm), a **Reschedule** tap (replies with the manage link), free text (sealed into `messages`, unread count up, 24-hour window opened), and STOP (consent cleared, audit row, one confirmation text; STOP reaches every business that has written to that number). A WhatsApp failure queues one SMS (`notification.sms_fallback`, keyed on the failed notification's id) that replays the original event with SMS forced, so it is dropped if the booking has changed since.

Staff replies are written as `messages` rows plus a `thread.reply` outbox event; free text is refused after the window closes and only approved templates can go.

In local capture, WhatsApp is sent only when `WHATSAPP_API_URL` is a loopback address (e2e capture server `/whatsapp`); SMS likewise with `MSG91_API_URL` / `TWILIO_API_URL`.


`KALENDR_WORKER_MODE=local_capture` sends email through the real adapter only when `EMAIL_API_URL` is a loopback address (the capture server); everything else is recorded locally. `pnpm email:dev` previews every template at http://localhost:3030.

## Run it

Locally, against the cluster that `scripts/local-db.sh` manages. `start` creates the worker role:

```sh
scripts/local-db.sh start
scripts/local-db.sh migrate
scripts/local-db.sh run pnpm worker:local     # tsx, from source
```

`local-db.sh run` exports `WORKER_DATABASE_URL` as the worker role. Stop the worker with Ctrl-C.

In the image, `docker compose --profile app up worker` runs `node dist/worker.mjs` in local capture mode. A production deployment runs `pnpm worker` (or `node dist/worker.mjs`) with:

| Variable | Meaning |
| --- | --- |
| `KALENDR_WORKER_MODE=production` | Use the provider adapters. |
| `NODE_ENV=production` | Required by production mode. |
| `WORKER_DATABASE_URL` | Connects as `kalendr_worker`. |
| `WORKER_CONCURRENCY` | 1–32. Default 4. Rows claimed per round = 4 × concurrency, at most 100. |

Run two or more workers for availability. They share the queue safely.

## Database role

The worker connects as its own role, `kalendr_worker` (`kalendr_local_worker` locally):

- It has no `BYPASSRLS` and is not a superuser.
- Every table it touches has forced row-level security, so it sees a business's rows only after it sets `app.tenant_id` inside a transaction.

Some work spans businesses. For that, the worker can call three `SECURITY DEFINER` functions. They are revoked from `PUBLIC` and from the web app's role, and none of them returns content:

| Function | Returns |
| --- | --- |
| `kalendr_claim_outbox(worker_id, batch_size)` | `(tenant_id, id)` of up to 100 due rows, leased to this worker. |
| `kalendr_worker_tenants(job)` | The ids of businesses that have work for one timed job. |
| `kalendr_outbox_health()` | Four counts: pending, oldest pending in seconds, dead letters, and businesses with dead letters. |

Everything after the claim happens inside that business's scope.

pg-boss keeps its tables in the `kalendr_jobs` schema. The migration creates the schema and the release step grants the worker `USAGE, CREATE` on it. pg-boss creates its tables there on first start, so the worker role owns them.

## Processing contract

- **Claim.**
  - `kalendr_claim_outbox` takes due rows (`pending`, or `failed` past `available_at`, or `processing` with a lease older than 60 seconds) with `FOR UPDATE SKIP LOCKED`.
  - It stamps each row with a unique lease token (`locked_by`) and `locked_at`, and adds one to `attempt_count`.
  - Two workers never hold the same row.
- **Handle.**
  - Each row is handled in its own transaction under `app.tenant_id`.
  - The worker re-checks the lease first. If another worker took the row over after an expired lease, the result is `lease_lost` and nothing is written.
  - The handler has the signature `(tenantDb, event) => "delivered" | "retry" | "dead"`, or `{ outcome, code }`. It re-reads and locks the appointment.
  - A payload version older than the appointment's current version is a stale event. So is a status the message no longer fits, or a reminder for an appointment that was cancelled or has already started. A stale event is marked delivered with no message. This is how a reminder for a moved appointment is dropped.
- **Retry.**
  - A `retry`, or an error the handler throws, sets the row to `failed` with `available_at = now + 5 s × 2^(attempt − 1)`, capped at one hour: 5 s, 10 s, 20 s, 40 s and so on.
  - The 8th failed attempt sets `dead_letter`.
  - A malformed payload or an unknown event type goes to dead letter at once.
  - `last_error_code` holds a short code only, never a provider message, an address or the body.
- **Exactly once.** The `notifications` row has a unique `(tenant_id, semantic_key)`. The key is a hash of the event's dedupe key, which names the appointment, the change and its version. A replay finds the row and sends nothing new. A provider send is idempotent by the same key.
- **Shut down.**
  - On SIGTERM or SIGINT the worker stops claiming and finishes the rows it has started.
  - It hands back the rows it has not started: `releaseClaims` returns them to `pending` (or to `failed` if an earlier attempt failed) with the attempt refunded.
  - It stops pg-boss gracefully, marks its heartbeat row stopped, and exits.
  - A worker that is killed outright leaves its leases behind. They expire after 60 seconds and another worker takes the rows over.

## Repeating jobs (pg-boss 12)

pg-boss stores each schedule once, so many workers still run each job once per tick. Every queue uses the `singleton` policy, so a slow run does not overlap the next. Times are UTC.

| Job | Schedule | What it does |
| --- | --- | --- |
| `reminder-sweep` | every minute | Queues `appointment.reminder` for requested or booked appointments with `reminder_status = 'queued'` that start within 24 hours. The dedupe key contains the appointment version, so a moved appointment gets a new reminder. |
| `hold-expiry` | every minute | Releases slot holds past `hold_expires_at`. |
| `waitlist-sweep` | every minute | Smart waitlist (feature 21), the safety net behind the timed events: offers past their answer time are ended and passed to the next person (or the time goes back to public booking), and an offer whose message never went out is queued again. Finds businesses through `kalendr_worker_tenants('waitlist_sweep')`. |
| `calendar-renewal` | hourly | Calendar sync (feature 16). Queues `calendar.renew` for every calendar whose watch channel ends within 25 hours, or that has none. Key carries the hour, so a repeat in the same hour adds nothing. |
| `calendar-poll` | every 5 minutes | Queues `calendar.sync` for calendars that cannot ping the webhook: Apple, and Google or Outlook with no channel (for example no public https address yet). |
| `calendar-resnapshot` | 15 past each hour | Queues a full re-read (`resnapshot`) for blocking calendars not fully read for 20 hours, so the saved window never goes stale. Also deletes webhook records older than a week. |
| `request-expire` | every minute | Approval rules (feature 41). Closes `requested` bookings whose start has passed as `expired` (system audit row, reservations released, `appointment.status.expired` queued, workflows re-planned). Finds businesses through `kalendr_worker_tenants('request_expiry')`. |
| `request-reminder` | every 5 minutes | One staff inbox row (`booking_request`, dedupe `request.reminder:<id>`) when half of the time between asking and the start has passed. |
| `reschedule-expire` | every 5 minutes | Cancel and reschedule policy (feature 42). A `reschedule_requested` booking whose customer did not choose within `services.reschedule_request_days` becomes `cancelled` (`cancelled_by = system`, reason `reschedule_expired`) and the customer gets the cancelled notice. |
| `retention` | 03:00 nightly | Deletes expired idempotency keys and delivered outbox rows older than 30 days. Dead letters are kept. |
| `dead-letter-report` | hourly | Logs the dead-letter counts for alerting. |
| `privacy-retention` | 03:20 nightly | Privacy centre (feature 7). Applies each business's retention settings (message log, details on cancelled bookings, delivered hand-off rows, records of erased customers) and removes sign-in codes older than a day and customer sessions that ended more than a day ago. One `privacy.retention.applied` audit row per business with the counts; the sign-in code count is in the job's log line. The older `retention` job still removes expired idempotency keys and delivered rows at 30 days. |
| `privacy-overdue` | 04:00 daily | Queues `privacy.request.overdue` for each open customer privacy request past its due date, once per request (`data_requests.overdue_alerted_at`). |
| `storage-re-encrypt` | every 10 minutes | Protected storage (feature 10). For each business with records, form answers, files or pictures on an older key version, re-encrypts up to a batch of them with the current key, then retires versions nothing uses any more (including version 0, the old server-wide key). Safe to repeat. |
| `key-rotation` | 02:30 daily | Replaces a business's data key once its newest key is a year old, and writes `security.keys.rotated` (reason `yearly`) to the audit log. Admins can also rotate at once from Settings → Data protection. |
| `media-backfill` | every 15 minutes | Moves business pictures (`media_assets.data`) and staff photos (`practitioners.photo_data_url`) into the encrypted file store, in batches. Each keeps its address. With scanning on, a moved picture waits for its scan. |
| `storage-health` | 5 past each hour | Logs three counts across all businesses: items on older keys, files waiting for a scan, pictures still to move. Counts only, from `kalendr_storage_health()`. |

The storage jobs find businesses through `kalendr_storage_tenants(job)`, a SECURITY DEFINER function that returns business ids only and is revoked from PUBLIC and from the web app's role, then do all work inside that business's row-level-security scope.

The calendar jobs find businesses through `kalendr_calendar_tenants(job)`, a SECURITY DEFINER function that returns business ids only and is revoked from PUBLIC and from the web app's role. Like the other timed jobs they only queue outbox rows; every provider call happens in a handler.

Outbox events added by feature 16 (calendar sync, `src/worker/calendar/`):

| Event | What it does |
| --- | --- |
| `calendar.verify` | Checks a login the web app saved (status `pending`), lists its calendars, makes the primary one block availability, queues the first read. A refused login becomes `needs_reconnect` (`bad_login`). |
| `calendar.sync` | Reads one calendar with its sync token (a full read when the token is missing or rejected). Replaces or updates `external_busy` (start, end, event id only; "free" and cancelled events and Kalendr's own events never block), raises "needs a person" items for linked events moved or deleted outside, opens or renews the watch channel. The selection row is locked first, so two reads of one calendar take turns. A revoked login marks the connection `needs_reconnect`, drops its busy time and alerts the person once. |
| `calendar.write` | Reconciles a staff member's calendar with an appointment (create, update, delete or nothing) using the link's field hash, so retries and out-of-order events are harmless. It never overwrites an event changed outside: an If-Match failure queues a read, which raises the item. Queued next to every `appointment.*` message event (`withCalendarWrite`), as its own row. |
| `calendar.renew` | Renews or opens one calendar's watch channel. |
| `calendar.disconnect` | Stops the channels, then deletes the connection and everything saved from it. The person's own calendar is untouched. |

Handlers return outcomes instead of throwing after a provider call, because a thrown error rolls back the transaction, including a refresh token the provider has already rotated.

Outbox events added by feature 10:

| Event | Handler | What it does |
| --- | --- | --- |
| `file.scan` | `scan-file.ts` | Reads the encrypted file from the store, decrypts it in memory, streams it to ClamAV (`CLAMAV_HOST`, `CLAMAV_PORT`) and marks it `clean` or `infected`. A clean file can be opened and shared. An infected one is marked, its bytes are queued for removal, and an audit row `record.file.infected` names the uploader; an infected picture's row is deleted. An unreachable scanner is a retry; after 8 attempts the file stays pending. |
| `file.remove` | `scan-file.ts` | Deletes an object from the file store. For a virus it purges every bucket version (`purge: true`), so the file cannot come back from versioning. |

Outbox events added by the privacy centre (feature 7), handlers in `src/worker/handlers/privacy.ts`:

| Event | What it does |
| --- | --- |
| `privacy.export.requested` | Builds the customer's zip (JSON and PDF), seals it with the business's data key, stores it under `tenant/{id}/export/{id}`, saves the SHA-256 of a fresh one-time token in `data_exports`, and sends the link by email (template `privacy_export_ready`). A retry makes a new token and reuses the file. |
| `privacy.erasure.approved` | Runs the erasure (`src/server/privacy/erasure.ts`), then emails the customer a plain summary (`privacy_erasure_done`) to the address read before it was cleared. A send that needs a retry rolls the whole run back. Message delivery for these three events uses the `recipient` field on `OutgoingMessage`, so the adapter does not look the customer up. |
| `privacy.request.overdue` | Emails the business's own address once (`privacy_request_overdue`). |

The worker also needs `kalendr_scrub_audit_personal` and `kalendr_erase_consent_records`; both are worker-role only.

## Heartbeat and alerts

Every 30 seconds the worker:

- upserts its row in `worker_heartbeats`, which holds the worker id, mode, version, `last_seen_at` and `stopped_at`;
- logs one `worker heartbeat` line with the four counts from `kalendr_outbox_health()`.

The alerts in [OPERATIONS.md](OPERATIONS.md) read these. `/api/ready` belongs to the web app and does not check the worker. Logs carry ids, outcomes and counts only. They never carry a phone number, email, name, token, code or message body.

## Messages that were not sent

A person with `messages.retry` sees the **Not sent** panel on the Messages screen. Owners and admins have that permission. The panel lists `failed` rows (still retrying) and `dead_letter` rows (given up), and has a **Try again** button.

Try again calls `POST /api/staff/messages/:id/retry`, which needs an `Idempotency-Key` and the `attemptCount` the screen saw. It sets the row to `pending` with zero attempts, available now, and writes a `message.retry` audit row. A row that changed since the list loaded returns 409. Another business's row returns 404.

## Tests

| Command | What it checks |
| --- | --- |
| `pnpm test` | `src/worker/worker.test.ts`: the configuration guards, the handler map, the schedules, and the production sink against a fake adapter. |
| `scripts/verify-postgres18.sh` | Also runs `src/worker/outbox-worker.integration.test.ts` against a throwaway PostgreSQL 18 (details below). |

The integration test runs as the real worker role. It checks:

- two workers racing over 41 rows;
- the retry schedule and dead letter;
- lease expiry;
- shutdown;
- the moved-reminder drop;
- the retry API, including another business, a stale version, a replay and the audit row;
- the pg-boss schedules.

The record of the first run is [verification/2026-11-12-production-worker.md](verification/2026-11-12-production-worker.md).

## Email check code and guests (feature 40)

- **`email_check.code`**: written by `POST /api/public/email-check` (`action: "send"`). The handler (`src/worker/handlers/email-check.ts`) opens the sealed address and code, skips an expired or already-used check or a suppressed address, sends the `booking_code` email through the same provider the email adapter uses, then clears the sealed copy. It needs the email provider; without one the event goes to dead letter as `provider_not_configured`.
- **Guests**: the email adapter also sends each booking message (confirmation, request, approval, reminder, move, cancellation) to the guest addresses sealed on the booking, without the manage link. A guest address that bounced before is skipped; a temporary provider failure on a guest retries the whole message (the provider drops repeats by idempotency key).
- **`hold-expiry`** also deletes expired `slot_holds` rows (feature 39).


## Message workflows (feature 5)

Reminders, follow-ups and event messages are data, not code. Owners edit them under Settings → Reminders and follow-ups.

- **Tables.** `workflows` (trigger, offset, filters), `workflow_steps` (channel key, subject, body, wait), `scheduled_messages` (one row per booking, step and planned moment), `workflow_settings` (quiet hours, whether the standard set is on).
- **Planning.** `src/server/workflows/engine.ts` runs inside the booking transaction (one line in `recordMutation` and one in `createAppointmentTransaction`). It works out which messages the booking should have and brings `scheduled_messages` into line: timed rows that no longer fit are cancelled, new ones added, and a booking moved away and back revives its old rows. `slot_key` makes planning twice a no-op and stops a sent reminder going out again. The pure rules are in `triggers.ts`; quiet hours in `quiet-hours.ts`.
- **Channels.** Email steps write their own words. WhatsApp and text steps pick an approved message (`workflow_steps.template_key`: reminder, booking confirmed, moved, cancelled, review request; no review request on text), because those channels only send approved templates. The step goes to the channel's adapter under the event that maps to that template, and is skipped without consent, when the business has the channel off, or with no approved template. A channel shows as ready in the editor when its provider is set up in the environment.
- **Sending.** `workflow-sweep` (every minute) hands due rows to the outbox as `workflow.message`; `src/worker/handlers/workflow-message.ts` re-reads the booking, skips what no longer applies, holds anything inside quiet hours, renders, and sends through the same `MessageSink` and `ProviderAdapters` as every other message. Channel keys are plain strings (`email`, `whatsapp`, `sms`): a new channel is its adapter in `run.ts` plus one entry in `src/server/workflows/channels.ts`.
- **Re-planning.** Any edit clears `workflow_settings.reconciled_at`; `workflow-reconcile` then re-plans every upcoming booking once.
- **Standing down the fixed messages.** Once a business has `presets_applied_at` set, the old fixed 24-hour reminder and review request do nothing for it. New businesses get the standard set at registration; existing ones were backfilled by migration `0033`.
- **Test sends.** "Send me a test" queues `workflow.test`; the worker sends sample text to the signed-in staff member only, email for now.

## Video visits (feature 19)

How a visit is done is the "Where" choice of feature 36 (`service_location_options`, stored on the booking as `location_kind`). A booking whose way of meeting is `video` gets `appointments.delivery_mode = 'video'` (a call room); `we_call` and `they_call` are `phone`. Video options are hidden when the server has no video provider.

- **Room.** `planVideoRoom` (called from the workflow planner, inside the booking transaction) queues `video.room` with `available_at` 15 minutes before the start. The worker's `video-room` handler re-reads the booking, so a visit cancelled or moved first never gets a room; a booking that moves after its room exists gets the old room closed and a new one made. A cancelled booking queues `video.room.end`. Rooms expire 30 minutes after the end.
- **Provider.** `src/server/video/provider.ts` is the whole interface (make room, make token, close room). `daily.ts` calls Daily's REST API; `fake.ts` is local test mode, where the call screen shows only your own camera. `VIDEO_PROVIDER`, `DAILY_API_KEY`, `DAILY_DOMAIN`: see `.env.example`.
- **Joining.** The customer opens `/visit/[manage token]`; staff open `/visit/host/[appointment id]`. Everyone gets a meeting token made for them alone, valid from 15 minutes before the start to 30 minutes after the end (so the link is dead an hour after the visit). The customer's token is only issued after a staff member lets them in (the waiting room is ours, not Daily's). Making a token calls the provider inside the request: a deliberate exception to "no outside call in a request", because the person is waiting to join.
- **Check-in and presence.** Pressing "I'm ready" checks the booking in. Leaving never completes it. Call screens send a heartbeat every 20 seconds; someone is "here" for 45 seconds after the last one.
- **No recording.** No recording property is ever sent to Daily.
- **Headers.** `/visit` pages alone get Daily's frame and servers in the CSP and the camera and microphone in the Permissions-Policy (`src/lib/security-headers.ts`, `src/proxy.ts`, `next.config.ts`).

## Customer codes and notices (feature 8)

A customer's sign-in code, the one-time code for a manage link (step-up) and the "your contact details changed" notice belong to no business, so they do not go through the outbox. The app seals the destination and code (`src/server/messaging/patient-delivery.ts`, purpose `patient_delivery`, the row id is the only binding) into `patient_code_deliveries` through `kalendr_queue_code_delivery`. The table has forced row-level security with no policy, so neither the app nor the worker role can read or write it directly.

- **Pickup.** The worker's main loop (not pg-boss, whose schedule is one minute at best and a code lives ten) calls `kalendr_claim_code_deliveries` next to `runOutboxBatch`: a row whose worker stopped for a minute is claimed again, finished rows are removed after a day, and a row past its expiry is ended unsent. `kalendr_claim_code_deliveries` and `kalendr_finish_code_delivery` are revoked from the app role in `scripts/migrate.mjs`, `e2e-database.mjs`, `verify-postgres18.sh` (and `local-db.sh` grants the app role only the queue and expiry-check functions).
- **Order.** WhatsApp (the `sign_in_code` authentication template, with the code in the body and again in a copy-code button), then SMS (`sign_in_code` DLT template), then email. A phone number is never emailed: only the contact the customer gave, or the phone and email on the booking for a step-up code. "Send it as a text message instead" on the sign-in screen skips WhatsApp.
- **After sending.** The first channel that accepts the message wins and the sealed copy is cleared. A transient failure retries (10, 20, 30 seconds, four tries); a rejection moves to the next channel; nothing configured is `provider_not_configured`. In local capture with no provider at all, the code is printed to the worker console (never the contact).
- **Known limit.** Only a provider's immediate answer drives the fallback. If WhatsApp accepts a message and later reports it undelivered, there is no automatic text message: the customer uses "Send it as a text message instead".
- **Templates.** The WhatsApp authentication template is created at Meta with a copy-code button (`otp_type: COPY_CODE`); the send payload is documented at developers.facebook.com (copy-code button authentication templates): a `body` parameter with the code and a `button` component, `sub_type: url`, `index: "0"`, with the code again. `TemplateContent.copyCode` produces it. `contact_changed` has WhatsApp and SMS rows (pending) and an email.

## Smart waitlist (feature 21)

The first offer for a freed time is written inside the transaction that frees it (cancel, move away, closed time removed), together with its hold in `slot_holds` (purpose `waitlist`) and an outbox row, so the time is never on the public page between the cancel and the offer. The worker then only has to send and to move on:

- **`waitlist-match`** (aggregate `slot_offer`). Re-checks the offer is still waiting, that quiet hours are not on and that the time is not now under two hours away, then sends the message and marks the offer `sent`. If the hold is still live it is only extended (nothing is locked while the provider is called); only a hold that has lapsed makes it lock the person and ask the booking engine again, and a time that is no longer free ends the offer. The answer clock starts when the message goes out: 15 minutes, 5 when the time is under 3 hours away. The message goes by WhatsApp (the `waitlist_offer` template; consent needed) or email; the waitlist offer has no text-message template, so a customer who prefers text gets email. The link comes from a sealed copy of the token (purpose `waitlist_offer`), cleared once sent; it is never put in the outbox payload, an audit row or a log. A message that cannot be delivered (a bounced address, a missing number) ends that offer as `withdrawn` (reason `undeliverable`) and asks the next person.
- **`offer-expire`**. Due at the answer time. Ends the offer, puts the person back on the waitlist, and asks the next person with the same hold row in the same transaction, so nothing sits between two people. After three people, or when the time is under two hours away, the hold is removed and the time is public again.
- **Quiet hours.** An offer made at night is created `scheduled`, with its hold live and the outbox row due at opening time (the business's workflow quiet hours, in the location's time zone). Nothing is sent at night. The answer time and the 2-hour rule are worked out from opening time, and a cascade step that lands at night waits the same way.
- **Hold length.** The hold lasts `HOLD_GRACE_MS` (3 minutes) past the answer time, so the worker always moves the time on before the hold lapses. If the worker is down for longer than that, the hold lapses and the time goes public: that is the failure mode, by design, rather than a time held forever.
- **Runs in both processes.** `src/server/waitlist-offers.ts` is written against `Runner` (like the workflow engine) and imports nothing marked `server-only`, so the web server's drizzle transaction and the worker's postgres.js transaction run the same code. The slot engine's `assertSlotOfferable` is used through a small shim that only needs `execute`.


## Repeating appointments (feature 17)

- **`series.confirmation`** (aggregate `appointment`, the first visit). One message for a whole series: `booked`, `changed` (staff moved "this and following") or `cancelled`. It reads the visits as they are when it runs, lists every date in the place's time zone, and goes by WhatsApp (the `series_confirmed` template, seeded as pending; consent needed) or email. A text message has no template for it, so a customer who prefers text gets email, and a cancellation is email only. It carries the private link to the first visit so the customer can change or cancel that one. A message that cannot be delivered is recorded as a failure like any other.
- **No per-visit message.** The appointment message handler drops `appointment.created` for a visit that belongs to a series, and drops the cancels a series change writes (marked `seriesBatch`); the workflow planner does not fire the `booked` trigger for a series visit. Both still queue the calendar write, so each visit reaches the connected calendar.
- **Reminders.** Each visit keeps its own reminders (`reminder_status` is `queued`; `before_start` workflows plan per visit), so the reminder sweep and feature 5's workflows work as for any booking.

## Subscription billing (feature 14)

Outbox events: `billing.event` (a stored provider webhook, applied by `src/server/billing/worker-apply.ts`), `billing.email` (payment failed, plan started, trial ending, usage alert; sent to the owner through the sink, deduped by the outbox key), `billing.provider_change` (downgrade scheduled, cancel at period end, resume; calls the provider). Timed job `billing-sweep` every 5 minutes (`kalendr_billing_tenants()` then each business in its own scope): ends trials, moves `past_due` beyond 7 days to Free, applies pending downgrades and cancellations whose period ended, queues the 3-days-before-trial-end email. Every message passes `planGatedSink` first (plan checks and the never-silently-stopped rule) and `providerSink` meters it on send. Failure codes: `plan_channel_locked`, `plan_overage_stopped` (dead, not retried). See `docs/subscription-billing.md`.
Outbox events added by features 41 to 43 (all handled by the appointment change handler and `src/worker/policy.ts`; email templates in `src/emails/`):

| Event | Notice |
| --- | --- |
| `appointment.status.declined` | `request_declined`: the reason label and the business's message (the message is in the outbox payload only). |
| `appointment.status.expired` | `request_expired`. |
| `appointment.reschedule_requested` | `reschedule_requested`, with the manage link opening on the time picker. |
| `appointment.reassigned`, `appointment.location_changed` | `visit_changed` (headline and summary). |

## Webhooks out (feature 34)

`appointment.*`, `customer.created` and `payment.captured` outbox rows fan out (`src/worker/webhooks/fanout.ts`, wrapped around the change handler like the calendar write) into one `webhook_deliveries` row and one `webhook.deliver:<id>:<n>` outbox row per active, subscribed endpoint, in the same transaction and idempotent per endpoint and event id. The handler (`webhook-deliver.ts`) catches every network error, records the attempt (status code, duration, fixed error code) and returns `delivered` for its own row; a failure queues the next attempt as a new row at +1m, 5m, 20m, 1h, 3h, 6h, 12h (8 attempts, about 22 hours), then the delivery is `gave_up`. After 12 consecutive failed attempts the endpoint is turned off (`repeated_failure`) and `webhook.endpoint.disabled` emails the owner, naming only the host. The transport and policy are injectable through `HandlerDependencies.webhooks`. `payment.captured` is defined and delivered, but the payments lane must call `queuePaymentCaptured` (`src/server/webhooks/events.ts`) where a payment is captured.

## Data import (feature 12)

Three outbox events: `import.check` (500 rows per event), `import.commit` and `import.undo` (200 rows per event). Each handler works in a savepoint per row inside the tenant transaction the outbox gives it, rereads the job and rows by their current status, recomputes totals from `import_rows`, and queues the next chunk (dedupe key `import.commit:<jobId>:<batch>`). A thrown error rolls the chunk back and retries; on the last attempt the job is `failed` (an undo returns to `done`). The appointment kind books through `createStaffAppointment` on a small pool of its own (`runWithDatabase` in `src/db/client.ts`), with a per-row idempotency key `import:<jobId>:<row>`; imported bookings carry `notifyCustomer: false` unless the owner asked for confirmations, and the worker now honours that flag (`isQuiet` in `policy.ts`). The timed job `import-file-purge` (hourly, minute 40) removes stored files once the undo window closes, a job failed or was undone, or an upload sat unfinished for two days.

## Online payments (feature 23)

Event types: `payment.event` (one stored webhook; the worker checks it against the order, writes the ledger row and confirms the booking), `refund.process` (sends one refund to the provider, with the request's id as the idempotency key, and writes the ledger refund when it is paid out) and `payment.reconcile` (compares yesterday's provider payments with the ledger). Timed jobs: `payment-hold-expiry` (every minute: unpaid holds released, booking `expired`), `payment-refund-sweep` (every 10 minutes: refunds still waiting are queued again) and `payment-reconcile` (21:00 UTC: queues one `payment.reconcile` per business). They find businesses through `kalendr_payment_tenants(job)`, a SECURITY DEFINER function that returns ids only and is revoked from the web role. Provider calls happen only in handlers. See [online-payments.md](online-payments.md).

## Staff notifications (feature 56)

Outbox events `staff.email` (one alert as an email to the person's own sign-in address) and `staff.digest` (one person's morning summary), next to the existing `push.send`. Push and email rows are queued with `available_at` at the end of the person's quiet hours. Timed job `staff-digest` (every 15 minutes) finds businesses through `kalendr_staff_digest_tenants()` (ids only, not callable by the web role), then queues one `staff.digest` per person whose chosen time has come and whose day has not been sent (`memberships.digest_sent_on`, outbox key `staff.digest:<membership>:<day>`). A day with nothing to say sends nothing. See [staff-notifications.md](staff-notifications.md).

Owner summary (Cal.com parity wave, lane C): outbox event `staff.summary`, queued by the hourly timed job `owner-summary` (`src/worker/owner-summary-jobs.ts`). It finds businesses through `kalendr_owner_summary_tenants()` (ids only, not callable by the web role), then for each active owner whose choice is weekly (the default for an owner who never chose) or monthly, and only on the first three days of the week (Monday to Wednesday) or month, counts the period just ended and the one before (bookings, cancellations, no-shows, new customers, revenue minus refunds; test rows never count) and queues one row per owner. The period's first day is stamped in `memberships.summary_sent_for`, and the outbox key `staff.summary:<membership>:<first day>` repeats the guard. "Off" is never listed. The handler (`ownerSummaryHandler`) words the numbers with the business's currency and sends template `staff.summary` to the owner's own sign-in address; in capture mode it lands in the capture server like every other email. The row holds counts only.
## Own web address (feature 13)

Outbox events: `domain.check` ("Check now": one lookup for one address) and `domain.notice` (owner email: records missing, address switched off, address could not be connected; deduped by kind, address and the day the records first went missing). Timed job `domain-sweep` every 5 minutes: `kalendr_domain_tenants()` returns businesses with a pending address not checked for 5 minutes (one past its 72 hours is looked at once more and marked `failed`) or a live address not checked for a day; each lookup runs with no transaction open and a 4-second limit, then the result is applied in the business's scope (`applyDomainCheck`). A failed lookup only records that a check ran. The resolver is injectable (`DnsResolver`), so tests use a fake. Needs `KALENDR_CNAME_TARGET`; without it the job and handler do nothing. See [branding-and-address.md](branding-and-address.md).

## Onboarding emails (feature 11)

Outbox event `onboarding.email` (kind `onboarding_welcome`, `onboarding_day1` or `onboarding_day3`; sent to the owner through the sink as `owner.<kind>`, deduped by the fixed outbox key `onboarding.email:<kind>`). The welcome is queued at registration. Timed job `onboarding-sweep` every 15 minutes: `kalendr_onboarding_tenants()` returns businesses that registered through the guided flow in the last 15 days; for each, `loadChecklist` (shared with the web server through a `Runner`) decides which of day 1 and day 3 are due. The handler checks the goal again before sending, so an owner who finishes in between is not emailed. The day-11 trial email is the billing sweep's. See [onboarding.md](onboarding.md).

## Classes (feature 18)

- **`class.notice`** (aggregate `class_enrolment`). One email about one place in a class: `enrolled`, `waitlisted`, `offer`, `session_cancelled` or `broadcast` (a line the business wrote). It says only what is still true when it runs (an offer already taken or lapsed, or a place already cancelled, sends nothing). The link comes from the sealed copy of the place's token (purpose `class_seat`) and is written nowhere else. Email only: there is no approved WhatsApp or text template for class wording.
- **`class.offer_expire`**. Due at the end of an offered seat's answer time. If the offer is still open it passes the person over and offers the seat to the next person waiting, in one transaction under the session's row lock.

## Invoices, packages and memberships (features 24 and 25)

Event types: `invoice.render` (renders an invoice or credit note PDF with `@react-pdf/renderer`, seals it with the business's data key and stores it; queued in the issuing transaction, safe to run twice) and `package.expiry_reminder` (the 14-day and 3-day "credits left" message). Membership renewals, failures and endings arrive as `payment.event` rows (`subscription.renewed`, `subscription.payment_failed`, `subscription.ended`) and are applied by `src/server/offers/memberships-core.ts`. Timed jobs: `package-credit-sweep` (02:30 UTC: expired credits written off, reminders queued) and `membership-grace-sweep` (hourly: memberships past 7 days of grace are paused). Both find businesses through `kalendr_offers_tenants(job)`, a SECURITY DEFINER function that returns ids only and is revoked from the web role. The hold-expiry job also releases a coupon taken for a booking that was never paid.

## Booking assistant (feature 30)

`assistant.inbound` (queued by the `channel.inbound` handler for a free-text WhatsApp message when the business has the assistant on) runs one assistant turn on its own database pool (`withWorkerDatabase`, like the appointment import) and queues the reply as a normal `thread.reply`. A chat another message is still being answered on is retried. The nightly `retention` job also deletes assistant chats older than the owner's retention days.
## Company email domains (feature 53)

`email-domain-sweep` (every 5 minutes, `src/worker/email-domain-jobs.ts`) looks up `_kalendr-verify.<domain>` TXT records for domains added in the last 7 days and not yet proved. A failed lookup is "try again", never "no". A domain already proved by another business is refused by a unique index and the owner is told in words. Lookups use the same injected resolver as own web addresses, so tests never touch real DNS.
## Customer profiles and campaigns (features 27 and 28)

- **`customer-merge-purge`** (daily, 03:40 UTC). Drops the sealed details of a merge once its 30 days to undo it have passed. Finds businesses through `kalendr_crm_tenants('merge_purge')` (ids only, not callable by the web role).
- **`campaign-tick`** (every minute). For each business with something running (`kalendr_campaign_tenants('campaign_tick')`, ids only): queues `campaign.fanout` for campaigns that are due (key `campaign.fanout:<id>:<day>` or `:once`), hands due messages to the outbox as `campaign.send` (key `campaign.send:<send id>`, at most 200 a minute, held through quiet hours), credits bookings made from a message, pauses a campaign whose failure or unsubscribe rate went past its limit and finishes a one-off campaign that has gone out.
- **`campaign.fanout`** writes the audience as `campaign_sends` rows; running it twice adds nothing. **`campaign.send`** re-checks one customer and sends one message (email through the `campaign:email` template with the List-Unsubscribe headers; WhatsApp and text through `campaign.message`, carrying an approved template key and one line). **`campaign.test`** sends the owner a test, to their sign-in address or a sealed phone number.
- A WhatsApp STOP now also withdraws marketing consent and marks the channel opted out; it clears reminder consent only when it was not a reply to a marketing message. See [campaigns.md](campaigns.md).
