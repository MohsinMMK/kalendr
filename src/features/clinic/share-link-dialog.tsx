"use client";

import { CheckCircle2, Copy, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";
import type { GoLiveCheck, StepTarget } from "@/lib/onboarding-steps";

import type { OnboardingState } from "./queries/onboarding";

/**
 * "Share your booking link" (feature 11, step 7), with the go-live check in front of it: the short list of things that
 * would embarrass the owner if a customer found them. Every item says what is wrong and has one button to fix it. The owner
 * can copy the link anyway; the check informs, it does not block.
 */
export function ShareLinkDialog({ open, onOpenChange, state, onFix, onShared }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: OnboardingState;
  onFix: (target: StepTarget) => void;
  onShared: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { checks, clear } = state.goLive;
  const problems = checks.filter((check) => !check.ok);

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.bookingUrl);
      setCopied(true);
      onShared();
    } catch {
      toastManager.add({ title: "Copy failed", description: "Select the link and copy it by hand.", type: "error" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setCopied(false); onOpenChange(next); }}>
      <DialogPopup className="sm:max-w-md" bottomStickOnMobile>
        <DialogHeader>
          <DialogTitle>Share your booking link</DialogTitle>
          <DialogDescription>{clear ? "Everything looks ready. Put this link where your customers will find it." : "Fix these first, so the first person who opens your link sees a page you are proud of."}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <ul aria-label="Before you share" className="flex flex-col gap-2">
            {checks.map((check: GoLiveCheck) => (
              <li key={check.id} className="flex items-start gap-2 text-sm">
                {check.ok
                  ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Fine" />
                  : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Needs attention" />}
                <span className="min-w-0 flex-1">{check.message}</span>
                {check.ok ? null : <Button size="xs" variant="outline" onClick={() => onFix(check.fix)}>Fix</Button>}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-xs">Your booking link</p>
            <p className="rounded-lg bg-muted px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">{state.bookingUrl}</p>
          </div>
        </DialogPanel>
        <DialogFooter className="flex-row flex-nowrap justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Not yet</Button>
          <Button variant={problems.length > 0 ? "outline" : "default"} onClick={() => void copy()}>
            <Copy aria-hidden="true" />{copied ? "Copied" : problems.length > 0 ? "Copy it anyway" : "Copy link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
