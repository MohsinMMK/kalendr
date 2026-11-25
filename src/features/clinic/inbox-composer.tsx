"use client";

import { useId, useRef, useState } from "react";
import { ArrowUp, Send } from "lucide-react";

import { OptionSelect } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Composer,
  ComposerActionGroup,
  ComposerActions,
  ComposerInput,
  ComposerSubmit,
  type ComposerValue,
  getComposerText,
} from "@/components/ui/composer";
import { useMediaQuery } from "@/hooks/use-media-query";
import { toastManager } from "@/components/ui/toast";
import type { ReplyInput, ThreadDetail } from "@/lib/inbox-contracts";

import { useSendReply } from "./inbox-api";

const maxLength = 1000;

/**
 * The reply box. Inside WhatsApp's 24-hour window staff type freely; after it, WhatsApp only
 * delivers approved templates, so the box is replaced by a list of them and the reason why.
 */
export function InboxComposer({ detail, onSend }: { detail: ThreadDetail; onSend?: () => void }) {
  const { thread, replyTemplates, nextAppointment } = detail;
  const send = useSendReply(thread.id);
  const [draft, setDraft] = useState<ComposerValue>([]);
  const hintId = useId();
  const touchInput = useMediaQuery({ pointer: "coarse" });
  const length = getComposerText(draft).length;
  const [templateKey, setTemplateKey] = useState("");
  const [problem, setProblem] = useState("");
  // One key per message being written: a double click or a retry after a dropped connection can't send it twice.
  const idempotencyKey = useRef(crypto.randomUUID());

  const template = replyTemplates.find((item) => item.key === templateKey);

  function submit(input: ReplyInput) {
    setProblem("");
    onSend?.();
    send.mutate({ input, key: idempotencyKey.current }, {
      onSuccess: () => {
        idempotencyKey.current = crypto.randomUUID();
        setDraft([]);
        setTemplateKey("");
        toastManager.add({ title: "Message queued", description: "It goes out in a few seconds.", type: "success" });
      },
      onError: (error) => setProblem(error.message),
    });
  }

  function sendText(raw: string) {
    const body = raw.trim();
    if (!body || send.isPending) return;
    submit({ kind: "text", body });
  }

  function sendTemplate() {
    if (!template || !nextAppointment || send.isPending) return;
    submit({ kind: "template", templateKey: template.key, appointmentId: nextAppointment.id });
  }

  // One status region for send failures, always mounted so a screen reader hears the message when it appears.
  const status = (
    <div role="status" aria-live="polite" className={problem ? undefined : "sr-only"}>
      {/* The region announces it; the Alert's own role="alert" would read it a second time. */}
      {problem ? <Alert variant="error" role="none"><AlertDescription>{problem}</AlertDescription></Alert> : null}
    </div>
  );

  if (thread.windowOpen) {
    return (
      <div className="flex flex-col gap-2 border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
        {status}
        <Composer
          value={draft}
          onValueChange={setDraft}
          onSubmit={(value) => sendText(getComposerText(value))}
          submitDisabled={send.isPending}
          submitOnEnter="desktop"
          layout="adaptive"
          className="[--composer-max-rows:4] md:[--composer-max-rows:6] md:[--composer-min-rows:2]"
        >
          <ComposerInput
            aria-describedby={touchInput ? undefined : hintId}
            placeholder="Write a reply"
            render={<textarea id="inbox-reply" aria-label={`Reply to ${thread.patientName}`} maxLength={maxLength} />}
          />
          <ComposerActions>
            <ComposerActionGroup align="end">
              <ComposerSubmit
                render={
                  <Button size="icon" className="rounded-full before:rounded-full" aria-label="Send">
                    {send.isPending ? <Spinner aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
                  </Button>
                }
              />
            </ComposerActionGroup>
          </ComposerActions>
        </Composer>
        <p className="flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
          <span>{length} / {maxLength}</span>
          {touchInput ? null : <span id={hintId}>Enter sends, Shift+Enter adds a line.</span>}
        </p>
      </div>
    );
  }

  const canSendTemplate = replyTemplates.length > 0 && nextAppointment !== null;
  return (
    <form className="flex flex-col gap-2 border-t p-3" onSubmit={(event) => { event.preventDefault(); sendTemplate(); }}>
      {status}
      <p className="text-sm">
        It&apos;s been more than 24 hours since {thread.patientName} wrote, so WhatsApp only allows approved messages.
        {canSendTemplate ? " Pick one to send." : " There is no upcoming booking to send one about, so wait for them to write again."}
      </p>
      {canSendTemplate ? (
        <div className="flex items-center gap-2">
          <OptionSelect
            className="min-w-0 flex-1"
            aria-label="Approved message"
            placeholder="Choose an approved message"
            value={templateKey}
            onValueChange={setTemplateKey}
            options={replyTemplates.map((item) => ({ value: item.key, label: item.label }))}
          />
          <Button type="submit" disabled={!template || send.isPending}>
            {send.isPending ? <Spinner aria-hidden="true" /> : <Send aria-hidden="true" />} Send
          </Button>
        </div>
      ) : null}
    </form>
  );
}
