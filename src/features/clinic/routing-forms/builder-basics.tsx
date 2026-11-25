"use client";

import { Copy } from "lucide-react";

import { TextField, TextareaField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { routingLimits } from "@/lib/routing-forms";

import { publicAddress, type WorkingDraft } from "./builder-state";

export function BasicsSection({ draft, errors, disabled, businessSlug, live, onChange, onCopy }: {
  draft: WorkingDraft;
  errors: Record<string, string>;
  disabled: boolean;
  businessSlug: string;
  live: boolean;
  onChange: (patch: Partial<Pick<WorkingDraft, "name" | "slug" | "intro">>) => void;
  onCopy: () => void;
}) {
  const address = publicAddress(businessSlug, draft.slug);
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>About this form</FrameTitle>
        <FrameDescription>The name is for you. The address and the intro are what customers see.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <TextField label="Form name" value={draft.name} maxLength={routingLimits.name} error={errors.name} disabled={disabled} onChange={(event) => onChange({ name: event.target.value })} />
        <div className="flex flex-col gap-2">
          <TextField label="Address ending" hint={`The full address is ${address}${live ? "" : ". It opens once you publish."}`} value={draft.slug} maxLength={routingLimits.slug} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            error={errors.slug} disabled={disabled} onChange={(event) => onChange({ slug: event.target.value.toLowerCase().replace(/\s+/g, "-") })} />
          <div><Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={!draft.slug} onClick={onCopy}><Copy aria-hidden="true" /> Copy link</Button></div>
        </div>
        <TextareaField label="Intro" optional hint="A line or two shown above the questions." value={draft.intro} maxLength={300} error={errors.intro} disabled={disabled} onChange={(event) => onChange({ intro: event.target.value })} />
      </FramePanel>
    </Frame>
  );
}
