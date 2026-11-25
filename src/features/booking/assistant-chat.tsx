"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { ArrowUpIcon, MessageCircleIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { z } from "zod";

import { ChatConversation } from "@/components/chat/chat-conversation";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatTypingIndicator } from "@/components/chat/chat-typing-indicator";
import { useChatScroll } from "@/components/chat/hooks/use-chat-scroll";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Composer, ComposerActionGroup, ComposerActions, ComposerInput, ComposerSubmit, getComposerText, type ComposerValue } from "@/components/ui/composer";
import { Drawer, DrawerDescription, DrawerHeader, DrawerPopup, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Field, FieldLabel } from "@/components/ui/field";
import { OTPField, OTPFieldInput } from "@/components/ui/otp-field";
import { useMediaQuery } from "@/hooks/use-media-query";
import { assistantPublicStatus, type AssistantProposal } from "@/lib/assistant-contracts";
import type { AssistantConversationState, AssistantUIMessage } from "@/lib/assistant-ui";

/**
 * The website chat (feature 30): a button on the booking page that opens a side panel. The assistant says it is automated, offers
 * real free times, and asks the visitor to tap Confirm before anything is booked. A code sent by text goes in its own box and never
 * into the conversation. The chat's token lives only in this tab (sessionStorage), and everything works without it.
 *
 * The answer streams in through the AI SDK's `useChat`, on the coss Chat and Composer. The server streams the assistant's words and
 * a few typed data parts (see `lib/assistant-ui.ts`): the chat's token and state, the change to confirm, the booking link, and, when
 * the reply was screened after it streamed, the words to show instead.
 */

const MAX_MESSAGE = 1000;

const lineSchema = z.object({ role: z.enum(["customer", "assistant"]), text: z.string() });
const readSchema = z.object({
  config: z.object({ enabled: z.boolean(), businessName: z.string(), bookingLink: z.string(), greeting: z.string() }),
  transcript: z.object({ lines: z.array(lineSchema), status: assistantPublicStatus, awaitingCode: z.boolean(), verified: z.boolean() }).nullable(),
});
const errorSchema = z.object({ error: z.object({ message: z.string() }) });

const GENERIC_ERROR = "Something went wrong. Please try again.";
const tokenKey = (slug: string): string => `kalendr-assistant-${slug}`;

function readToken(slug: string): string | null {
  try { return window.sessionStorage.getItem(tokenKey(slug)); } catch { return null; }
}
function storeToken(slug: string, token: string): void {
  try { window.sessionStorage.setItem(tokenKey(slug), token); } catch { /* A private window keeps the chat for this page only. */ }
}

async function readChat(path: string): Promise<unknown> {
  const response = await fetch(path);
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(GENERIC_ERROR);
  return body && typeof body === "object" && "data" in body ? body.data : null;
}

/** An error from the chat, in plain words. A refusal before streaming is the API's JSON error; a failure after it is plain text. */
function describeError(error: Error): string {
  try {
    const parsed = errorSchema.safeParse(JSON.parse(error.message));
    if (parsed.success) return parsed.data.error.message;
  } catch { /* Not JSON: it is the stream's own plain sentence. */ }
  const text = error.message.trim();
  return text !== "" && text.length < 200 && !text.startsWith("{") ? text : GENERIC_ERROR;
}

/** The words the customer is shown for one message: the replacement the server sent when there is one, else the streamed parts in order. */
function shownText(message: AssistantUIMessage): string {
  for (const part of [...message.parts].reverse()) if (part.type === "data-replace") return part.data.text.trim();
  return message.parts.flatMap((part) => (part.type === "text" && part.text.trim() !== "" ? [part.text.trim()] : [])).join("\n\n");
}

/** The words of the customer's own message, for the request. */
function typedText(message: AssistantUIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
}

function latestPart<TYPE extends "data-proposal" | "data-fallback">(message: AssistantUIMessage | undefined, type: TYPE): Extract<AssistantUIMessage["parts"][number], { type: TYPE }> | null {
  if (!message || message.role !== "assistant") return null;
  for (const part of [...message.parts].reverse()) if (part.type === type) return part as Extract<AssistantUIMessage["parts"][number], { type: TYPE }>;
  return null;
}

/** Only the business's own booking address becomes a link; any other address the model writes stays plain text. */
function Linked({ text, bookingLink }: { text: string; bookingLink: string }): ReactNode {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, index) => (part === bookingLink || part.startsWith(`${bookingLink}?`)
        ? <a key={index} href={part} className="font-medium underline underline-offset-4" rel="noreferrer">{part}</a>
        : <span key={index}>{part}</span>))}
    </span>
  );
}

export function AssistantChat({ clinicSlug }: { clinicSlug: string }) {
  const [config, setConfig] = useState<z.infer<typeof readSchema>["config"] | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ComposerValue>([]);
  const [code, setCode] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [conversation, setConversation] = useState<Omit<AssistantConversationState, "token">>({ status: "active", awaitingCode: false, verified: false });
  const [token, setToken] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const touchInput = useMediaQuery({ pointer: "coarse" });

  // What goes up is exactly what the route accepts: the business, the chat's token once there is one, and one of a message, a tapped
  // Confirm or a code. The page never sends its history; the server keeps the chat.
  const transport = useMemo(() => new DefaultChatTransport<AssistantUIMessage>({
    api: "/api/public/assistant",
    prepareSendMessagesRequest: ({ messages, body }) => {
      const base = { business: clinicSlug, ...(typeof body?.token === "string" ? { token: body.token } : {}) };
      if (typeof body?.confirmProposalId === "string") return { body: { ...base, confirmProposalId: body.confirmProposalId } };
      if (typeof body?.code === "string") return { body: { ...base, code: body.code } };
      const asked = [...messages].reverse().find((message) => message.role === "user");
      return { body: { ...base, text: asked ? typedText(asked) : "" } };
    },
  }), [clinicSlug]);
  const chat = useChat<AssistantUIMessage>({
    transport,
    onData: (part) => {
      if (part.type !== "data-conversation") return;
      const { token: fresh, ...state } = part.data;
      if (fresh) { setToken(fresh); storeToken(clinicSlug, fresh); }
      setConversation(state);
    },
    // The answer is read out once, when it is finished, rather than word by word as it streams.
    onFinish: ({ message, isAbort, isError }) => { if (!isAbort && !isError) setAnnouncement(shownText(message)); },
  });
  const { messages, status, error, sendMessage, setMessages } = chat;
  const busy = status === "submitted" || status === "streaming";

  // Whether the chat is on for this business, and the chat so far if this tab already had one.
  useEffect(() => {
    let cancelled = false;
    const saved = readToken(clinicSlug);
    const query = new URLSearchParams({ business: clinicSlug, ...(saved ? { token: saved } : {}) });
    void readChat(`/api/public/assistant?${query.toString()}`).then((data) => {
      const parsed = readSchema.safeParse(data);
      if (cancelled || !parsed.success) return;
      setToken(saved);
      setConfig(parsed.data.config);
      const transcript = parsed.data.transcript;
      if (transcript) {
        setMessages((current) => (current.length > 0 ? current : transcript.lines.map((line, index): AssistantUIMessage => ({
          id: `saved-${index}`, role: line.role === "customer" ? "user" : "assistant", parts: [{ type: "text", text: line.text }],
        }))));
        setConversation({ status: transcript.status, awaitingCode: transcript.awaitingCode, verified: transcript.verified });
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [clinicSlug, setMessages]);

  const last = messages.at(-1);
  // The change to confirm stays on offer until an answer comes back: after a failed send (a limit, a lost connection) the visitor can tap again.
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const offered = status === "ready" ? last === lastAssistant : status === "error";
  const proposal: AssistantProposal | null = offered ? (latestPart(lastAssistant, "data-proposal")?.data ?? null) : null;
  const fallbackLink = latestPart(last, "data-fallback")?.data.link ?? null;
  const failure = error ? describeError(error) : null;
  const handedOff = conversation.status !== "active";
  const lastWords = last ? shownText(last) : "";
  const scroll = useChatScroll({ active: open, itemCount: messages.length, layoutKey: `${status}:${lastWords.length}:${proposal?.id ?? ""}:${failure ?? ""}:${conversation.awaitingCode}` });

  if (!config?.enabled) return null;

  function send(text: string, extra?: Record<string, string>, hidden = false): void {
    if (busy) return;
    scroll.resetScroll();
    setAnnouncement("");
    void sendMessage({ text, ...(hidden ? { metadata: { hidden: true } } : {}) }, { body: { ...extra, ...(token ? { token } : {}) } });
  }

  function sendCode(value: string): void {
    if (busy) return;
    setCode("");
    // The six digits go in the request only: the page shows no message for them, and they never become part of the chat.
    send("Verifying my code", { code: value }, true);
  }

  return (
    <Drawer position="right" open={open} onOpenChange={setOpen}>
      <DrawerTrigger render={<Button size="lg" className="fixed end-4 bottom-20 z-30 rounded-full shadow-lg sm:bottom-6" />}>
        <MessageCircleIcon aria-hidden="true" />
        Ask us
      </DrawerTrigger>
      <DrawerPopup className="max-w-md" showCloseButton initialFocus={composer}>
        <DrawerHeader className="gap-1 border-b py-4">
          <div className="flex items-center gap-2">
            <DrawerTitle className="min-w-0 truncate">{config.businessName}</DrawerTitle>
            <Badge variant="info" className="shrink-0">Automated assistant</Badge>
          </div>
          <DrawerDescription>Ask about times and book without calling. A person can take over any time.</DrawerDescription>
        </DrawerHeader>
        <ChatConversation scroll={scroll} label="Conversation" jumpLabel="Jump to latest" live="off">
          <div className="flex flex-col gap-3 pt-4">
            {messages.length === 0 ? (
              <p className="text-muted-foreground text-sm">Hi! I&apos;m {config.businessName}&apos;s automated assistant. Try &ldquo;Do you have anything on Saturday afternoon?&rdquo;</p>
            ) : null}
            {messages.map((message) => {
              if (message.metadata?.hidden) return null;
              const words = message.role === "user" ? typedText(message) : shownText(message);
              if (words === "") return null;
              return (
                <ChatMessage key={message.id} side={message.role === "user" ? "outgoing" : "incoming"} animateEntrance={message.role === "user"}>
                  <Linked text={words} bookingLink={config.bookingLink} />
                </ChatMessage>
              );
            })}
            {/* Shown for the whole answer: the server sends the reply only once it is checked and saved, just before the stream ends. */}
            <ChatTypingIndicator visible={busy} label="The assistant is typing" />
            {proposal && !handedOff ? (
              <Alert role="group" aria-label="Confirm this change" className="self-stretch">
                <AlertDescription className="flex flex-col gap-3">
                  <p className="font-medium text-foreground">{proposal.summary}</p>
                  <p className="text-xs">Nothing changes until you confirm. By confirming you accept the privacy notice and agree to reminders by text or WhatsApp.</p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => send("Confirm", { confirmProposalId: proposal.id })}>Confirm</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => send("No, not now")}>Not now</Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {conversation.awaitingCode && !conversation.verified && !handedOff ? (
              <Field className="gap-2 self-stretch rounded-xl border p-3">
                <FieldLabel id="assistant-code-label">Code from your text message</FieldLabel>
                <OTPField length={6} value={code} onValueChange={setCode} onValueComplete={sendCode} disabled={busy} aria-labelledby="assistant-code-label">
                  {Array.from({ length: 6 }, (_, index) => <OTPFieldInput key={index} {...(index === 0 ? {} : { "aria-label": `Digit ${index + 1}` })} />)}
                </OTPField>
                <p className="text-muted-foreground text-xs">Type it here, not in the chat. It proves the number is yours.</p>
              </Field>
            ) : null}
            {fallbackLink ? (
              <Alert variant="info" className="self-stretch"><AlertDescription>You can also <a className="font-medium underline underline-offset-4" href={fallbackLink}>book on the booking page</a>.</AlertDescription></Alert>
            ) : null}
            {failure ? (
              <Alert variant="error" className="self-stretch" role="alert"><AlertDescription>{failure}</AlertDescription></Alert>
            ) : null}
          </div>
        </ChatConversation>
        <p role="status" className="sr-only">{announcement}</p>
        <div className="flex shrink-0 flex-col gap-2 px-4 pb-4">
          <Composer
            submitOnEnter="desktop"
            submitDisabled={busy}
            value={draft}
            onValueChange={setDraft}
            onSubmit={(value) => {
              const text = getComposerText(value).trim().slice(0, MAX_MESSAGE);
              if (!text || busy) return;
              setDraft([]);
              send(text);
            }}
          >
            <ComposerInput
              render={<textarea ref={composer} maxLength={MAX_MESSAGE} />}
              aria-label="Your message"
              aria-describedby={touchInput ? undefined : hintId}
              placeholder={handedOff ? "The team will read this" : "Type a message"}
            />
            <ComposerActions>
              <ComposerActionGroup align="end">
                <ComposerSubmit render={<Button size="icon" aria-label="Send"><ArrowUpIcon aria-hidden="true" /></Button>} />
              </ComposerActionGroup>
            </ComposerActions>
          </Composer>
          {!touchInput ? <p id={hintId} className="text-end text-muted-foreground text-xs">Enter to send / Shift + Enter for a new line</p> : null}
        </div>
      </DrawerPopup>
    </Drawer>
  );
}
