"use client";

import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTerms } from "@/features/terms/business-profile-context";
import type { AppointmentRating } from "@/lib/reviews";

import { Stars } from "../business/ratings";
import { staffKeys } from "./queries/keys";
import { staffQuery } from "./queries/http";
import { useStaffAccess } from "./staff-access";

const ratingKeys = { for: (filter: string) => [...staffKeys.all, "ratings", filter] as const };

function useRatings(filter: { appointmentId?: string; patientId?: string }, enabled: boolean) {
  const query = new URLSearchParams(Object.entries(filter).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return useQuery({
    queryKey: ratingKeys.for(query.toString()),
    queryFn: ({ signal }) => staffQuery<AppointmentRating[]>(`/api/staff/reviews?${query.toString()}`, signal),
    enabled,
  });
}

const day = (value: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));

function Rating({ rating }: { rating: AppointmentRating }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Stars rating={rating.rating} />
        <span className="text-muted-foreground text-xs">{day(rating.createdAt)}</span>
        {rating.visibility === "private" ? <Badge variant="secondary">Only for you</Badge> : null}
        {rating.isHidden ? <Badge variant="outline">Hidden from your page</Badge> : null}
      </div>
      {rating.comment ? <p className="whitespace-pre-line break-words text-sm">{rating.comment}</p> : null}
    </div>
  );
}

/** The score and comment on one finished appointment. Nothing shows until the customer has answered. */
export function AppointmentRatingNote({ appointmentId }: { appointmentId: string }) {
  const t = useTerms();
  const access = useStaffAccess();
  const query = useRatings({ appointmentId }, access.can("appointments.status") || access.can("appointments.book"));
  const rating = query.data?.[0];
  if (!rating) return null;
  return (
    <Alert role="note" variant={rating.rating <= 2 ? "warning" : "info"}>
      <AlertDescription>
        <p className="mb-1 font-medium">How the {t.customer} rated this {t.visit}</p>
        <Rating rating={rating} />
      </AlertDescription>
    </Alert>
  );
}

/** Every rating one customer has given, newest first, for their profile. */
export function CustomerRatings({ patientId, className }: { patientId: string; className?: string }) {
  const access = useStaffAccess();
  const query = useRatings({ patientId }, access.can("appointments.status") || access.can("appointments.book"));
  if (!query.data || query.data.length === 0) return null;
  return (
    <section className={className} aria-label="Ratings">
      <h3 className="mb-2 font-medium text-sm">Ratings</h3>
      <ul className="flex flex-col gap-3">{query.data.map((rating) => <li key={rating.id}><Rating rating={rating} /></li>)}</ul>
    </section>
  );
}
