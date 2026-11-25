"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";

import { portalPrivacyApi, type PrivacyNoticeText } from "./privacy-client";

export type NoticeLanguage = "en" | "hi";

export const noticeLanguageOptions: { value: NoticeLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी" },
];

/** Switches the notice between English and Hindi. */
export function NoticeLanguageSwitch({ value, onChange }: { value: NoticeLanguage; onChange: (next: NoticeLanguage) => void }) {
  return (
    <SegmentedControl
      size="sm"
      render={<ToggleGroupPrimitive aria-label="Notice language" value={[value]} onValueChange={(next: string[]) => { if (next[0]) onChange(next[0] as NoticeLanguage); }} />}
    >
      {noticeLanguageOptions.map((option) => (
        <SegmentedControlItem key={option.value} render={<TogglePrimitive value={option.value} />} lang={option.value}>{option.label}</SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}

/** The full notice: what each choice means, then the written text. */
export function NoticeBody({ notice }: { notice: PrivacyNoticeText }) {
  return (
    <div className="flex flex-col gap-4 text-sm" lang={notice.language}>
      <dl className="flex flex-col gap-3">
        {Object.entries(notice.purposes).map(([purpose, entry]) => (
          <div key={purpose}>
            <dt className="font-medium">{entry.label}</dt>
            <dd className="text-muted-foreground">{entry.text}</dd>
          </div>
        ))}
      </dl>
      {notice.paragraphs.map((paragraph) => <p key={paragraph} className="text-muted-foreground">{paragraph}</p>)}
      <p className="text-xs text-muted-foreground">Notice version {notice.version}{notice.isDefault ? ". This is Kalendr's standard wording." : ""}</p>
    </div>
  );
}

/** A button that opens the full text of a notice that has already been loaded. */
export function NoticeDialog({ notice, language, onLanguageChange, label = "Read the full notice", variant = "outline" }: {
  notice: PrivacyNoticeText;
  language: NoticeLanguage;
  onLanguageChange: (next: NoticeLanguage) => void;
  label?: string;
  variant?: "outline" | "ghost" | "link";
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant={variant} size="sm" className="self-start" />}>
        <FileText aria-hidden="true" />
        {label}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{notice.title}</DialogTitle>
          <DialogDescription>Version {notice.version}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4 pb-6">
          <NoticeLanguageSwitch value={language} onChange={onLanguageChange} />
          <NoticeBody notice={notice} />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The slug used before anyone has chosen a business (sign-in): the server answers with the standard notice. */
export const generalNoticeSlug = "kalendr";

/**
 * A short line about how information is used, with the notice version and a link to the full text.
 * Fetches the public notice itself and never blocks the screen it sits on: if it cannot load, the screen shows a quiet retry.
 */
export function PrivacyNoticeLink({ clinicSlug, language = "en" }: { clinicSlug: string; language?: NoticeLanguage }) {
  const [chosen, setChosen] = useState<NoticeLanguage>(language);
  const [notice, setNotice] = useState<PrivacyNoticeText | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    setState("loading");
    try {
      const next = await portalPrivacyApi.notice(clinicSlug, chosen);
      if (signal.cancelled) return;
      setNotice(next);
      setState("ready");
    } catch {
      if (!signal.cancelled) setState("error");
    }
  }, [clinicSlug, chosen]);

  useEffect(() => {
    const signal = { cancelled: false };
    queueMicrotask(() => { if (!signal.cancelled) void load(signal); });
    return () => { signal.cancelled = true; };
  }, [load, attempt]);

  if (state === "loading" && !notice) return <Skeleton className="h-10 w-full" aria-hidden="true" />;
  if (state === "error" && !notice) {
    return (
      <p className="flex flex-wrap items-center justify-center gap-x-2 text-xs text-muted-foreground">
        The privacy notice could not be loaded.
        <Button variant="link" size="sm" onClick={() => setAttempt((count) => count + 1)}>Try again</Button>
      </p>
    );
  }
  if (!notice) return null;
  return (
    <div className="flex flex-col items-center gap-1 text-center text-xs text-muted-foreground">
      <p>We use your details to run your bookings. Your choices are in your portal, and you can change them at any time.</p>
      <NoticeDialog notice={notice} language={chosen} onLanguageChange={setChosen} label={`Privacy notice, version ${notice.version}`} variant="ghost" />
    </div>
  );
}
