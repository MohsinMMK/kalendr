"use client";

import { CheckCircle2, StarIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { isClinicalBusinessType } from "@/lib/business-types";
import type { ReviewState } from "@/lib/reviews";
import { cn } from "@/lib/utils";

import { Stars } from "../business/ratings";
import { useBusinessProfile, useTerms } from "../terms/business-profile-context";

const COMMENT_LIMIT = 1000;
const ratingWords = ["", "Poor", "Fair", "Good", "Very good", "Excellent"] as const;

type Phase = "loading" | "hidden" | "viewing" | "editing";

/**
 * "How was your appointment?" on the manage page of a finished visit. One rating and an optional comment,
 * which the customer can change for 60 days. Nothing shows if the visit isn't finished or the window has passed.
 */
export function ReviewCard({ manageToken, personName }: { manageToken: string; personName?: string }) {
  const t = useTerms();
  const clinical = isClinicalBusinessType(useBusinessProfile().businessType);
  const endpoint = `/api/public/appointments/${encodeURIComponent(manageToken)}/review`;

  const [phase, setPhase] = useState<Phase>("loading");
  const [state, setState] = useState<ReviewState | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error("unavailable");
        const loaded = ((await response.json()) as { data: ReviewState }).data;
        if (cancelled) return;
        setState(loaded);
        if (loaded.review) {
          setRating(loaded.review.rating);
          setComment(loaded.review.comment ?? "");
          setPhase("viewing");
        } else {
          setPhase(loaded.open ? "editing" : "hidden");
        }
      } catch {
        if (!cancelled) setPhase("hidden");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint]);

  async function save() {
    if (rating < 1) {
      setError("Choose a star rating first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ rating, comment: comment.trim() || undefined }),
      });
      const body = (await response.json().catch(() => null)) as { data?: ReviewState; error?: { message?: string } } | null;
      if (!response.ok || !body?.data) {
        setError(body?.error?.message ?? "That didn't save. Try again.");
        return;
      }
      setState(body.data);
      setJustSaved(true);
      setPhase("viewing");
    } catch {
      setError("That didn't save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (phase === "loading" || phase === "hidden" || !state) return null;

  if (phase === "viewing" && state.review) {
    return (
      <Card>
        <CardHeader className="p-5 pb-0">
          <CardTitle className="text-base">Your review</CardTitle>
          {justSaved ? (
            <CardDescription role="status" className="flex items-center gap-1.5">
              <CheckCircle2 aria-hidden="true" className="size-4 text-success-foreground" />
              Thanks. Your review helps others choose.
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardPanel className="flex flex-col gap-3 p-5">
          <div className="flex items-center gap-2">
            <Stars rating={state.review.rating} className="[&_svg]:size-5" />
            <span className="text-muted-foreground text-sm">{ratingWords[state.review.rating]}</span>
          </div>
          {state.review.comment ? <p className="whitespace-pre-line break-words text-sm">{state.review.comment}</p> : null}
          {state.open ? (
            <Button
              variant="outline"
              className="w-full sm:w-fit"
              onClick={() => {
                setJustSaved(false);
                setPhase("editing");
              }}
            >
              Edit review
            </Button>
          ) : null}
        </CardPanel>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="p-5 pb-0">
        <CardTitle className="text-base">How was your {t.appointment}?</CardTitle>
        <CardDescription>
          {personName ? `Rate your ${t.appointment} with ${personName}. ` : ""}
          Three stars and up show on the business page with your first name and last initial. One or two stars go to the business privately.
        </CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-2">
          <RadioGroupPrimitive
            aria-label="Rating"
            value={rating ? String(rating) : ""}
            onValueChange={(value) => {
              setRating(Number(value));
              setError(null);
            }}
            className="flex items-center gap-1"
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <RadioPrimitive.Root
                key={value}
                value={String(value)}
                aria-label={`${value} ${value === 1 ? "star" : "stars"}`}
                className="inline-flex size-11 items-center justify-center rounded-lg outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <StarIcon
                  aria-hidden="true"
                  className={cn("size-7", value <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground/50")}
                />
              </RadioPrimitive.Root>
            ))}
          </RadioGroupPrimitive>
          <p aria-live="polite" className="min-h-5 text-muted-foreground text-sm">
            {rating ? ratingWords[rating] : "Tap a star"}
          </p>
        </div>

        <Field>
          <FieldLabel>Tell others about it (optional)</FieldLabel>
          <Textarea
            value={comment}
            maxLength={COMMENT_LIMIT}
            rows={4}
            onChange={(event) => setComment(event.target.value)}
          />
          <FieldDescription className="flex flex-wrap justify-between gap-x-3">
            <span>{clinical ? "Please don't include health details." : "Keep it about your experience."}</span>
            <span>
              {comment.length}/{COMMENT_LIMIT}
            </span>
          </FieldDescription>
        </Field>

        {error ? (
          <p role="alert" className="text-destructive-foreground text-sm">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button className="w-full sm:w-fit" loading={saving} onClick={() => void save()}>
            {state.review ? "Save changes" : "Send review"}
          </Button>
          {state.review ? (
            <Button variant="ghost" className="w-full sm:w-fit" disabled={saving} onClick={() => setPhase("viewing")}>
              Cancel
            </Button>
          ) : null}
        </div>
      </CardPanel>
    </Card>
  );
}
