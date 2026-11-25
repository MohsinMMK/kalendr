"use client";

import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { heardFromOptions, type HeardFrom } from "@/lib/heard-from";
import { isClinicalBusinessType } from "@/lib/business-types";

import { useBusinessProfile, useTerms } from "../terms/business-profile-context";

/** "How did you hear about us?", asked once after booking. One tap answers; Skip closes it. */
export function HeardFromCard({ manageToken }: { manageToken: string }) {
  const t = useTerms();
  const clinical = isClinicalBusinessType(useBusinessProfile().businessType);
  const [state, setState] = useState<"asking" | "saving" | "failed" | "done">("asking");
  const [choice, setChoice] = useState<HeardFrom>();

  async function answer(value: HeardFrom) {
    setChoice(value);
    setState("saving");
    try {
      const response = await fetch(`/api/public/appointments/${encodeURIComponent(manageToken)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ heardFrom: value }),
      });
      setState(response.ok ? "done" : "failed");
    } catch {
      setState("failed");
    }
  }

  if (state === "done") {
    return (
      <p role="status" className="flex items-center justify-center gap-2 text-muted-foreground text-sm">
        <CheckCircle2 aria-hidden="true" className="size-4 text-success-foreground" />
        {choice ? `Thanks for telling us. It helps the ${t.business} reach more people like you.` : "No problem."}
      </p>
    );
  }

  return (
    <Card>
      <CardHeader className="p-5 pb-0">
        <CardTitle className="text-base">How did you hear about us?</CardTitle>
        <CardDescription>Optional. One tap is enough.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-3 p-5">
        <div role="group" aria-label="How did you hear about us?" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {heardFromOptions({ clinical }).map((option) => (
            <Button
              key={option.value}
              variant="outline"
              className="h-auto min-h-11 justify-start whitespace-normal text-start"
              disabled={state === "saving"}
              loading={state === "saving" && choice === option.value}
              onClick={() => void answer(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {state === "failed" ? (
            <p role="alert" className="text-destructive-foreground text-sm">That didn&apos;t save. Try again.</p>
          ) : (
            <span />
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={state === "saving"}
            onClick={() => {
              setChoice(undefined);
              setState("done");
            }}
          >
            Skip
          </Button>
        </div>
      </CardPanel>
    </Card>
  );
}
