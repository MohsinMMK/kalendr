"use client";

import { CheckCircle2, StarIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Radio, RadioGroup, RadioGroupPrimitive, RadioPrimitive } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { defaultVisibility, type ReviewVisibility } from "@/lib/reviews";
import type { RatingPageInput, RatingPageState } from "@/lib/rating-page";
import { cn } from "@/lib/utils";

const COMMENT_LIMIT = 1000;
const ratingWords = ["", "Poor", "Fair", "Good", "Very good", "Excellent"] as const;

async function send(token: string, input: RatingPageInput): Promise<RatingPageState> {
  const response = await fetch(`/api/public/ratings/${encodeURIComponent(token)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json().catch(() => null)) as { data?: RatingPageState; error?: { message?: string } } | null;
  if (!response.ok || !body?.data) throw new Error(body?.error?.message ?? "That didn't save. Try again.");
  return body.data;
}

/**
 * The one-tap rating page (feature 51). The first tap records the stars at once. A comment and the choice of who sees it come
 * after, and can be changed for a week. Once the week has passed it only says what the customer answered.
 */
export function RatingPage({ token, initial }: { token: string; initial: RatingPageState }) {
  const [state, setState] = useState(initial);
  const [pending, setPending] = useState<number | null>(null);
  const [comment, setComment] = useState(initial.review?.comment ?? "");
  const [visibility, setVisibility] = useState<ReviewVisibility>(initial.review?.visibility ?? "public");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(rating: number) {
    setPending(rating);
    setError(null);
    try {
      const next = await send(token, { rating });
      setState(next);
      setVisibility(next.review?.visibility ?? defaultVisibility(rating));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't save. Try again.");
    } finally {
      setPending(null);
    }
  }

  async function saveDetails() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setState(await send(token, { rating: state.review?.rating, comment: comment.trim(), visibility }));
      setSaved(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (state.phase === "expired") {
    return (
      <Card><CardHeader className="p-5"><CardTitle className="text-base" render={<h1 />}>This link has run out</CardTitle><CardDescription>Ratings open once a visit is finished, for 60 days. Thank you for thinking of {state.business}.</CardDescription></CardHeader></Card>
    );
  }

  const rating = state.review?.rating ?? 0;
  const shown = pending ?? rating;
  const editable = state.phase === "answered";

  return (
    <Card>
      <CardHeader className="p-5 pb-0">
        <CardTitle className="text-base" render={<h1 />}>{state.review ? `Thanks, you rated ${rating} ${rating === 1 ? "star" : "stars"}` : `How was ${state.service}?`}</CardTitle>
        <CardDescription>{state.review ? `${state.business} sees your rating.` : `Tap a star to rate your visit to ${state.business}.`}</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-4 p-5">
        <div className="flex flex-col gap-2">
          <RadioGroupPrimitive
            aria-label="Rating"
            value={shown ? String(shown) : ""}
            disabled={Boolean(state.review) || pending !== null}
            onValueChange={(value) => void choose(Number(value))}
            className="flex items-center gap-1"
          >
            {[1, 2, 3, 4, 5].map((value) => (
              <RadioPrimitive.Root
                key={value}
                value={String(value)}
                aria-label={`${value} ${value === 1 ? "star" : "stars"}`}
                className="inline-flex size-12 items-center justify-center rounded-lg outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
              >
                <StarIcon aria-hidden="true" className={cn("size-8", value <= shown ? "fill-amber-400 text-amber-400" : "text-muted-foreground/50")} />
              </RadioPrimitive.Root>
            ))}
          </RadioGroupPrimitive>
          <p aria-live="polite" className="min-h-5 text-muted-foreground text-sm">{shown ? ratingWords[shown] : "Tap a star"}</p>
        </div>

        {state.review && editable ? (
          <>
            <Field>
              <FieldLabel>Anything to add? (optional)</FieldLabel>
              <Textarea value={comment} maxLength={COMMENT_LIMIT} rows={4} onChange={(event) => { setComment(event.target.value); setSaved(false); }} />
              <FieldDescription className="flex justify-between"><span>Keep it about your experience.</span><span>{comment.length}/{COMMENT_LIMIT}</span></FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Who can see this?</FieldLabel>
              <RadioGroup value={visibility} onValueChange={(value) => { setVisibility(value === "private" ? "private" : "public"); setSaved(false); }}>
                <label className="flex min-h-11 items-center gap-2 text-sm"><Radio value="public" />Show on the business page</label>
                <label className="flex min-h-11 items-center gap-2 text-sm"><Radio value="private" />Only for the business</label>
              </RadioGroup>
              <FieldDescription>Public ratings show your first name and last initial.</FieldDescription>
            </Field>
            {error ? <p role="alert" className="text-destructive-foreground text-sm">{error}</p> : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Button className="min-h-11 w-full sm:w-fit" loading={busy} onClick={() => void saveDetails()}>Save</Button>
              {saved ? <p role="status" className="flex items-center gap-1 text-sm"><CheckCircle2 aria-hidden="true" className="size-4 text-success" />Saved</p> : null}
            </div>
            {state.editableUntil ? <p className="text-muted-foreground text-xs">You can change your comment until {new Date(state.editableUntil).toLocaleDateString("en-IN", { day: "numeric", month: "long" })}.</p> : null}
          </>
        ) : state.review ? (
          <>
            {state.review.comment ? <p className="whitespace-pre-line break-words text-sm">{state.review.comment}</p> : null}
            <p className="text-muted-foreground text-xs">Your answer is saved. The time to change it has passed.</p>
          </>
        ) : error ? <p role="alert" className="text-destructive-foreground text-sm">{error}</p> : null}
      </CardPanel>
    </Card>
  );
}
