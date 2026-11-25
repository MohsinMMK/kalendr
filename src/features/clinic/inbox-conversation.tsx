"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CalendarClock, MessageSquare, UserRound } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { ThreadAppointment, ThreadDetail, ThreadMessage } from "@/lib/inbox-contracts";

import { appointmentDateTime } from "./clinic-format";
import { useAssign, useMarkRead, useThread } from "./inbox-api";
import { InboxComposer } from "./inbox-composer";
import { dayHeading, dayKey, failureWords, statusWords } from "./inbox-text";
import { useStaffAccess } from "./staff-access";
import { ChatConversation } from "@/components/chat/chat-conversation";
import { ChatDatePill } from "@/components/chat/chat-date-pill";
import { ChatDeliveryIndicator } from "@/components/chat/chat-delivery-indicator";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatEmptyState, ChatLoadingState, ChatStatusBar } from "@/components/chat/chat-states";
import { type ChatScrollController, useChatScroll } from "@/components/chat/hooks/use-chat-scroll";

function words(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const deliveryOf: Record<ThreadMessage["status"], "sending" | "sent" | "delivered" | "read" | "failed"> = {
  received: "delivered",
  queued: "sending",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  failed: "failed",
};

const timeFormat = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
/** Messages from the same side within this long, on the same day, share one author and one footer. */
const groupWindowMs = 5 * 60 * 1000;

function MessageBody({ message }: { message: ThreadMessage }) {
  return (
    <>
      {message.kind === "template" ? (
        <span className="inline-flex w-fit items-center rounded-md bg-background px-2 py-0.5 text-xs text-muted-foreground">Template: {message.templateLabel ?? "Approved message"}</span>
      ) : message.text ? (
        <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
      ) : (
        <p className="text-sm text-muted-foreground">Sent a picture, voice note or file. Open WhatsApp on the phone to see it.</p>
      )}
      {message.status === "failed" ? <p className="text-xs text-destructive-foreground">{failureWords(message.failureCode)}</p> : null}
    </>
  );
}

function InboxMessage({ message, grouped, groupEnd, entering }: { message: ThreadMessage; grouped: boolean; groupEnd: boolean; entering: boolean }) {
  const outbound = message.direction === "outbound";
  const time = timeFormat.format(new Date(message.createdAt));
  const failed = message.status === "failed";
  return (
    <ChatMessage
      side={outbound ? "outgoing" : "incoming"}
      grouped={grouped}
      animateEntrance={entering}
      bubbleProps={{ className: failed ? "ring-1 ring-destructive/48" : undefined }}
      footer={groupEnd || failed ? (
        <>
          {/* The words beside the icon say the same, so it is not read out twice. */}
          {outbound ? <span aria-hidden="true" className="contents"><ChatDeliveryIndicator status={deliveryOf[message.status]} label={statusWords[message.status]} /></span> : null}
          <time dateTime={message.createdAt}>{outbound ? `${statusWords[message.status]} · ${time}` : time}</time>
        </>
      ) : undefined}
    >
      <MessageBody message={message} />
    </ChatMessage>
  );
}

function AppointmentCard({ appointment }: { appointment: ThreadAppointment | null }) {
  const t = useTerms();
  if (!appointment) {
    return <p className="border-b px-3 py-2 text-xs text-muted-foreground">No upcoming {t.appointment} for this {t.customer}.</p>;
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b bg-muted/40 px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-sm font-medium">{appointmentDateTime(appointment.startsAt)}</p>
          <p className="truncate text-xs text-muted-foreground">{appointment.serviceName} with {appointment.practitionerName}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="outline">{words(appointment.status)}</Badge>
        <Link href={`/appointments/${appointment.id}`} className="inline-flex min-h-8 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">Open {t.appointment}</Link>
      </div>
    </div>
  );
}

function Messages({ messages, scroll }: { messages: ThreadMessage[]; scroll: ChatScrollController }) {
  // Messages already there when the thread opened appear without the entrance animation; later arrivals animate.
  // A thread opens at its latest message: the scroll starts pinned to the bottom.
  const [initial] = useState(() => new Set(messages.map((message) => message.id)));

  const days: ThreadMessage[][] = [];
  for (const message of messages) {
    const last = days[days.length - 1];
    if (last && dayKey(last[0].createdAt) === dayKey(message.createdAt)) last.push(message);
    else days.push([message]);
  }

  return (
    <ChatConversation scroll={scroll} label="Messages" jumpLabel="Jump to latest" live="polite" contentClassName="flex flex-col gap-4 pt-2">
      {days.map((day) => (
        <section key={dayKey(day[0].createdAt)} aria-label={dayHeading(day[0].createdAt)} className="flex flex-col gap-1.5">
          <ChatDatePill>{dayHeading(day[0].createdAt)}</ChatDatePill>
          {day.map((message, index) => {
            const previous = day[index - 1];
            const next = day[index + 1];
            const joins = (a: ThreadMessage, b: ThreadMessage) => a.direction === b.direction && new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() <= groupWindowMs;
            return (
              <InboxMessage
                key={message.id}
                message={message}
                grouped={previous !== undefined && joins(previous, message)}
                groupEnd={next === undefined || !joins(message, next)}
                entering={!initial.has(message.id)}
              />
            );
          })}
        </section>
      ))}
    </ChatConversation>
  );
}

function Header({ detail, onBack }: { detail: ThreadDetail; onBack: (() => void) | null }) {
  const { thread } = detail;
  const access = useStaffAccess();
  const assign = useAssign(thread.id);
  const mine = access.userId !== null && thread.assignedToUserId === access.userId;
  const change = (userId: string | null) => assign.mutate(userId, {
    onError: (error) => toastManager.add({ title: "Could not change who has this", description: error.message, type: "error" }),
  });
  return (
    <header className="flex items-center gap-2 border-b px-3 py-2">
      {onBack ? <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to conversations"><ArrowLeft aria-hidden="true" /></Button> : null}
      <div className="min-w-0 flex-1">
        <h2 className="truncate font-heading text-base font-semibold">
          <Link href={`/patients?patient=${encodeURIComponent(thread.patientId)}`} className="underline-offset-4 hover:underline">{thread.patientName}</Link>
        </h2>
        <p className="text-xs text-muted-foreground">
          {thread.assignedToUserId === null ? "Not assigned" : mine ? "Assigned to you" : "Assigned to a colleague"}
        </p>
      </div>
      <Badge variant="outline">WhatsApp</Badge>
      {mine ? (
        <Button variant="outline" size="sm" onClick={() => change(null)} disabled={assign.isPending}>Unassign</Button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => change(access.userId)} disabled={assign.isPending || access.userId === null}><UserRound aria-hidden="true" /> Assign to me</Button>
      )}
    </header>
  );
}

export function InboxConversation({ threadId, onBack }: { threadId: string; onBack: (() => void) | null }) {
  const t = useTerms();
  const query = useThread(threadId);
  const { mutate: markRead } = useMarkRead();
  const markedFor = useRef("");
  const unread = query.data?.thread.unreadCount ?? 0;
  const messageCount = query.data?.messages.length ?? 0;
  const scroll = useChatScroll({ active: messageCount > 0, itemCount: messageCount, layoutKey: threadId });
  const { atBottomRef } = scroll;

  // Opening a thread marks it read; a message that lands while it is open is marked on the next refresh.
  useEffect(() => {
    const token = `${threadId}:${unread}`;
    const firstOpen = !markedFor.current.startsWith(`${threadId}:`);
    if (!firstOpen && unread === 0) return;
    if (markedFor.current === token) return;
    markedFor.current = token;
    markRead(threadId);
  }, [threadId, unread, markRead]);

  if (query.isPending) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-3">
        {onBack ? <Button variant="ghost" size="sm" className="self-start" onClick={onBack}><ArrowLeft aria-hidden="true" /> Back</Button> : null}
        <ChatLoadingState label="Loading conversation" />
      </div>
    );
  }
  if (!query.data) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-3">
        {onBack ? <Button variant="ghost" size="sm" className="self-start" onClick={onBack}><ArrowLeft aria-hidden="true" /> Back</Button> : null}
        <Alert variant="error">
          <AlertTitle>This conversation could not be loaded</AlertTitle>
          <AlertDescription>
            <p>It may have been removed, or the connection dropped.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}>Retry</Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const detail = query.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header detail={detail} onBack={onBack} />
      {query.isError ? (
        <ChatStatusBar
          title="Could not refresh"
          description="Showing what loaded last."
          action={<Button variant="outline" size="sm" onClick={() => void query.refetch()}>Retry</Button>}
        />
      ) : null}
      <AppointmentCard appointment={detail.nextAppointment} />
      {detail.messages.length ? (
        <Messages key={threadId} messages={detail.messages} scroll={scroll} />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <ChatEmptyState icon={<MessageSquare aria-hidden="true" />} title="No messages yet" description={`No messages from this ${t.customer} yet.`} />
        </div>
      )}
      {/* As in the coss chat demo, your own message brings the conversation down to it even if you had scrolled up. */}
      <InboxComposer detail={detail} onSend={() => { atBottomRef.current = true; }} />
    </div>
  );
}
