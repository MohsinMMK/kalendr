# AI booking assistant (feature 30)

A chat that answers customers day and night, shows real free times, and books, moves or cancels **only after the customer confirms**. It runs on the website booking page and on WhatsApp. Staff get a copilot that finds gaps and drafts replies and never acts on its own.

## What it can do, and what it cannot

| Tool | Does | Needs |
| --- | --- | --- |
| `list_services`, `list_staff`, `get_business_info` | What the booking page already shows a visitor | Nothing |
| `find_times` | Real free times from the same availability engine as the booking page | Nothing |
| `hold_and_book` | **Proposes** a booking: checks the time against live availability, holds the time for five minutes (`HOLD_MINUTES`), stores the proposal for 15 (`PROPOSAL_MINUTES`) | Name and phone (web), already known (WhatsApp) |
| `request_verification_code` | Texts a one-time code to a phone this business knows | Web chat only |
| `find_my_bookings`, `reschedule`, `cancel` | The verified customer's own future bookings; the last two **propose** | A verified phone; the booking id must have been shown in this chat |
| `hand_to_person` | Passes the chat to staff | Nothing |

No tool takes a business or tenant id: the server binds it. No tool commits a change. The model has no way to book.

## How a change really happens

1. The model proposes (`hold_and_book`, `reschedule`, `cancel`). The proposal is stored sealed on the conversation with a random id and expires after **15 minutes** (`PROPOSAL_MINUTES`). A booking proposal also holds the time for five minutes (`HOLD_MINUTES`); a confirm after the hold ran out re-checks the time and books it only if it is still free.
2. The customer confirms with their own act: the **Confirm button** the widget draws (it carries the proposal id), or a bare "yes" typed **immediately after** the proposal (WhatsApp and the website). A longer message such as "yes but at 5" is a new request.
3. The server makes the change in code, through the booking engine: `createAppointment` for new bookings (with source `assistant`, set by the server and not readable from any request), `manageAssistantAppointment` for moves and cancels (the same rules as the manage link: cancel windows, the waitlist, messages). Booking limits, the contact rate limit, plan limits and the audit trail all apply.
4. The model is then told what happened in a `[SERVER NOTE]`, and writes the reply. The customer cannot type that marker: square and angle brackets are neutralised in everything they write.
5. A final check replaces any reply that claims "you're booked" when nothing was committed this turn (on the website too, before any of the model's words are sent: see below).

## Safety, in code

- **Emergency** phrasing ("chest pain", "can't breathe", self-harm…) and **advice-seeking** ("what should I take for…", "is it safe to…", "do I have…") get a fixed reply and a handoff **before any model runs**. An emergency is checked even before the monthly cap, the no-model fallback and the rate limits, so it always reaches a person. Bare symptom words do not trigger it, so "book me in for a toothache" still books. Lists live in `src/server/assistant/guardrails.ts` with tests.
- It asks for a person, sounds upset (stronger with the "Early" rule), repeats itself three times, or fails twice: handoff. The chat then stays with staff until they hand it back.
- It says it is automated on the first reply of every chat (added in code, not left to the prompt).
- **Prompt injection**: customer text is data. The system prompt is fixed per business (rules, words, the owner's facts in a marked block). The owner's text cannot close its block. Tools validate every input with zod and refuse extra fields. The model cannot see ids it was not given: moves and cancels accept only booking ids that `find_my_bookings` showed in this chat.
- **Phone proof** on the website uses the same one-time code as the customer portal. The six digits go in their own box and never into the chat or the model. WhatsApp chats are tied to the customer record of the thread they arrive on.
- **Limits**: 40 messages per 10 minutes per address, 12 per minute per chat, 60 per hour per customer, 1200 per hour per business, 40 turns per chat, 6 tool calls and 8 model calls per turn, and a monthly token cap (`ASSISTANT_MONTHLY_TOKEN_CAP`) checked before every model call. Past a limit, or with no model, the customer gets the booking link.
- Nothing logs a phone, name, message or token. Audit rows hold ids, tool names and switches, never the owner's words or a customer's text.

## Where things live

| What | Where |
| --- | --- |
| Tables (migration `0070_ai_assistant`) | `assistant_settings`, `assistant_conversations`, `assistant_messages`, `assistant_usage`; forced row-level security; messages, proposals, summaries and the code's phone number sealed with the business's key |
| Engine | `src/server/assistant/`: `loop.ts` (a turn), `tools.ts`, `actions.ts` (propose and commit), `guardrails.ts`, `prompt.ts`, `model.ts` (the one door to the model, see below), `ai-tools.ts` and `turn-messages.ts` (this app's tools and saved blocks, to and from the AI SDK), `scripted-model.ts` (tests), `local-model.ts` (fake mode), `stored-format.ts`, `usage.ts`, `store.ts`, `verify.ts`, `web.ts`, `settings.ts`, `handoffs.ts`, `copilot.ts` |
| Website chat | `GET/POST /api/public/assistant` (`POST` streams), `src/features/booking/assistant-chat.tsx` (mounted on `/book/[business]`), the wire types in `src/lib/assistant-ui.ts` |
| WhatsApp | The webhook only stores the message. The inbound worker handler queues `assistant.inbound`, so the model call runs in the worker (`src/worker/handlers/assistant-inbound.ts`, with `generateText`), and the reply goes out as a normal thread reply inside the 24-hour window |
| Staff | Settings → AI assistant (switches, tone, handoff rule, business facts, retention, usage), chats waiting for a person (read, hand back, close), copilot button in the header |
| Staff routes | `/api/staff/assistant` (`POST` streams a copilot answer, `PUT` confirms a suggestion), `/api/staff/assistant/settings`, `/api/staff/assistant/handoffs`. Writes call `assertNotReadOnlyImpersonation`; the copilot and the switches need the `assistant` plan feature |

## The website chat and WhatsApp

One turn (`loop.ts`) serves both, in this order, all in code: repeat check (`sourceKey`), the chat's lease, a chat already with staff, the plan, the channel switch, no model, the monthly cap, the 40-turn limit (each of those ends in the booking link), the per-customer and per-business rate limits, the fixed guardrail replies, the customer's confirm (a tapped button or a typed yes right after the proposal, which makes the change in code), then the model, then settling the turn. Only the model step uses the AI SDK (`ai` 7, `@ai-sdk/anthropic`):

- **Website: `streamText`.** `POST /api/public/assistant` takes exactly `{ business, token?, text | confirmProposalId | code }` (`assistantChatRequestSchema`, one of the three). Anything that refuses the message (the address or chat limit, an unknown business, a chat still answering, a repeated message) answers with the ordinary JSON error before streaming starts. **Every reply after that streams** as AI SDK UI message chunks, so the page has one thing to read: a model reply arrives as one checked part once the turn is settled (below), and a fixed reply (an emergency, a medicine question, a held chat, the booking link) or the answer to a Confirm is a one-part stream of the same shape. The response is not cached, and it keeps being read if the visitor closes the page, so the turn is always settled, saved and its lease let go (the model call is not tied to the request).
- **What the page receives** (`src/lib/assistant-ui.ts`): the words; a transient `data-conversation` part sent first (the chat's token on the first reply, so a page closed mid-answer still has it) and again once the turn is settled (status with a person, waiting for a code, phone verified: tools change these mid-turn); a `data-proposal` part with the change to confirm (`{ id, kind, summary, expiresAt }`; the Confirm button is drawn from it and only the customer's tap commits); a `data-fallback` part with the booking link when the assistant could only give the link; and a `data-replace` part (below). **Tool steps never reach the page**: no tool inputs or results, no step markers, no provider error text. The page does not send its history; the server keeps the chat.
- **The model's words are sent only after the final check.** Until a turn is settled nobody knows which words are the reply: words beside a tool call ("Let me check") are dropped, because the chat keeps one reply per turn; `screenReply` removes tags, replaces a false "you're booked" while a change waits for Confirm, and cuts a long reply; a handoff, a failed or cut-off call, the step cap or the monthly cap replace the model's words entirely. Streamed word by word, any of these would be on screen for a moment, which a booking chat for clinics cannot allow. So the server reads the model's stream without forwarding its words (`loop.ts`, `stream`), settles and saves the turn, and then sends **exactly the saved reply** as one text part, just before the proposal and the chat's state. The page shows the typing indicator for the whole answer. The first line of a chat's first answer ("I'm the automated assistant") is fixed text and goes out at once as its own part. `data-replace { text }` remains only as a last line of defence, should what the page holds ever differ from the saved reply; it is not expected to fire. `web-stream.test.ts` checks, for each of the cases above, that every word sent is the saved reply and that no replacement was needed.
- **WhatsApp: `generateText`.** The worker has no stream to write to and sends the whole reply at once. It builds the same tools, instructions and limits, with one number for the whole call (`timeout: 90_000`; `generateText` has no per-chunk timer). It adds, in code, the line the customer must see before saying yes (the change, "reply yes", the privacy notice).
- **Limits of a turn.** At most 8 model calls, 6 tool calls (a seventh is answered with a plain error and never run), and 60 seconds: after that no new model call starts, and the customer gets the booking link. Stop conditions are the AI SDK's `stopWhen`: the step count, the model handing the chat to a person, the time budget, and the monthly cap between steps. A turn that ends in a tool call with no words, comes back empty, is cut off (`length`) or refused (`content-filter`) counts as a failed turn: the booking link, and a handoff on the second failure (the first with the "Early" rule). Tool calls in one step run one at a time, in the order the model made them, because they share the turn's one waiting proposal, handoff and call count.
- **Saved format.** The website and WhatsApp keep the chat as plain model blocks (format 1: text, tool calls and their results), so an old chat, the handoff view and the privacy export read every message the same way; `turn-messages.ts` turns them into the AI SDK's messages for each turn and back. Earlier turns' tool results are replayed, so a later turn can use a time found earlier. Words written beside a tool call are not saved (see above). A tool call the SDK refused (a tool that does not exist, input that does not fit) is shown to the model within that turn, as the SDK's own error text and without counting against the six-call cap, but not saved. Only the copilot uses the UI-message format (format 2).
- **Usage** is recorded per step (billable tokens: input + output + cache write + cache read ÷ 10), so a turn that fails half way still counts what it used.
- **The page** (`assistant-chat.tsx`) is `useChat` over the coss Chat and Composer in the same drawer: the token in `sessionStorage`, a Confirm alert, the code box (the six digits are sent as a hidden message that the page never shows and the chat never keeps), the booking-link alert and a status region that reads the finished answer once. The conversation log is not a live region.

## The copilot

The copilot streams its answer through the AI SDK (`ai` 7, `@ai-sdk/anthropic`), and the panel (`src/features/clinic/assistant/copilot-panel.tsx`) is `useChat` over the coss Chat and Composer components.

- **Request.** `POST /api/staff/assistant` takes only the new question (`{ conversationId?, trigger, message: { id, text } }`, `copilotRequestSchema`); the server reads the history from the saved chat and rebuilds the model's messages, so a page can never put words in the model's mouth. Sign-in, the plan, the rate limit, a full chat (60 turns), the monthly allowance and "no model" still answer with the ordinary JSON error before any streaming starts; after that the answer streams as AI SDK UI message chunks (`copilotStream`).
- **What the page receives.** Text, short tool steps (`tool-<name>` parts), a transient `data-conversation` part with the chat's id, and a `data-proposal` part (`{ id, kind, summary, expiresAt }`) when the copilot suggests a booking. The types are shared in `src/lib/copilot-ui.ts`. A failure after streaming has started is a plain error chunk; the provider's text never reaches the page.
- **The model never books.** `propose_booking` stores the proposal (a sealed pending record, 30 minutes) and the page draws the Confirm button from `data-proposal`. Only the staff member's own press runs `PUT` (`copilotConfirm`, idempotency key `copilot:<proposal id>`). The AI SDK's tool approval is not used for this: a stored proposal commits server-side with its own expiry and key, not from history the page sent.
- **Saved format.** Each saved message is one row in `assistant_messages.content_ciphertext`. Chats from before the move hold a JSON array of model blocks (format 1); the copilot now saves `{ "format": 2, "message": <UI message> }`. The shape tells them apart, there is no migration, and both can sit in one chat. `loadHistory`/`visibleLines`/the privacy export read both as words; `loadUiHistory` gives the copilot the format-2 messages whole and older ones as words. Only a finished answer is saved; after a failure or a Stop only the question is, so Try again retries the same question without saving it twice.
- **Model access.** `model.ts` is the one door: the Anthropic provider in live mode, a wrapped rule-based model (`local-model.ts`) in fake mode, none when off. The stable rules carry the cache breakpoint and today's date follows (`instructions()`), effort is low, one retry, a time limit on the call and on each silence. Usage is recorded per step (billable tokens: input + output + cache write + cache read ÷ 10), so a stopped answer still counts. Errors are reduced to `LlmUnavailableError` reasons and never quote the provider. `ai-tools.ts` wraps this app's `ToolResult` tools as AI SDK tools; the website chat and WhatsApp use the same two files. Tests install a scripted model (`scripted-model.ts`, `setAssistantModelForTests`) that `wrapClient` presents to the AI SDK as a language model.
- **Caps.** A turn is at most 8 model calls and 8 tool calls.

Tools are limited to the signed-in person's permissions: schedule read (services, people, times), `appointments.book` (customer search, customers who have not come back, propose a booking), `inbox.reply` (unread threads, read a thread to draft a reply). A suggested booking is a proposal with a Confirm button; confirming runs `createStaffAppointment` with that person's permission. Every tool call and every confirmation is in the audit trail with the conversation id and `confirmed: true|false`.

## Privacy

Chats are stored sealed, kept for the number of days the owner chose (default 90; the nightly retention job removes older ones), included in a customer's data export when the chat was tied to their number, and deleted when they are erased. A website visitor with no number on file cannot be found for an export or an erasure, which is why those chats are kept only for the retention period.

## Configuration

| Variable | Meaning |
| --- | --- |
| `ANTHROPIC_API_KEY` | Without it the assistant is off and visitors get the booking link. **Needs the owner's account.** |
| `ASSISTANT_MODEL` | Customer chat model. Default `claude-haiku-5-5`. |
| `ASSISTANT_STAFF_MODEL` | Copilot model. Default `claude-sonnet-5-5`. |
| `ASSISTANT_MONTHLY_TOKEN_CAP` | Tokens per business per month. Default 3,000,000. |
| `ASSISTANT_PROVIDER_MODE=fake` | A rule-based local model with no network, for development and browser tests. Refused at startup unless `BETTER_AUTH_URL` is on this machine. |

The system prompt is built to be cached: the rules, the business's words and the owner's facts come first and are marked as the cache breakpoint; today's date follows it. The cached part must reach the model's minimum cacheable size to take effect, and `assistant_usage` records cache reads and writes so the saving can be checked.

## Known limits

- **Text messages (SMS) are not connected.** Both SMS adapters return no inbound events and the inbox shows only WhatsApp threads. The switch is disabled in Settings and the server refuses to turn it on.
- WhatsApp chats start only for customers who already have a thread (the business wrote to them first or they replied to a template). A message from an unknown number is not routed to any business by the existing intake, so the assistant never sees it.
- Website replies are not shown word by word: the reply arrives whole once it is checked and saved (the typing indicator shows until then), so nothing the final check changes is ever on screen. WhatsApp replies arrive whole too.
- Only English-speaking safety lists are complete; Hindi phrases are partial. The model replies in the customer's language, but the fixed replies (emergency, advice, handoff, confirmation notes) are English.
- A service that takes online payment, an emailed code or an email-only contact is not bookable in chat: the assistant gives the booking link.
- If the worker stops after storing a customer's message and before queueing the reply, the retry sees the message as already handled and sends nothing.
- Real-model behaviour (the hand-run conversations the spec lists) has not been run: there was no API key. The conversation tests use a scripted model that replays tool calls, including ones that misbehave.
