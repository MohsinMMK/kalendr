import { StarIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Practitioner, Service } from "@/lib/domain";
import type { PublicReview, RatingSummary } from "@/lib/reviews";
import { cn } from "@/lib/utils";

/** Five stars, filled up to a whole rating. The number is read out instead of the stars. */
export function Stars({ rating, className }: { rating: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", className)} role="img" aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((value) => (
        <StarIcon
          key={value}
          aria-hidden="true"
          className={cn("size-3.5", value <= Math.round(rating) ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40")}
        />
      ))}
    </span>
  );
}

export function reviewCountLabel(count: number): string {
  return `${count} ${count === 1 ? "review" : "reviews"}`;
}

/**
 * "★ 4.7 · 12 reviews": the average of every published review and how many there are. With none
 * the line says nothing, so a business without reviews never looks badly rated.
 */
export function RatingLine({ summary, className }: { summary: RatingSummary | undefined; className?: string }) {
  if (!summary || summary.count === 0) return null;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <StarIcon aria-hidden="true" className="size-4 fill-amber-400 text-amber-400" />
      {summary.average !== null ? (
        <>
          <span className="font-medium tabular-nums text-foreground">{summary.average.toFixed(1)}</span>
          <span className="sr-only">out of 5,</span>
          <span aria-hidden="true" className="text-muted-foreground">·</span>
        </>
      ) : null}
      <span className="text-muted-foreground">{reviewCountLabel(summary.count)}</span>
    </span>
  );
}

/** The rating as a small rounded label: "★ 4.7 (12)". Like `RatingLine`, none shows nothing. */
export function RatingPill({ summary }: { summary: RatingSummary | undefined }) {
  if (!summary || summary.count === 0) return null;
  return (
    <Badge variant="outline" className="rounded-full px-2">
      {summary.average !== null ? (
        <>
          <StarIcon aria-hidden="true" className="fill-amber-400 text-amber-400 opacity-100" />
          <span className="tabular-nums">{summary.average.toFixed(1)}</span>
          <span className="sr-only">out of 5, {reviewCountLabel(summary.count)}</span>
          <span aria-hidden="true" className="font-normal text-muted-foreground tabular-nums">({summary.count})</span>
        </>
      ) : (
        reviewCountLabel(summary.count)
      )}
    </Badge>
  );
}

function reviewDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

/** One published review: name, stars, date, what it was for, and the comment. */
export function ReviewItem({
  review,
  locale,
  services,
  practitioners,
  showPerson = true,
}: {
  review: PublicReview;
  locale: string;
  services: Pick<Service, "id" | "name">[];
  practitioners: Pick<Practitioner, "id" | "name">[];
  showPerson?: boolean;
}) {
  const service = services.find((entry) => entry.id === review.serviceId)?.name;
  const person = showPerson ? practitioners.find((entry) => entry.id === review.practitionerId)?.name : undefined;
  const about = [service, person ? `with ${person}` : undefined].filter(Boolean).join(" ");
  return (
    <article className="flex flex-col gap-1.5 py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="font-medium text-sm">{review.displayName}</p>
        <time dateTime={review.createdAt} className="text-muted-foreground text-xs">
          {reviewDate(review.createdAt, locale)}
        </time>
      </div>
      <Stars rating={review.rating} />
      {about ? <p className="text-muted-foreground text-xs">{about}</p> : null}
      {review.comment ? <p className="text-sm">{review.comment}</p> : null}
    </article>
  );
}
