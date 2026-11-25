"use client";

import { useState } from "react";
import { Database, MessageCircle } from "lucide-react";

import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { useTerms } from "@/features/terms/business-profile-context";
import { useIsMobile } from "@/hooks/use-media-query";
import type { InboxFilter } from "@/lib/inbox-contracts";

import { useCatalogLookups } from "./clinic-catalog";
import { useThreads } from "./inbox-api";
import { InboxConversation } from "./inbox-conversation";
import { InboxThreadList } from "./inbox-thread-list";

/**
 * The WhatsApp Inbox: conversations on the left, the open one on the right. On a phone the two
 * take turns: the list first, then the conversation full-screen with a Back button.
 */
export function InboxPanel() {
  const catalog = useCatalogLookups();
  const t = useTerms();
  const mobile = useIsMobile();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const threads = useThreads(filter, catalog.database);

  if (!catalog.database) {
    return (
      <Empty className="flex-1 py-12">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Database aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Not available in the preview</EmptyTitle>
          <EmptyDescription>The Inbox needs a real database; it isn&apos;t part of the preview.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const list = (
    <InboxThreadList
      threads={threads.data}
      loading={threads.isPending}
      failed={threads.isError}
      onRetry={() => void threads.refetch()}
      filter={filter}
      onFilter={setFilter}
      search={search}
      onSearch={setSearch}
      selectedId={selectedId}
      onSelect={setSelectedId}
    />
  );
  const conversation = selectedId ? (
    <InboxConversation key={selectedId} threadId={selectedId} onBack={mobile ? () => setSelectedId(null) : null} />
  ) : (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon"><MessageCircle aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>Pick a conversation</EmptyTitle>
        <EmptyDescription>What a {t.customer} wrote on WhatsApp shows here, with their next {t.appointment} at the top.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );

  return (
    <section aria-label="Inbox" className="flex min-h-96 flex-1 overflow-hidden">
      {mobile ? (
        selectedId ? <div className="flex min-w-0 flex-1 flex-col">{conversation}</div> : <div className="flex min-w-0 flex-1 flex-col">{list}</div>
      ) : (
        <>
          <div className="flex w-80 shrink-0 flex-col border-e">{list}</div>
          <div className="flex min-w-0 flex-1 flex-col">{conversation}</div>
        </>
      )}
    </section>
  );
}
