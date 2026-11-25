import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { MapPinIcon, SearchIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { businessTypes } from "@/lib/business-types";
import { exploreHref, parseExploreQuery } from "@/lib/explore-url";
import { DIRECTORY_PAGE_SIZE, directoryFacets, searchDirectory } from "@/server/discovery";
import { hitRateLimit, clientAddress } from "@/server/rate-limit";
import { rateLimitRules } from "@/server/rate-limit-rules";

interface ExplorePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ searchParams }: ExplorePageProps): Promise<Metadata> {
  const query = parseExploreQuery(await searchParams);
  const filtered = Boolean(query.q || query.city || query.type || query.page > 1);
  return {
    title: "Find a business to book",
    description: "Browse businesses that take bookings online, by city and type, and book an appointment in a minute.",
    alternates: { canonical: "/explore" },
    // Filtered and paged lists are not pages of their own; the plain directory is.
    robots: filtered ? { index: false, follow: true } : { index: true, follow: true },
  };
}

/**
 * The directory of businesses that chose to be listed, by city and type, with search. Server-rendered and readable without
 * script: the search box is an ordinary form and the filters are links. Only listed, running businesses appear.
 */
export default async function ExplorePage({ searchParams }: ExplorePageProps) {
  const query = parseExploreQuery(await searchParams);
  const limit = await hitRateLimit("directory.ip", clientAddress(await headers()));
  if (!limit.allowed) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-3xl items-center px-4 py-10">
        <Empty>
          <EmptyHeader>
            <EmptyTitle><h1>{rateLimitRules["directory.ip"].message}</h1></EmptyTitle>
            <EmptyDescription>Try again in about {limit.retryAfterSeconds} seconds.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </main>
    );
  }
  const [{ cards, total }, facets] = await Promise.all([searchDirectory(query), directoryFacets().catch(() => ({ types: [], cities: [] }))]);
  const pages = Math.max(1, Math.ceil(total / DIRECTORY_PAGE_SIZE));

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col gap-6 px-4 py-8 sm:py-12">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading font-semibold text-2xl sm:text-3xl">Find a business to book</h1>
        <p className="text-muted-foreground text-sm">Businesses that take bookings online. Pick one and choose a time.</p>
      </header>

      <form action="/explore" method="get" role="search" className="flex flex-col gap-3 sm:flex-row">
        <label className="sr-only" htmlFor="explore-q">Search by business name or place</label>
        <Input id="explore-q" name="q" type="search" size="lg" defaultValue={query.q} placeholder="Search by name or place" autoComplete="off" maxLength={80} className="flex-1" />
        {query.city ? <input type="hidden" name="city" value={query.city} /> : null}
        {query.type ? <input type="hidden" name="type" value={query.type} /> : null}
        <Button type="submit" size="lg"><SearchIcon aria-hidden="true" />Search</Button>
      </form>

      {facets.types.length > 0 || facets.cities.length > 0 ? (
        <nav aria-label="Filters" className="flex flex-col gap-3">
          {facets.types.length > 0 ? (
            <ul aria-label="Type of business" className="flex flex-wrap gap-2">
              <li><Button size="sm" variant={query.type ? "outline" : "default"} render={<Link href={exploreHref({ ...query, type: "", page: 1 })} aria-current={query.type ? undefined : "true"} />}>All types</Button></li>
              {facets.types.map((facet) => (
                <li key={facet.value}><Button size="sm" variant={query.type === facet.value ? "default" : "outline"} render={<Link href={exploreHref({ ...query, type: facet.value, page: 1 })} aria-current={query.type === facet.value ? "true" : undefined} />}>{businessTypes[facet.value].label} <span className="opacity-70">{facet.count}</span></Button></li>
              ))}
            </ul>
          ) : null}
          {facets.cities.length > 0 ? (
            <ul aria-label="City" className="flex flex-wrap gap-2">
              <li><Button size="sm" variant={query.city ? "outline" : "default"} render={<Link href={exploreHref({ ...query, city: "", page: 1 })} aria-current={query.city ? undefined : "true"} />}>Everywhere</Button></li>
              {facets.cities.slice(0, 12).map((facet) => (
                <li key={facet.value}><Button size="sm" variant={query.city === facet.value ? "default" : "outline"} render={<Link href={exploreHref({ ...query, city: facet.value, page: 1 })} aria-current={query.city === facet.value ? "true" : undefined} />}><MapPinIcon aria-hidden="true" />{facet.value}</Button></li>
              ))}
            </ul>
          ) : null}
        </nav>
      ) : null}

      {cards.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><SearchIcon aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{query.q || query.city || query.type ? "No business matches that" : "No businesses are listed yet"}</EmptyTitle>
            <EmptyDescription>{query.q || query.city || query.type ? "Try fewer words, or clear a filter." : "Check back soon."}</EmptyDescription>
          </EmptyHeader>
          {query.q || query.city || query.type ? <Button variant="outline" render={<Link href="/explore" />}>Clear search</Button> : null}
        </Empty>
      ) : (
        <>
          <p className="text-muted-foreground text-sm" role="status">{total} {total === 1 ? "business" : "businesses"}</p>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((card) => (
              <li key={card.slug}>
                <Card className="relative h-full">
                  <CardPanel className="flex h-full flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <h2 className="font-heading font-semibold text-base"><Link href={card.url} className="after:absolute after:inset-0 hover:underline focus-visible:underline">{card.name}</Link></h2>
                      <p className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                        <Badge variant="outline">{businessTypes[card.businessType].label}</Badge>
                        {card.city ? <span className="inline-flex items-center gap-1"><MapPinIcon aria-hidden="true" className="size-3" />{card.city}</span> : null}
                      </p>
                    </div>
                    {card.about ? <p className="line-clamp-3 text-muted-foreground text-sm">{card.about}</p> : null}
                  </CardPanel>
                </Card>
              </li>
            ))}
          </ul>
          {pages > 1 ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3">
              <Button variant="outline" disabled={query.page <= 1} render={query.page <= 1 ? undefined : <Link rel="prev" href={exploreHref({ ...query, page: query.page - 1 })} />}>Previous</Button>
              <span className="text-muted-foreground text-sm">Page {query.page} of {pages}</span>
              <Button variant="outline" disabled={query.page >= pages} render={query.page >= pages ? undefined : <Link rel="next" href={exploreHref({ ...query, page: query.page + 1 })} />}>Next</Button>
            </nav>
          ) : null}
        </>
      )}
    </main>
  );
}
