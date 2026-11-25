"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import { ArrowUpIcon, CheckIcon, SparklesIcon, SquareIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { ChatConversation } from "@/components/chat/chat-conversation";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatTypingIndicator } from "@/components/chat/chat-typing-indicator";
import { useChatScroll } from "@/components/chat/hooks/use-chat-scroll";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Composer, ComposerActionGroup, ComposerActions, ComposerInput, ComposerSubmit, getComposerText, type ComposerValue } from "@/components/ui/composer";
import { Drawer, DrawerDescription, DrawerHeader, DrawerPopup, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useTerms } from "@/features/terms/business-profile-context";
import type { AssistantProposal } from "@/lib/assistant-contracts";
import { copilotToolLabels, type CopilotUIMessage } from "@/lib/copilot-ui";

import { readApiError } from "../queries/http";
import { useStaffAccess } from "../staff-access";
import { useCopilotConfirm } from "./queries";
import { starterPrompts } from "./starter-prompts";

/**
 * The staff copilot (feature 30). It looks things up and drafts; it never changes anything. A booking it suggests shows here with a
 * Confirm button, and only pressing that makes the booking, with your own permission.
 *
 * The answer streams in through the AI SDK's `useChat`. The page sends only the new question and the chat's id; the server keeps the
 * history. The chat's id and a booking suggestion arrive as typed data parts (`data-conversation`, `data-proposal`).
 */

const MAX_QUESTION = 1500;

type Part = CopilotUIMessage["parts"][number];

/** An error from the chat, in plain words. A refusal before streaming is the API's JSON error; a failure after it is plain text. */
function describeError(error: Error): { message: string; code: string } {
  try {
    const body: unknown = JSON.parse(error.message);
    const code = typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "code" in body.error && typeof body.error.code === "string" ? body.error.code : "unknown";
    return { message: readApiError(body, "The copilot couldn't answer just now."), code };
  } catch {
    return { message: error.message.trim() || "The copilot couldn't answer just now.", code: "stream" };
  }
}

function wordsOf(message: CopilotUIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
}

/** One short line for a tool step. Every state a tool can be in has words. */
function toolStatus(part: Part): { text: string; state: "working" | "done" | "failed" } | null {
  if (!isToolUIPart(part)) return null;
  const label = copilotToolLabels[getToolName(part)] ?? "Working";
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return { text: `${label}…`, state: "working" };
    case "approval-requested":
      return { text: `${label}: waiting for approval`, state: "working" };
    case "approval-responded":
      return { text: `${label}…`, state: "working" };
    case "output-available": {
      const output: unknown = part.output;
      const failed = typeof output === "object" && output !== null && "error" in output && typeof output.error === "string";
      return failed ? { text: `${label}: that didn't work`, state: "failed" } : { text: label, state: "done" };
    }
    case "output-error":
      return { text: `${label}: that didn't work`, state: "failed" };
    case "output-denied":
      return { text: `${label}: not allowed`, state: "failed" };
    default:
      return null;
  }
}

function ToolStep({ status }: { status: NonNullable<ReturnType<typeof toolStatus>> }) {
  return (
    <p className="flex items-center gap-1.5 ps-1 text-muted-foreground text-xs" data-state={status.state}>
      {status.state === "working" ? <Spinner aria-hidden="true" className="size-3" /> : status.state === "failed" ? <TriangleAlertIcon aria-hidden="true" className="size-3" /> : <CheckIcon aria-hidden="true" className="size-3" />}
      {status.text}
    </p>
  );
}

function proposalOf(message: CopilotUIMessage | undefined): AssistantProposal | null {
  if (!message || message.role !== "assistant") return null;
  for (const part of [...message.parts].reverse()) if (part.type === "data-proposal") return part.data;
  return null;
}

export function CopilotPanel() {
  const t = useTerms();
  const access = useStaffAccess();
  const confirm = useCopilotConfirm();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ComposerValue>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const [confirmError, setConfirmError] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const hintId = useId();
  const touchInput = useMediaQuery({ pointer: "coarse" });

  // Only the newest question goes up, with the chat's id: the server holds the history and rebuilds the model's messages itself.
  const transport = useMemo(() => new DefaultChatTransport<CopilotUIMessage>({
    api: "/api/staff/assistant",
    prepareSendMessagesRequest: ({ messages, trigger, body }) => {
      const question = [...messages].reverse().find((message) => message.role === "user");
      return { body: { conversationId: body?.conversationId, trigger, message: { id: question?.id ?? "", text: question ? wordsOf(question) : "" } } };
    },
  }), []);
  const chat = useChat<CopilotUIMessage>({
    transport,
    onData: (part) => { if (part.type === "data-conversation") setConversationId(part.data.id); },
    // The answer is read out once, when it is finished, rather than word by word as it streams.
    onFinish: ({ message, isAbort, isError }) => { if (!isAbort && !isError) setAnnouncement(wordsOf(message)); },
  });
  const { messages, status, error, sendMessage, regenerate, stop, setMessages, clearError } = chat;
  const busy = status === "submitted" || status === "streaming";

  // A suggestion stops being offered when it runs out (the server holds it for half an hour); the clock moves on while one is showing.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const last = messages.at(-1);
  const proposal = status === "ready" ? proposalOf(last) : null;
  const showProposal = proposal !== null && !dismissed.has(proposal.id) && new Date(proposal.expiresAt).getTime() > now;
  const failure = error ? describeError(error) : null;

  const scroll = useChatScroll({ active: open, itemCount: messages.length, layoutKey: `${status}:${showProposal}:${failure?.code ?? ""}:${confirmError}` });

  if (!access.can("schedule.read") && !access.can("appointments.book") && !access.can("inbox.reply")) return null;
  const examples = starterPrompts(t);

  function ask(text: string): void {
    const trimmed = text.trim().slice(0, MAX_QUESTION);
    if (!trimmed || busy) return;
    setConfirmError("");
    scroll.resetScroll();
    void sendMessage({ text: trimmed }, { body: { conversationId } });
  }

  function book(chosen: AssistantProposal): void {
    if (!conversationId) return;
    setConfirmError("");
    confirm.mutate({ conversationId, proposalId: chosen.id }, {
      onSuccess: (done) => {
        scroll.resetScroll();
        setMessages((current) => [...current, { id: `done-${chosen.id}`, role: "assistant", parts: [{ type: "text", text: `Done. ${done.summary}` }] }]);
        setAnnouncement("Booked.");
        toastManager.add({ title: `${t.Appointment} booked`, type: "success" });
      },
      onError: (failed) => setConfirmError(failed.message),
    });
  }

  function newChat(): void {
    setConversationId(undefined);
    setMessages([]);
    setDismissed(new Set());
    setConfirmError("");
    clearError();
  }

  return (
    <Drawer position="right" open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<DrawerTrigger render={<Button variant="ghost" size="icon" aria-label="Open the copilot" />} />}>
          <SparklesIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup>Copilot</TooltipPopup>
      </Tooltip>
      <DrawerPopup className="max-w-md" showCloseButton>
        <DrawerHeader className="gap-1 border-b py-4">
          <DrawerTitle>Copilot</DrawerTitle>
          <DrawerDescription>Asks and suggests. It never changes anything until you press Confirm.</DrawerDescription>
        </DrawerHeader>
        <ChatConversation scroll={scroll} label="Copilot conversation" jumpLabel="Jump to latest" live="off">
          <div className="flex flex-col gap-3 pt-4">
            {messages.length === 0 ? (
              <div role="group" aria-label="Suggested questions" className="flex flex-col gap-2">
                <p className="text-muted-foreground text-sm">Try one of these:</p>
                {examples.map((example) => <Button key={example} variant="outline" className="h-auto min-h-11 justify-start whitespace-normal py-2 text-start" onClick={() => ask(example)}>{example}</Button>)}
              </div>
            ) : null}
            {messages.map((message) => (
              <div key={message.id} className="flex flex-col gap-1.5">
                {message.parts.map((part, index) => {
                  if (part.type === "text") {
                    if (part.text.trim() === "") return null;
                    return (
                      <ChatMessage key={index} side={message.role === "user" ? "outgoing" : "incoming"} animateEntrance={message.role === "user"}>
                        {part.text}
                      </ChatMessage>
                    );
                  }
                  const step = toolStatus(part);
                  return step ? <ToolStep key={index} status={step} /> : null;
                })}
              </div>
            ))}
            <ChatTypingIndicator visible={status === "submitted"} label="The copilot is thinking" />
            {showProposal && proposal ? (
              <Alert role="group" aria-label="Confirm this booking" className="self-stretch">
                <AlertDescription className="flex flex-col gap-3">
                  <p className="font-medium text-foreground">{proposal.summary}</p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={confirm.isPending} onClick={() => book(proposal)}>{confirm.isPending ? <Spinner aria-hidden="true" /> : null}Confirm and book</Button>
                    <Button size="sm" variant="ghost" onClick={() => setDismissed((current) => new Set(current).add(proposal.id))}>Not now</Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : null}
            {confirmError ? <Alert variant="error" role="alert" className="self-stretch"><AlertDescription>{confirmError}</AlertDescription></Alert> : null}
            {failure ? (
              <Alert variant="error" role="alert" className="self-stretch">
                <AlertDescription className="flex flex-col gap-2">
                  <p>{failure.message}</p>
                  <div className="flex gap-2">
                    {failure.code === "conversation_full" ? (
                      <Button size="sm" variant="outline" onClick={newChat}>Start a new chat</Button>
                    ) : failure.code === "assistant_cap" || failure.code === "assistant_unavailable" ? null : (
                      <Button size="sm" variant="outline" onClick={() => void regenerate({ body: { conversationId } })}>Try again</Button>
                    )}
                  </div>
                </AlertDescription>
              </Alert>
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
              const text = getComposerText(value).trim();
              if (!text || busy) return;
              ask(text);
              setDraft([]);
            }}
          >
            <ComposerInput
              render={<textarea maxLength={MAX_QUESTION} />}
              aria-label="Your question"
              aria-describedby={touchInput ? undefined : hintId}
              placeholder="Ask something"
            />
            <ComposerActions>
              <ComposerActionGroup align="end">
                {busy ? (
                  <Button type="button" size="icon" aria-label="Stop" onClick={() => void stop()}><SquareIcon aria-hidden="true" /></Button>
                ) : (
                  <ComposerSubmit render={<Button size="icon" aria-label="Send"><ArrowUpIcon aria-hidden="true" /></Button>} />
                )}
              </ComposerActionGroup>
            </ComposerActions>
          </Composer>
          {!touchInput ? <p id={hintId} className="text-end text-muted-foreground text-xs">Enter to send / Shift + Enter for a new line</p> : null}
        </div>
      </DrawerPopup>
    </Drawer>
  );
}
