"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { MessageSquareIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { ActionBar } from "@/components/action-bar";
import { OptionSelect } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerDescription, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Meter, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from "@/components/ui/meter";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { requestBillingSection } from "@/features/billing/billing-navigation";
import { useTerms } from "@/features/terms/business-profile-context";
import {
  assistantHandoffLabels, assistantSettingsSchema, assistantToneLabels, type AssistantSettingsInput,
} from "@/lib/assistant-contracts";

import { StaffApiError } from "../queries/http";
import { useAssistantSettings, useHandoffAction, useHandoffChat, useHandoffs, useSaveAssistantSettings } from "./queries";

const retentionOptions = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "6 months" },
  { value: "365", label: "1 year" },
];

/** A dropdown whose choices each say what they mean, so the owner does not have to guess from a one-word label. */
function RichSelect<T extends string>({ value, onChange, labels, id }: { value: T; onChange: (value: T) => void; labels: Record<T, { label: string; description: string }>; id: string }) {
  const keys = Object.keys(labels) as T[];
  return (
    <Select value={value} onValueChange={(next) => { const match = keys.find((key) => key === next); if (match) onChange(match); }} items={keys.map((key) => ({ value: key, label: labels[key].label }))}>
      <SelectTrigger id={id} size="lg"><SelectValue /></SelectTrigger>
      <SelectPopup>
        {keys.map((key) => (
          <SelectItem key={key} value={key}>
            <span className="flex flex-col">
              <span className="font-medium">{labels[key].label}</span>
              <span className="text-muted-foreground text-xs">{labels[key].description}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function ToggleRow({ id, title, description, checked, onChange, disabled }: { id: string; title: string; description: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <Label htmlFor={id} className="font-medium">{title}</Label>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/** The owner's choices for the booking assistant (feature 30), and the chats it has passed to a person. */
export function AssistantSettings() {
  const t = useTerms();
  const settings = useAssistantSettings();
  const save = useSaveAssistantSettings();
  const form = useForm<AssistantSettingsInput>({
    resolver: zodResolver(assistantSettingsSchema),
    defaultValues: { enabledWeb: false, enabledWhatsapp: false, enabledSms: false, tone: "friendly", handoffRule: "balanced", businessFacts: "", retentionDays: 90 },
  });
  const { errors, isDirty } = form.formState;

  useEffect(() => {
    if (!settings.data) return;
    const { enabledWeb, enabledWhatsapp, enabledSms, tone, handoffRule, businessFacts, retentionDays } = settings.data;
    form.reset({ enabledWeb, enabledWhatsapp, enabledSms, tone, handoffRule, businessFacts, retentionDays });
  }, [settings.data, form]);

  if (settings.isPending) return <div className="flex flex-col gap-3" role="status" aria-label="Loading the assistant settings"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (settings.isError) {
    return <Alert variant="error"><AlertDescription><p>{settings.error.message}</p><Button size="sm" variant="outline" className="mt-2" onClick={() => void settings.refetch()}>Try again</Button></AlertDescription></Alert>;
  }
  const view = settings.data;

  async function submit(values: AssistantSettingsInput): Promise<void> {
    try {
      await save.mutateAsync({ ...values, version: view.version });
      toastManager.add({ title: "Assistant settings saved", type: "success" });
    } catch (error: unknown) {
      if (error instanceof StaffApiError && error.code === "plan_limit") {
        toastManager.add({ title: error.message, type: "error" });
        requestBillingSection();
      } else if (error instanceof StaffApiError && Object.keys(error.fieldErrors).length > 0) {
        for (const [path, messages] of Object.entries(error.fieldErrors)) form.setError(path as keyof AssistantSettingsInput, { type: "server", message: messages[0] ?? "Check this." });
      } else {
        toastManager.add({ title: error instanceof Error ? error.message : "The settings could not be saved.", type: "error" });
      }
    }
  }

  const used = Math.min(view.usedTokens, view.tokenCap);
  return (
    <div className="flex flex-col gap-4">
      {!view.available ? (
        <Alert variant="warning">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>The assistant is part of the Growth plan and above.</span>
            <Button size="sm" variant="outline" onClick={() => requestBillingSection()}>See plans</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {view.mode === "off" ? (
        <Alert variant="info"><AlertDescription>The assistant&apos;s model is not connected on this server yet, so {t.customers} are sent to your booking page. Whoever runs this installation adds the Anthropic key.</AlertDescription></Alert>
      ) : null}
      {view.mode === "fake" ? (
        <Alert variant="info"><AlertDescription>This server runs the built-in test model, not a real one. It is for trying things out only.</AlertDescription></Alert>
      ) : null}

      <form noValidate onSubmit={(event) => { void form.handleSubmit(submit)(event); }} className="flex flex-col gap-4">
        <Frame>
          <FrameHeader>
            <FrameTitle>Where it answers</FrameTitle>
            <FrameDescription>It always says it is an automated assistant, and a person can take over at any time.</FrameDescription>
          </FrameHeader>
          <FramePanel className="flex flex-col divide-y py-1">
            <Controller control={form.control} name="enabledWeb" render={({ field }) => <ToggleRow id="assistant-web" title="Chat on your booking page" description={`A chat button where ${t.customers} choose a time.`} checked={field.value} onChange={field.onChange} disabled={!view.available && !field.value} />} />
            <Controller control={form.control} name="enabledWhatsapp" render={({ field }) => <ToggleRow id="assistant-whatsapp" title="WhatsApp" description={`Answers ${t.customers} who message you. WhatsApp needs to be connected under WhatsApp and text messages.`} checked={field.value} onChange={field.onChange} disabled={!view.available && !field.value} />} />
            <ToggleRow id="assistant-sms" title="Text messages" description="Two-way text messages are not connected yet." checked={false} onChange={() => undefined} disabled />
          </FramePanel>
        </Frame>

        <Frame>
          <FrameHeader>
            <FrameTitle>How it talks</FrameTitle>
            <FrameDescription>It answers in the language the {t.customer} writes in.</FrameDescription>
          </FrameHeader>
          <FramePanel className="flex flex-col gap-4">
            <Field>
              <FieldLabel htmlFor="assistant-tone">Tone</FieldLabel>
              <Controller control={form.control} name="tone" render={({ field }) => <RichSelect id="assistant-tone" value={field.value} onChange={field.onChange} labels={assistantToneLabels} />} />
            </Field>
            <Field>
              <FieldLabel htmlFor="assistant-handoff">Passing to a person</FieldLabel>
              <Controller control={form.control} name="handoffRule" render={({ field }) => <RichSelect id="assistant-handoff" value={field.value} onChange={field.onChange} labels={assistantHandoffLabels} />} />
              <FieldDescription>It always passes on questions about health, money or the law, and anything that sounds like an emergency.</FieldDescription>
            </Field>
            <Field invalid={Boolean(errors.businessFacts)}>
              <FieldLabel htmlFor="assistant-facts">What it should know</FieldLabel>
              <Textarea id="assistant-facts" rows={6} maxLength={3000} placeholder={"We close for lunch from 1 to 2 pm.\nParking is free behind the building.\nBring your previous reports."} {...form.register("businessFacts")} />
              <FieldDescription>Hours, parking, what to bring, prices you want it to quote. It only says what is written here and what your {t.services} show. Your {t.customers} see it as part of its answers.</FieldDescription>
              <FieldError match={Boolean(errors.businessFacts)}>{errors.businessFacts?.message}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="assistant-retention">Keep chats for</FieldLabel>
              <Controller control={form.control} name="retentionDays" render={({ field }) => <OptionSelect id="assistant-retention" value={String(field.value)} onValueChange={(value) => field.onChange(Number(value))} options={retentionOptions} />} />
              <FieldDescription>Chats are stored sealed, included in a {t.customer}&apos;s data export, and removed when they ask to be erased.</FieldDescription>
            </Field>
          </FramePanel>
          <FrameFooter className="flex justify-end">
            <Button type="submit" size="lg" disabled={!isDirty || save.isPending}>
              {save.isPending ? <Spinner aria-hidden="true" /> : null}
              Save
            </Button>
          </FrameFooter>
        </Frame>
      </form>

      <Frame>
        <FrameHeader>
          <FrameTitle>This month</FrameTitle>
          <FrameDescription>The assistant stops and points {t.customers} to your booking page when the allowance is used up.</FrameDescription>
        </FrameHeader>
        <FramePanel>
          <Meter value={used} max={view.tokenCap} aria-label="Assistant allowance used this month">
            <div className="flex items-center justify-between"><MeterLabel>Allowance used</MeterLabel><MeterValue>{() => `${Math.round((used / view.tokenCap) * 100)}%`}</MeterValue></div>
            <MeterTrack><MeterIndicator /></MeterTrack>
          </Meter>
        </FramePanel>
      </Frame>

      <HandoffList />
    </div>
  );
}

const channelLabel: Record<string, string> = { web: "Website", whatsapp: "WhatsApp", sms: "Text" };
const reasonLabel: Record<string, string> = {
  asked_for_person: "Asked for a person", upset: "Seemed upset", cannot_help: "Could not help", advice: "Asked for advice", emergency: "Possible emergency", other: "Other",
};

/** Chats the assistant passed on. Read them, hand them back, or close them. */
function HandoffList() {
  const t = useTerms();
  const handoffs = useHandoffs();
  const act = useHandoffAction();
  const [openId, setOpenId] = useState<string | null>(null);
  const chat = useHandoffChat(openId);

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Waiting for a person</FrameTitle>
        <FrameDescription>Chats the assistant passed on. WhatsApp chats are also in your inbox.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col divide-y py-1">
        {handoffs.isPending ? <Skeleton className="my-3 h-12 w-full" /> : null}
        {handoffs.isError ? (
          <div className="py-3"><Alert variant="error"><AlertDescription><p>{handoffs.error.message}</p><Button size="sm" variant="outline" className="mt-2" onClick={() => void handoffs.refetch()}>Try again</Button></AlertDescription></Alert></div>
        ) : null}
        {handoffs.data && handoffs.data.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessageSquareIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>Nothing waiting</EmptyTitle>
              <EmptyDescription>When the assistant passes a chat to your team, it shows here with a short summary.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {handoffs.data?.map((item) => (
          <div key={item.id} className="flex flex-col gap-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <UserRoundIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">{item.customerName ?? `A ${t.customer} on the website`}</span>
              <Badge variant="outline">{channelLabel[item.channel] ?? item.channel}</Badge>
              <Badge variant={item.reason === "emergency" ? "error" : "warning"}>{reasonLabel[item.reason ?? "other"] ?? "Other"}</Badge>
            </div>
            <p className="text-muted-foreground text-sm">{item.summary}</p>
            <ActionBar
              actions={[{ id: "read", label: "Read the chat", variant: "outline", pinned: true, onSelect: () => setOpenId(item.id) }]}
              menu={[
                { id: "back", label: "Hand back to the assistant", onSelect: () => act.mutate({ id: item.id, action: "hand_back" }, handoffToasts("Handed back to the assistant")) },
                { id: "close", label: "Close this chat", onSelect: () => act.mutate({ id: item.id, action: "close" }, handoffToasts("Chat closed")) },
              ]}
            />
          </div>
        ))}
      </FramePanel>

      <Drawer position="right" open={openId !== null} onOpenChange={(next) => { if (!next) setOpenId(null); }}>
        <DrawerPopup showCloseButton>
          <DrawerHeader>
            <DrawerTitle>Chat</DrawerTitle>
            <DrawerDescription>What was said with the assistant. To answer, use WhatsApp or call the {t.customer}.</DrawerDescription>
          </DrawerHeader>
          <DrawerPanel>
            {chat.isPending ? <Skeleton className="h-24 w-full" /> : null}
            {chat.isError ? <Alert variant="error"><AlertDescription>{chat.error.message}</AlertDescription></Alert> : null}
            <div className="flex flex-col gap-2">
              {chat.data?.lines.map((line, index) => (
                <div key={index} className={`max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${line.role === "customer" ? `self-end bg-primary text-primary-foreground` : `self-start bg-muted`}`}>{line.text}</div>
              ))}
            </div>
          </DrawerPanel>
        </DrawerPopup>
      </Drawer>
    </Frame>
  );
}

function handoffToasts(done: string) {
  return {
    onSuccess: () => { toastManager.add({ title: done, type: "success" }); },
    onError: (error: Error) => { toastManager.add({ title: error.message || "That did not work. Try again.", type: "error" }); },
  };
}
