import "server-only";

import { createUIMessageStream, type UIMessageChunk } from "ai";
import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import type { AssistantChatLine, AssistantChatRequest, AssistantPublicConfig } from "@/lib/assistant-contracts";
import type { AssistantConversationState, AssistantUIMessage } from "@/lib/assistant-ui";
import { canUse } from "@/lib/entitlements";

import { ApiError } from "../api-error";
import { sha256 } from "../crypto";
import { appOrigin } from "../env";
import { loadEntitlements } from "../entitlements";
import { hitRateLimit, recordRefusal } from "../rate-limit";
import { rateLimitRules } from "../rate-limit-rules";
import { assertSlugNotPaused } from "../tenant-pause";
import { getPublicClinicCatalog } from "../public-catalog";
import { startTurn, type TurnInput } from "./loop";
import { resolveAssistantModel } from "./model";
import { loadSettingsIn } from "./settings";
import { createConversation, findWebConversation, loadHistory, newWebToken, visibleLines } from "./store";
import { checkVerificationCode } from "./verify";

/**
 * The website chat (feature 30). A visitor has no account: the chat is theirs through a 256-bit token the page keeps for the tab,
 * stored here only as a hash. Everything the chat can do goes through the same turn as the other channels.
 */

async function tenantOf(slug: string): Promise<string> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "The assistant is not available right now.");
  const rows = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
  const tenantId = rows[0]?.tenant_id;
  if (!tenantId) throw new ApiError(404, "clinic_not_found", "Business not found.");
  await assertSlugNotPaused(slug);
  return tenantId;
}

const bookingLinkFor = (slug: string): string => `${appOrigin()}/book/${encodeURIComponent(slug)}`;

/** What the page needs before it shows the chat button: whether the assistant is on for this business. */
export async function publicAssistantConfig(slug: string): Promise<AssistantPublicConfig> {
  const tenantId = await tenantOf(slug);
  const catalog = await getPublicClinicCatalog(slug);
  const [settings, billing, llm] = await Promise.all([
    withTenant(tenantId, (transaction) => loadSettingsIn(transaction, tenantId)),
    loadEntitlements(tenantId),
    resolveAssistantModel("customer"),
  ]);
  const businessName = catalog?.clinic.name ?? "this business";
  return {
    enabled: settings.enabledWeb && canUse(billing.entitlements, "assistant") && llm !== null,
    businessName,
    bookingLink: bookingLinkFor(slug),
    greeting: `Chat with ${businessName}'s automated assistant`,
  };
}

/** What the visitor's page is told when the answer fails after it has started streaming. The provider's own text is never passed on. */
const STREAM_ERROR = "The assistant couldn't answer just now.";

/**
 * One message from a website visitor, answered as a stream of AI SDK UI message chunks. Every reply streams, so the page has one thing to
 * read: a fixed reply (an emergency, a medicine question, the booking link) is a one-part stream, and a model reply arrives word by word.
 * Anything that refuses the message (the address or chat limit, an unknown business, a chat still answering, a repeated message) throws
 * an `ApiError` here, before streaming starts, so the page gets the ordinary JSON error.
 */
export async function webChat(request: AssistantChatRequest, address: string): Promise<ReadableStream<UIMessageChunk>> {
  const ipLimit = await hitRateLimit("assistant.ip", address);
  if (!ipLimit.allowed) {
    recordRefusal("assistant.ip");
    throw new ApiError(429, "rate_limited", rateLimitRules["assistant.ip"].message, undefined, { "Retry-After": String(ipLimit.retryAfterSeconds) });
  }
  const slug = request.business;
  const tenantId = await tenantOf(slug);
  const link = bookingLinkFor(slug);

  const existing = request.token
    ? await withTenant(tenantId, (transaction) => findWebConversation(transaction, tenantId, newTokenHash(request.token ?? "")))
    : null;
  let token: string | undefined;
  let conversation = existing;
  if (!conversation) {
    const fresh = newWebToken();
    token = fresh.token;
    conversation = await withTenant(tenantId, (transaction) => createConversation(transaction, tenantId, { channel: "web", tokenHash: fresh.hash }));
  }
  const chatLimit = await hitRateLimit("assistant.conversation", `chat:${conversation.id}`);
  if (!chatLimit.allowed) {
    recordRefusal("assistant.conversation");
    throw new ApiError(429, "rate_limited", rateLimitRules["assistant.conversation"].message, undefined, { "Retry-After": String(chatLimit.retryAfterSeconds) });
  }

  const model = await resolveAssistantModel("customer");
  let note: string | undefined;
  if (request.code) {
    const result = await checkVerificationCode(tenantId, conversation.id, request.code);
    note = result.verified
      ? "The customer entered the code and their phone is now verified. Continue with what they wanted: call find_my_bookings."
      : "The code the customer entered was wrong or expired. Ask them to check it, or to ask for a new one.";
  }
  const input: TurnInput = {
    tenantId, slug, conversationId: conversation.id, model, now: new Date(),
    ...(request.text !== undefined ? { text: request.text } : {}),
    ...(request.confirmProposalId !== undefined ? { confirmProposalId: request.confirmProposalId } : {}),
    ...(note ? { note } : {}),
  };
  const started = await startTurn(input);
  if (started.kind === "busy") throw new ApiError(409, "assistant_busy", "I'm still answering your last message. Give me a moment.", undefined, { "Retry-After": "2" });
  if (started.kind === "duplicate") throw new ApiError(409, "duplicate_message", "That message was already received.");

  const chatId = conversation.id;
  const begin: AssistantConversationState = {
    ...(token ? { token } : {}), status: conversation.status, awaitingCode: conversation.hasOtpPhone && conversation.verifiedPatientIds.length === 0,
    verified: conversation.verifiedPatientIds.length > 0,
  };
  return createUIMessageStream<AssistantUIMessage>({
    onError: () => STREAM_ERROR,
    execute: async ({ writer }) => {
      const write = (chunk: UIMessageChunk): void => writer.write(chunk as Parameters<typeof writer.write>[0]);
      // The token and the chat's state first, so a page that is closed mid-answer still has the token for the next message.
      writer.write({ type: "data-conversation", data: begin, transient: true });
      let output;
      if (started.kind === "reply") {
        output = started.output;
        write({ type: "start" });
        write({ type: "text-start", id: "reply" });
        write({ type: "text-delta", id: "reply", delta: output.reply });
        write({ type: "text-end", id: "reply" });
      } else {
        output = await started.turn.stream(write);
      }
      // The turn is settled, so the chat's state is final: tools can have asked for a code or handed the chat to a person.
      const fresh = await withTenant(tenantId, (transaction) => transcriptOf(transaction, tenantId, chatId));
      if (output.proposal) writer.write({ type: "data-proposal", id: output.proposal.id, data: output.proposal });
      const fallback = output.fallbackLink ?? (model === null ? link : null);
      if (fallback) writer.write({ type: "data-fallback", data: { link: fallback } });
      writer.write({
        type: "data-conversation", transient: true,
        data: { ...(token ? { token } : {}), status: output.status, awaitingCode: output.awaitingCode || (fresh.awaitingCode && !output.verified), verified: output.verified },
      });
      write({ type: "finish" });
    },
  });
}

function newTokenHash(token: string): string {
  return sha256(token);
}

async function transcriptOf(transaction: Parameters<Parameters<typeof withTenant>[1]>[0], tenantId: string, conversationId: string): Promise<{ lines: AssistantChatLine[]; awaitingCode: boolean }> {
  const history = await loadHistory(transaction, tenantId, conversationId);
  const rows = await transaction.execute<{ otp: boolean; verified: number }>(sql`
    select otp_phone_ciphertext is not null as otp, coalesce(array_length(verified_patient_ids, 1), 0) as verified
    from assistant_conversations where tenant_id = ${tenantId} and id = ${conversationId}
  `);
  return { lines: visibleLines(history), awaitingCode: rows[0]?.otp === true };
}

/** The visible chat so far, for a page that was reloaded. An unknown token is an empty chat, not an error. */
export async function webTranscript(slug: string, token: string): Promise<{ lines: AssistantChatLine[]; status: "active" | "handed_off" | "closed"; awaitingCode: boolean; verified: boolean }> {
  const tenantId = await tenantOf(slug);
  return withTenant(tenantId, async (transaction) => {
    const conversation = await findWebConversation(transaction, tenantId, newTokenHash(token));
    if (!conversation) return { lines: [], status: "active", awaitingCode: false, verified: false };
    const fresh = await transcriptOf(transaction, tenantId, conversation.id);
    return { lines: fresh.lines, status: conversation.status, awaitingCode: fresh.awaitingCode && conversation.verifiedPatientIds.length === 0, verified: conversation.verifiedPatientIds.length > 0 };
  });
}

