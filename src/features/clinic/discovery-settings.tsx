"use client";

import { Search } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "./clinic-catalog";
import { ListingSettings } from "./listing-settings";
import { useListing } from "./queries/listing";
import { ShareKit } from "./share-kit";

/** Settings → Find and share: the listing switch, the page words for search results, and the share kit. */
export function DiscoverySettings() {
  const t = useTerms();
  const { database } = useCatalogLookups();
  const listing = useListing(database);

  if (!database) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Search aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Search listing is not available in the preview</EmptyTitle>
          <EmptyDescription>Your listing and share links are saved on the {t.business} database. Start the local database to try them.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (listing.isPending) {
    return <div className="flex flex-col gap-3" role="status" aria-label="Loading"><Skeleton className="h-64 w-full" /><Skeleton className="h-48 w-full" /></div>;
  }
  if (listing.isError || !listing.data) {
    return (
      <Alert variant="error"><AlertDescription>
        <p>{listing.error?.message ?? "This could not be loaded."}</p>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void listing.refetch()}>Try again</Button>
      </AlertDescription></Alert>
    );
  }
  return (
    <>
      <ListingSettings view={listing.data} />
      <ShareKit view={listing.data} />
    </>
  );
}
