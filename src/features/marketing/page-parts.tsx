import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** One page width for every marketing page. */
export const container = "mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8";
export const sectionHeading = "text-balance font-heading text-2xl font-semibold sm:text-3xl";

/**
 * The top of a marketing page: a short eyebrow, a two-line headline whose
 * second line is muted, one or two sentences, actions, then the page's demo.
 */
export function PageHero({
  eyebrow,
  title,
  titleMuted,
  lead,
  actions,
  demo,
}: {
  eyebrow?: string;
  title: string;
  titleMuted?: string;
  lead: ReactNode;
  actions?: ReactNode;
  demo?: ReactNode;
}) {
  return (
    <section
      aria-labelledby="page-title"
      className={cn(
        container,
        "grid items-center gap-10 py-10 lg:gap-14 lg:py-16",
        demo && "lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]",
      )}
    >
      <div className="flex min-w-0 flex-col items-start gap-5">
        {eyebrow ? <p className="text-sm font-medium text-primary">{eyebrow}</p> : null}
        <h1 id="page-title" className="text-balance font-heading text-4xl font-semibold leading-[1.05] sm:text-5xl lg:text-6xl">
          {title}
          {titleMuted ? <span className="block text-muted-foreground">{titleMuted}</span> : null}
        </h1>
        <div className="max-w-xl text-pretty text-base text-muted-foreground sm:text-lg">{lead}</div>
        {actions ?? <StartActions />}
      </div>
      {demo ? <div className="min-w-0">{demo}</div> : null}
    </section>
  );
}

export function StartActions({ secondary }: { secondary?: { href: string; label: string } }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="lg" render={<Link href="/start" />}>
        Set up your business <ArrowRight aria-hidden="true" />
      </Button>
      {secondary ? (
        <Button size="lg" variant="outline" render={<Link href={secondary.href} />}>
          {secondary.label}
        </Button>
      ) : null}
    </div>
  );
}

/** A titled band of the page. `id` doubles as the heading id. */
export function Section({
  id,
  title,
  lead,
  children,
  className,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className={cn(container, "scroll-mt-20 py-12 lg:py-16", className)}>
      <div className="mb-8 max-w-2xl">
        <h2 id={`${id}-title`} className={sectionHeading}>{title}</h2>
        {lead ? <p className="mt-3 text-pretty text-muted-foreground">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Short points in a grid: a title and one or two sentences each. */
export function PointGrid({ points, columns = 3 }: { points: readonly { title: string; body: string; icon?: ReactNode }[]; columns?: 2 | 3 }) {
  return (
    <ul className={cn("grid gap-x-8 gap-y-6 sm:grid-cols-2", columns === 3 && "lg:grid-cols-3")}>
      {points.map((point) => (
        <li key={point.title} className="flex gap-3">
          {point.icon ? <span aria-hidden="true" className="mt-0.5 text-primary [&>svg]:size-5">{point.icon}</span> : null}
          <div className="min-w-0">
            <h3 className="font-medium">{point.title}</h3>
            <p className="mt-1 text-pretty text-sm text-muted-foreground">{point.body}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The last band on every page. */
export function ClosingBand({ title = "Ready for your next booking?" }: { title?: string }) {
  return (
    <section aria-labelledby="closing-title" className={cn(container, "pb-12 lg:pb-16")}>
      <Card>
        <CardPanel className="flex flex-col items-start justify-between gap-4 p-6 sm:flex-row sm:items-center">
          <h2 id="closing-title" className={sectionHeading}>{title}</h2>
          <Button size="xl" render={<Link href="/start" />}>
            Set up your business <ArrowRight aria-hidden="true" />
          </Button>
        </CardPanel>
      </Card>
    </section>
  );
}
