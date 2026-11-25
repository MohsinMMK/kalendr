"use client";

import { MessageSquareQuote, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useTerms } from "@/features/terms/business-profile-context";
import { summarizeRatings, type StaffReview } from "@/lib/reviews";

import { RatingLine, Stars } from "../business/ratings";
import { useCatalogLookups } from "./clinic-catalog";
import { staffMutation, staffQuery } from "./staff-snapshot-provider";

const ALL = "all";
const KINDS = [
  { value: "all", label: "All feedback" },
  { value: "public", label: "On your page" },
  { value: "private", label: "Private feedback" },
  { value: "low", label: "1 or 2 stars" },
] as const;

function reviewDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

/**
 * The Reviews page: every review of the business, newest first. Hiding one takes it off the public
 * page and profiles without changing what the customer wrote; showing it puts it back.
 */
export function ReviewsSettings() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [reviews, setReviews] = useState<StaffReview[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [person, setPerson] = useState(ALL);
  const [kind, setKind] = useState<(typeof KINDS)[number]["value"]>("all");
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    try {
      setReviews(await staffQuery<StaffReview[]>("/api/staff/reviews", signal));
      setLoadState("ready");
    } catch {
      if (!signal?.aborted) setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  const people = useMemo(() => {
    const ids = new Set(reviews.map((review) => review.practitionerId).filter((id): id is string => Boolean(id)));
    return [...ids].map((id) => ({ value: id, label: catalog.practitionerName(id) }));
  }, [reviews, catalog]);
  const shown = reviews
    .filter((review) => person === ALL || review.practitionerId === person)
    .filter((review) => kind === "all" || (kind === "public" && review.visibility === "public") || (kind === "private" && review.visibility === "private") || (kind === "low" && review.rating <= 2));
  // The page's own average counts only what the page shows.
  const summary = summarizeRatings(reviews.filter((review) => !review.isHidden && review.visibility === "public").map((review) => review.rating));

  async function setHidden(review: StaffReview, hidden: boolean) {
    setPending(review.id);
    setMessage("");
    try {
      await staffMutation(`/api/staff/reviews/${encodeURIComponent(review.id)}`, "PATCH", { hidden });
      setReviews((current) => current.map((entry) => (entry.id === review.id ? { ...entry, isHidden: hidden } : entry)));
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The change could not be saved.");
    } finally {
      setPending(null);
    }
  }

  if (loadState === "loading") {
    return (
      <Frame>
        <FramePanel className="flex flex-col gap-3">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </FramePanel>
      </Frame>
    );
  }

  if (loadState === "error") {
    return (
      <Alert variant="error">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          Reviews could not be loaded.
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (reviews.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquareQuote aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No reviews yet</EmptyTitle>
          <EmptyDescription>
            When a {t.visit} is marked finished, the {t.customer} is asked for a review. Reviews show here first, and on
            your booking page once they arrive.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Frame>
      <FrameHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <FrameTitle>What {t.customers} say</FrameTitle>
          <FrameDescription className="flex flex-col gap-1">
            <RatingLine summary={summary} />
          </FrameDescription>
        </div>
        <SelectField label="Show" fieldClassName="w-full sm:w-48" value={kind} onValueChange={(value) => setKind((KINDS.find((item) => item.value === value)?.value) ?? "all")} options={KINDS.map((item) => ({ value: item.value, label: item.label }))} />
        {people.length > 1 ? (
          <SelectField
            label={t.Practitioner}
            fieldClassName="w-full sm:w-56"
            value={person}
            onValueChange={(value) => setPerson(value ?? ALL)}
            options={[{ value: ALL, label: `Everyone` }, ...people]}
          />
        ) : null}
      </FrameHeader>
      {message ? (
        <FramePanel>
          <Alert variant="error">
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        </FramePanel>
      ) : null}
      <FramePanel className="flex flex-col divide-y py-1">
        {shown.map((review) => {
          const switchId = `review-shown-${review.id}`;
          const about = [
            review.serviceId ? catalog.serviceName(review.serviceId) : undefined,
            review.practitionerId ? `with ${catalog.practitionerName(review.practitionerId)}` : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <article key={review.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
              <div className={`flex min-w-0 flex-col gap-1.5 ${review.isHidden ? "opacity-64" : ""}`}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="font-medium text-sm">{review.displayName}</p>
                  <time dateTime={review.createdAt} className="text-muted-foreground text-xs">
                    {reviewDate(review.createdAt)}
                  </time>
                  {review.isHidden ? <Badge variant="outline">Hidden</Badge> : null}
                  {review.visibility === "private" ? <Badge variant="secondary">Only for you</Badge> : null}
                </div>
                <Stars rating={review.rating} />
                {about ? <p className="text-muted-foreground text-xs">{about}</p> : null}
                {review.comment ? <p className="whitespace-pre-line break-words text-sm">{review.comment}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  id={switchId}
                  checked={!review.isHidden && review.visibility === "public"}
                  disabled={pending === review.id || review.visibility === "private"}
                  onCheckedChange={(checked) => void setHidden(review, !checked)}
                />
                <Label htmlFor={switchId} className="text-sm">
                  {review.visibility === "private" ? "The customer chose to keep it private" : "Shown on your page"}
                </Label>
              </div>
            </article>
          );
        })}
      </FramePanel>
    </Frame>
  );
}
