import "server-only";

import { generateText, isStepCount, streamText, type StepResult, type ToolSet, type UIMessageChunk } from "ai";
import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { canUse } from "@/lib/entitlements";
import type { AssistantProposal } from "@/lib/assistant-contracts";
import { profileWords } from "@/lib/terminology";

import { ApiError } from "../api-error";
import { appOrigin } from "../env";
import { loadEntitlements } from "../entitlements";
import { logger } from "../logger";
import { hitRateLimit } from "../rate-limit";
import { notifyStaff } from "../staff-notifications";
import { catalogFor, commitPending } from "./actions";
import { freshTurnState, type ChannelCustomer, type HandoffReason, type ToolContext, type TurnState } from "./context";
import {
  adviceReply, asksForPerson, capReply, disclosureLine, emergencyReply, FAILURES_BEFORE_HANDOFF, handoffReply, isAdviceSeeking, isAffirmative, isEmergency,
  isNegative, isRepeating, MAX_MODEL_CALLS_PER_TURN, MAX_TURNS_PER_CONVERSATION, sanitizeCustomerText, screenReply, soundsUpset,
} from "./guardrails";
import { instructions, logModelError, modelCallSettings, usageOf, type AssistantLanguageModel, type LlmBlock } from "./model";
import { buildStableSystem, buildVolatileSystem, serverNote } from "./prompt";
import { loadSettingsIn, type StoredAssistantSettings } from "./settings";
import {
  acquireLease, appendMessages, clearPending, getConversation, handOff, hasSourceKey, loadHistory, readPending, releaseLease, touchConversation,
  type Conversation, type NewMessage, type StoredMessage,
} from "./store";
import { assistantAiTools } from "./tools";
import { modelMessagesOf, toolMessagesOf } from "./turn-messages";
import { isOverCap, recordUsage } from "./usage";

/** After this long no new model call starts, so a slow turn ends in the booking link instead of running past its lease. */
const TURN_BUDGET_MS = 60_000;
/** The whole model call, steps and tools included, must end inside the conversation's lease (150 s). */
const TURN_TIMEOUT_MS = 90_000;

/**
 * One turn of the assistant (feature 30): the customer's message, or their tapped Confirm, in; the reply out.
 *
 * Order matters and is all in code. Emergencies and advice questions are answered by a fixed reply before any model runs. A confirm
 * is read from the customer's own message (a button the server drew, or a bare "yes" right after a proposal) and makes the change in
 * code; the model never can. The model then writes the reply, using tools that are validated and limited. The reply is checked once
 * more before it leaves, and a stopped or failing model never ends in silence: the customer gets the booking link.
 */

export interface TurnInput {
  tenantId: string;
  slug: string;
  conversationId: string;
  /** The model for this turn, or null when the assistant is off: the customer then gets the booking link. */
  model: AssistantLanguageModel | null;
  now: Date;
  /** What the customer typed, as received. */
  text?: string;
  /** The Confirm button's proposal id (web only; a tapped button is the customer's own act). */
  confirmProposalId?: string;
  /** The provider's id for this message, so a repeated webhook is a no-op. */
  sourceKey?: string;
  /** Used only by the verified-code path: the chat reports it as a note to the model. */
  note?: string;
}

export type TurnOutput =
  | { kind: "busy" }
  | { kind: "duplicate" }
  | {
    kind: "reply";
    reply: string;
    status: Conversation["status"];
    proposal: AssistantProposal | null;
    awaitingCode: boolean;
    verified: boolean;
    fallbackLink: string | null;
    handedOff: boolean;
    /** The chat was already with a person before this message: no reply should be sent, the staff are told instead. */
    held: boolean;
  };

interface Setup {
  conversation: Conversation;
  settings: StoredAssistantSettings;
  entitled: boolean;
  history: StoredMessage[];
  channelCustomer: ChannelCustomer | null;
}

async function loadSetup(tenantId: string, conversationId: string): Promise<Setup | null> {
  return withTenant(tenantId, async (transaction) => {
    const conversation = await getConversation(transaction, tenantId, conversationId);
    if (!conversation) return null;
    const settings = await loadSettingsIn(transaction, tenantId);
    const { entitlements } = await loadEntitlements(tenantId, transaction);
    const history = await loadHistory(transaction, tenantId, conversationId);
    let channelCustomer: ChannelCustomer | null = null;
    if (conversation.patientId && (conversation.channel === "whatsapp" || conversation.channel === "sms")) {
      const rows = await transaction.execute<{ id: string; first_name: string; last_name: string; phone: string; email: string }>(sql`
        select id, first_name, last_name, phone, email from patients where tenant_id = ${tenantId} and id = ${conversation.patientId}
      `);
      const row = rows[0];
      if (row) channelCustomer = { id: row.id, firstName: row.first_name, lastName: row.last_name, phone: row.phone, email: row.email };
    }
    return { conversation, settings, entitled: canUse(entitlements, "assistant"), history, channelCustomer };
  });
}

function channelEnabled(settings: StoredAssistantSettings, channel: Conversation["channel"]): boolean {
  if (channel === "web") return settings.enabledWeb;
  if (channel === "whatsapp") return settings.enabledWhatsapp;
  if (channel === "sms") return settings.enabledSms;
  return false;
}

function textOf(blocks: readonly LlmBlock[]): string {
  return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
}

function reasonReply(reason: HandoffReason, phone: string | null, channel: Conversation["channel"]): string {
  if (reason === "emergency") return emergencyReply(phone);
  if (reason === "advice") return adviceReply(phone);
  return channel === "web"
    ? `${handoffReply} If you'd like them to call you back, type your phone number here.`
    : handoffReply;
}

/** Marks the chat as waiting for a person and tells the staff who may reply. The customer's words stay sealed; the alert holds none. */
async function performHandoff(transaction: KalendrTransaction, context: ToolContext, state: NonNullable<TurnState["handoff"]>): Promise<void> {
  await handOff(transaction, context.tenantId, context.conversation.id, state.reason, state.summary);
  await notifyStaff(transaction, context.tenantId, {
    kind: "needs_person", dedupeKey: `assistant-handoff:${context.conversation.id}`,
    link: context.channel === "web" ? "/settings" : "/messages",
  });
  await transaction.execute(sql`
    insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
    values (${context.tenantId}, 'assistant', 'assistant.handoff', 'success', ${JSON.stringify({ conversationId: context.conversation.id, reason: state.reason, channel: context.channel })}::jsonb)
  `);
}

function proposalOf(state: TurnState): AssistantProposal | null {
  const proposal = state.proposal;
  if (!proposal || proposal.kind === "staff_book") return null;
  return { id: proposal.id, kind: proposal.kind, summary: proposal.summary, expiresAt: proposal.expiresAt.toISOString() };
}

type ReplyOutput = Extract<TurnOutput, { kind: "reply" }>;

/**
 * What a turn needs from the model, once everything before it has been decided. `stream` and `generate` each run the model, settle the
 * turn (save it, count it, hand off if needed) and let go of the chat's lease, whichever way they end.
 */
export interface ModelTurn {
  /**
   * Answers the website chat as a stream. The first reply's disclosure goes out at once; the model's words go out only once the turn
   * is settled and saved, as exactly the saved reply, so nothing the checks would drop is ever on the page (a `data-replace` part is
   * the last line of defence should the two still differ). The caller adds the proposal, the booking link and the chat's state.
   */
  stream(write: (chunk: UIMessageChunk) => void): Promise<ReplyOutput>;
  /** Runs the model without streaming, for WhatsApp, where the whole reply is sent at once. */
  generate(): Promise<ReplyOutput>;
}

export type TurnStart =
  | { kind: "busy" }
  | { kind: "duplicate" }
  /** Answered without the model (a fixed reply, a held chat, the booking link). The lease is already let go. */
  | { kind: "reply"; output: ReplyOutput }
  | { kind: "model"; turn: ModelTurn };

/**
 * Opens a turn: the repeat check and the chat's lease happen here, so "busy" and "duplicate" are known before anything streams. When
 * the model is needed the result is a `ModelTurn` that holds the lease until it has run.
 */
export async function startTurn(input: TurnInput): Promise<TurnStart> {
  const { tenantId } = input;
  const setup = await loadSetup(tenantId, input.conversationId);
  if (!setup) throw new ApiError(404, "conversation_not_found", "That chat could not be found.");
  const { conversation } = setup;
  const catalog = await catalogFor({ slug: input.slug });
  const bookingLink = `${appOrigin()}/book/${encodeURIComponent(input.slug)}`;
  const phone = catalog.clinic.phone || null;
  const base = { fallbackLink: null as string | null, awaitingCode: false, verified: conversation.verifiedPatientIds.length > 0 };

  if (input.sourceKey) {
    const seen = await withTenant(tenantId, (transaction) => hasSourceKey(transaction, tenantId, conversation.id, input.sourceKey ?? ""));
    if (seen) return { kind: "duplicate" };
  }

  const leased = await withTenant(tenantId, (transaction) => acquireLease(transaction, tenantId, conversation.id));
  if (!leased) return { kind: "busy" };
  const release = () => withTenant(tenantId, (transaction) => releaseLease(transaction, tenantId, conversation.id));
  try {
    const prepared = await prepareTurn(input, setup, profileWords(catalog.profile), { bookingLink, phone, businessName: catalog.clinic.name, base, catalog });
    if (prepared.kind === "reply") {
      await release();
      return { kind: "reply", output: prepared };
    }
    return { kind: "model", turn: modelTurn(prepared, release) };
  } catch (error: unknown) {
    await release();
    throw error;
  }
}

/** A whole turn, answered all at once. WhatsApp and the tests use it; the website chat streams through `startTurn`. */
export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  const started = await startTurn(input);
  if (started.kind === "reply") return started.output;
  if (started.kind === "model") return started.turn.generate();
  return started;
}

type Catalog = Awaited<ReturnType<typeof catalogFor>>;

async function prepareTurn(
  input: TurnInput,
  setup: Setup,
  words: ReturnType<typeof profileWords>,
  facts: { bookingLink: string; phone: string | null; businessName: string; base: { fallbackLink: string | null; awaitingCode: boolean; verified: boolean }; catalog: Catalog },
): Promise<ReplyOutput | ModelPlan> {
  const { tenantId, now } = input;
  const { conversation, settings, history, channelCustomer } = setup;
  const { bookingLink, phone, businessName, base, catalog } = facts;
  const state = freshTurnState();
  const channel: ToolContext["channel"] = conversation.channel === "staff" ? "web" : conversation.channel;
  const context: ToolContext = {
    tenantId, slug: input.slug, channel, conversation: { ...conversation }, businessName, businessPhone: phone, bookingLink, now, channelCustomer,
    state, confirmedProposalId: null,
  };
  const customerText = input.text === undefined ? "" : sanitizeCustomerText(input.text);
  const toStore: NewMessage[] = [];
  const reply = (text: string, extra: Partial<ReplyOutput> = {}): ReplyOutput => ({
    kind: "reply", reply: text, status: "active", proposal: proposalOf(state), awaitingCode: state.awaitingCode, verified: base.verified, fallbackLink: null, handedOff: false, held: false, ...extra,
  });
  const customerMessage = (blocks: LlmBlock[]): NewMessage => ({ kind: "customer", blocks, ...(input.sourceKey ? { sourceKey: input.sourceKey } : {}) });
  const disclosure = conversation.turnCount === 0 ? `${disclosureLine(businessName)}\n\n` : "";

  // A chat that is waiting for a person: keep what the customer adds for the team, answer with a fixed line, no model.
  if (conversation.status !== "active") {
    if (customerText) {
      const heldReply = "Thanks. The team will see this and reply here as soon as they can.";
      await withTenant(tenantId, async (transaction) => {
        await appendMessages(transaction, tenantId, conversation.id, [customerMessage([{ type: "text", text: customerText }]), { kind: "assistant", blocks: [{ type: "text", text: heldReply }] }]);
        await touchConversation(transaction, tenantId, conversation.id, {});
      });
      return reply(heldReply, { status: conversation.status, handedOff: true, held: true });
    }
    return reply("The team has this chat and will reply as soon as they can.", { status: conversation.status, handedOff: true, held: true });
  }

  // A fixed reply and a person, with no model.
  const fixedHandoff = async (reason: HandoffReason): Promise<ReplyOutput> => {
    const text = reasonReply(reason, phone, conversation.channel);
    state.handoff = { reason, summary: `The customer wrote something the assistant is not allowed to handle (${reason.replace("_", " ")}). Read their messages and reply.` };
    await withTenant(tenantId, async (transaction) => {
      await appendMessages(transaction, tenantId, conversation.id, [customerMessage([{ type: "text", text: customerText }]), { kind: "assistant", blocks: [{ type: "text", text: `${disclosure}${text}` }] }]);
      await touchConversation(transaction, tenantId, conversation.id, { turns: 1 });
      if (state.handoff) await performHandoff(transaction, context, state.handoff);
    });
    return reply(`${disclosure}${text}`, { status: "handed_off", handedOff: true });
  };

  // An emergency always gets the safe reply and a person, even with no model, over the cap or past a rate limit.
  if (customerText && setup.entitled && channelEnabled(settings, conversation.channel) && isEmergency(customerText)) return fixedHandoff("emergency");

  // Off for this channel, not on the plan, no model, over the month's cap, or a very long chat: the booking link, never silence.
  const modelReady = input.model !== null;
  const over = modelReady ? await withTenant(tenantId, (transaction) => isOverCap(transaction, tenantId, now)) : false;
  if (!setup.entitled || !channelEnabled(settings, conversation.channel) || !modelReady || over || conversation.turnCount >= MAX_TURNS_PER_CONVERSATION) {
    const text = capReply(bookingLink);
    if (customerText) {
      await withTenant(tenantId, (transaction) => appendMessages(transaction, tenantId, conversation.id, [customerMessage([{ type: "text", text: customerText }]), { kind: "assistant", blocks: [{ type: "text", text }] }]));
    }
    return reply(text, { fallbackLink: bookingLink });
  }

  // Per-customer and per-business limits. The web route adds its per-address limit before it gets here.
  const customerKey = conversation.patientId ? `patient:${conversation.patientId}` : `chat:${conversation.id}`;
  const [byCustomer, byBusiness] = await Promise.all([hitRateLimit("assistant.customer", customerKey), hitRateLimit("assistant.tenant", tenantId)]);
  if (!byCustomer.allowed || !byBusiness.allowed) {
    const text = `${!byCustomer.allowed ? "You've sent a lot of messages." : "The assistant is very busy."} Please use the booking page: ${bookingLink}`;
    return reply(text, { fallbackLink: bookingLink });
  }

  const priorCustomerTexts = history.flatMap((entry) => {
    if (entry.kind !== "customer" || typeof entry.message.content === "string") return [];
    return [textOf(entry.message.content)];
  });

  // 1. Fixed replies, before any model.
  if (customerText) {
    let reason: HandoffReason | null = null;
    if (isEmergency(customerText)) reason = "emergency";
    else if (isAdviceSeeking(customerText)) reason = "advice";
    else if (asksForPerson(customerText)) reason = "asked_for_person";
    else if (soundsUpset(customerText, settings.handoffRule)) reason = "upset";
    else if (isRepeating(priorCustomerTexts, customerText)) reason = "cannot_help";
    if (reason) return fixedHandoff(reason);
  }

  // 2. The customer's confirm, if this message is one.
  const noteBlocks: LlmBlock[] = [];
  let displayedAsTyped = customerText;
  const waiting = await withTenant(tenantId, (transaction) => readPending(transaction, tenantId, conversation.id, now));
  let confirmedNow = false;
  if (waiting) {
    const tappedConfirm = input.confirmProposalId !== undefined && input.confirmProposalId === waiting.pendingId;
    const typedYes = customerText !== "" && isAffirmative(customerText) && waiting.pending.atTurn + 1 === conversation.turnCount;
    if (tappedConfirm || typedYes) {
      confirmedNow = true;
      context.confirmedProposalId = waiting.pendingId;
      const result = await commitPending(context, waiting.pendingId, waiting.pending);
      await withTenant(tenantId, (transaction) => clearPending(transaction, tenantId, conversation.id));
      if (result.ok) {
        state.committed = true;
        const requested = result.status === "requested";
        noteBlocks.push({ type: "text", text: serverNote(`The customer confirmed and this was done: ${result.summary}${requested ? " It is waiting for the team to approve." : ""} Tell them it is done and that a confirmation will be sent. Do not call any tool for this.`) });
      } else {
        // The reason code only: the message can name a person or a time.
        logger().info({ event: "assistant.commit_refused", tenantId, code: result.code }, "A confirmed change could not be made");
        noteBlocks.push({ type: "text", text: serverNote(`The customer confirmed, but it could NOT be done: ${result.message} Apologise briefly, then offer other times or the booking page ${bookingLink}.`) });
      }
      if (input.confirmProposalId !== undefined) displayedAsTyped = "";
    } else if (isNegative(customerText)) {
      await withTenant(tenantId, (transaction) => clearPending(transaction, tenantId, conversation.id));
      noteBlocks.push({ type: "text", text: serverNote("The customer said no to the proposal. Nothing was changed. Ask what they would like instead.") });
    }
  } else if (input.confirmProposalId !== undefined) {
    noteBlocks.push({ type: "text", text: serverNote("The customer tapped Confirm but that proposal has expired or was already used. Nothing was changed. Offer to check the time again.") });
  }
  if (input.note) noteBlocks.push({ type: "text", text: serverNote(input.note) });

  const userBlocks: LlmBlock[] = [
    ...(displayedAsTyped ? [{ type: "text" as const, text: displayedAsTyped }] : confirmedNow ? [{ type: "text" as const, text: "(The customer tapped Confirm.)" }] : []),
    ...noteBlocks,
  ];
  if (userBlocks.length === 0) return reply("What would you like to do?", {});
  toStore.push(customerMessage(userBlocks));

  // 3. The model, with tools. Everything it needs is gathered here; `modelTurn` runs it and settles the turn.
  const model = input.model;
  if (!model) return reply(capReply(bookingLink), { fallbackLink: bookingLink });
  const system = {
    stable: buildStableSystem({
      businessName, businessType: catalog.profile.businessTypeLabel, words, tone: settings.tone, channel, facts: settings.businessFacts, bookingLink, phone,
      timezone: catalog.clinic.timezone,
    }),
    volatile: buildVolatileSystem(now, catalog.clinic.timezone),
  };
  const messages = [
    ...modelMessagesOf(history.map((entry) => entry.message)),
    ...modelMessagesOf([{ role: "user", content: userBlocks }]),
  ];
  return { kind: "model", input, setup, context, state, channel, toStore, system, model, messages, disclosure, bookingLink, phone, base, reply };
}

interface ModelPlan {
  kind: "model";
  input: TurnInput;
  setup: Setup;
  context: ToolContext;
  state: TurnState;
  channel: ToolContext["channel"];
  /** The turn's messages so far: the customer's, to which the model's tool steps and the shown reply are added. */
  toStore: NewMessage[];
  system: { stable: string; volatile: string };
  model: AssistantLanguageModel;
  messages: ReturnType<typeof modelMessagesOf>;
  disclosure: string;
  bookingLink: string;
  phone: string | null;
  base: { fallbackLink: string | null; awaitingCode: boolean; verified: boolean };
  reply: (text: string, extra?: Partial<ReplyOutput>) => ReplyOutput;
}

/** What one run of the model left behind, however it ended. */
interface ModelRun {
  steps: StepResult<ToolSet>[];
  /** Set when the month's allowance ran out between steps. */
  capped: boolean;
  /** The failure the model call ended with (an outage, a refused request), if any. */
  failure: unknown;
  inputTokens: number;
  outputTokens: number;
}

/** The options both ways of running the model share: the tools, the limits and the usage count. */
function callOptions(plan: ModelPlan, run: ModelRun) {
  const { state, input } = plan;
  const { tenantId, now } = input;
  const startedAt = Date.now();
  return {
    model: plan.model.model,
    instructions: instructions(plan.system.stable, plan.system.volatile),
    messages: plan.messages,
    tools: assistantAiTools(plan.context),
    maxOutputTokens: 4096,
    // A turn ends at its step cap, when the model hands the chat to a person, when its time is up, or when the month's allowance is.
    stopWhen: [
      isStepCount(MAX_MODEL_CALLS_PER_TURN),
      () => Boolean(state.handoff),
      () => Date.now() - startedAt > TURN_BUDGET_MS,
      async () => {
        if (!(await withTenant(tenantId, (transaction) => isOverCap(transaction, tenantId, now)))) return false;
        run.capped = true;
        return true;
      },
    ],
    // Counted per step, so an answer that fails half way still counts what it used.
    onStepEnd: async (step: StepResult<ToolSet>) => {
      run.steps.push(step);
      const used = usageOf(step.usage);
      run.inputTokens += used.inputTokens;
      run.outputTokens += used.outputTokens;
      try {
        await withTenant(tenantId, (transaction) => recordUsage(transaction, tenantId, used, now));
      } catch (error: unknown) {
        logger().warn({ event: "assistant.usage_failed", errorName: error instanceof Error ? error.name : "UnknownError" }, "Model usage was not recorded");
      }
    },
  };
}

function emptyRun(): ModelRun {
  return { steps: [], capped: false, failure: null, inputTokens: 0, outputTokens: 0 };
}

function modelTurn(plan: ModelPlan, release: () => Promise<void>): ModelTurn {
  return {
    async generate() {
      const run = emptyRun();
      try {
        try {
          // `generateText` has no per-chunk timer, so it gets one number for the whole call.
          await generateText({ ...callOptions(plan, run), ...modelCallSettings(), timeout: TURN_TIMEOUT_MS });
        } catch (error: unknown) {
          run.failure = error;
          logModelError(error);
        }
        return await settleTurn(plan, run);
      } finally {
        await release();
      }
    },

    async stream(write) {
      const run = emptyRun();
      // Every text part the page was sent, to compare with what the customer is finally shown.
      const sent: string[] = [];
      const say = (id: string, text: string): void => {
        if (text === "") return;
        write({ type: "text-start", id });
        write({ type: "text-delta", id, delta: text });
        write({ type: "text-end", id });
        sent.push(text);
      };
      const disclosure = plan.disclosure.trim();
      try {
        write({ type: "start" });
        // The disclosure is fixed text that starts whatever the reply turns out to be, so it can go out at once.
        say("disclosure", disclosure);
        const result = streamText({
          ...callOptions(plan, run), ...modelCallSettings(), timeout: { totalMs: TURN_TIMEOUT_MS, chunkMs: 30_000 },
          onError: ({ error }) => {
            run.failure = error;
            logModelError(error);
          },
        });
        // The model's words never go to the page as they are written. Until the turn is settled nobody knows whether they are the reply:
        // words beside a tool call are dropped, a claim that a change is done is screened out while it waits for Confirm, a long reply
        // is cut, a call that fails half way is replaced by the booking link. Streamed, the customer would see such words, if only for a
        // moment. So the stream is only read here (for its errors), and the page shows the typing indicator until the settled reply.
        try {
          for await (const part of result.stream) {
            // A timeout ends the stream with `abort`; either way the turn settles as failed and the customer gets the booking link.
            if (part.type === "error" || part.type === "abort") run.failure ??= new Error("The stream failed.");
          }
        } catch (error: unknown) {
          run.failure ??= error;
        }
        // Wait for the last step's bookkeeping; a failed call has no steps to wait for.
        try { await result.steps; } catch { /* The failure is already noted. */ }
        const output = await settleTurn(plan, run);
        // The settled reply is the one that was saved; the page gets exactly those words, after the disclosure it already has.
        const shown = output.reply.trim();
        say("reply", (disclosure !== "" && shown.startsWith(disclosure) ? shown.slice(disclosure.length) : shown).trim());
        // A last line of defence: should the page's parts ever differ from the saved reply, it is told to show the saved one instead.
        if (shown !== sent.join("\n\n")) write({ type: "data-replace", data: { text: output.reply } });
        return output;
      } finally {
        await release();
      }
    },
  };
}

/** Step 4: decide what the customer is shown, save the turn, and hand off if it came to that. */
async function settleTurn(plan: ModelPlan, run: ModelRun): Promise<ReplyOutput> {
  const { input, setup, state, context, channel, toStore, disclosure, bookingLink, phone, reply } = plan;
  const { tenantId } = input;
  const { conversation, settings } = setup;
  const last = run.steps.at(-1);
  const lastCalledTools = last?.content.some((part) => part.type === "tool-call" && part.invalid !== true) ?? false;

  let finalText = "";
  let failed = run.failure !== null;
  if (!failed && !state.handoff) {
    if (run.capped) finalText = capReply(bookingLink);
    // The last step ended in tool calls (the step cap or the time ran out), came back empty, or was cut off or refused.
    else if (!last || lastCalledTools || last.text.trim() === "" || last.finishReason === "length" || last.finishReason === "content-filter" || last.finishReason === "error") failed = true;
    else finalText = last.text.trim();
  }
  toStore.push(...toolMessagesOf(run.steps));

  const threshold = settings.handoffRule === "eager" ? 1 : FAILURES_BEFORE_HANDOFF;
  if (failed && !state.handoff && conversation.failureCount + 1 >= threshold) {
    state.handoff = { reason: "cannot_help", summary: "The assistant could not answer after trying. Read the chat and reply." };
  }
  const proposal = proposalOf(state);
  let text: string;
  if (state.handoff) {
    text = reasonReply(state.handoff.reason, phone, conversation.channel);
  } else if (failed) {
    text = `Sorry, I'm having trouble right now. You can book at ${bookingLink}${phone ? ` or call ${phone}` : ""}.`;
  } else {
    text = screenReply(finalText, { committed: state.committed, proposalSummary: state.proposal?.summary ?? null });
  }
  // Off the website there is no Confirm button and no panel, so what the customer must see before saying yes is added here, in code,
  // whatever the model chose to write: the change, how to confirm, and what confirming means.
  const ask = proposal && channel !== "web"
    ? `\n\n${proposal.summary}\nReply yes to confirm, or no to leave it. By replying yes you accept the privacy notice (${bookingLink}) and agree to reminders on ${channel === "whatsapp" ? "WhatsApp" : "text message"}.`
    : "";
  const shown = `${disclosure}${text}${ask}`;
  // The stored reply is what the customer saw, so a reloaded chat matches.
  toStore.push({ kind: "assistant", blocks: [{ type: "text", text: shown }], inputTokens: run.inputTokens, outputTokens: run.outputTokens });

  await withTenant(tenantId, async (transaction) => {
    const stored = await appendMessages(transaction, tenantId, conversation.id, toStore);
    if (!stored) return;
    await touchConversation(transaction, tenantId, conversation.id, { turns: 1, ...(failed ? { failed: true } : { resetFailures: true }) });
    if (state.handoff) await performHandoff(transaction, context, state.handoff);
  });
  return reply(shown, {
    proposal, status: state.handoff ? "handed_off" : "active", handedOff: Boolean(state.handoff), fallbackLink: failed || shown === capReply(bookingLink) ? bookingLink : null,
  });
}
