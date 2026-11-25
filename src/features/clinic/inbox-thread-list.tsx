"use client";

import { MessagesSquare, RefreshCw } from "lucide-react";

import { ExpandingSearch } from "@/components/expanding-search";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTerms } from "@/features/terms/business-profile-context";
import type { InboxFilter, ThreadSummary } from "@/lib/inbox-contracts";
import { cn } from "@/lib/utils";

import { shortWhen } from "./inbox-text";
import { ScrollArea } from "@/components/ui/scroll-area";

const filters: { value: InboxFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "mine", label: "Mine" },
];

export interface ThreadListProps {
  threads: ThreadSummary[] | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  filter: InboxFilter;
  onFilter: (filter: InboxFilter) => void;
  search: string;
  onSearch: (value: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function InboxThreadList(props: ThreadListProps) {
  const { threads, loading, failed, onRetry, filter, onFilter, search, onSearch, selectedId, onSelect } = props;
  const t = useTerms();
  const needle = search.trim().toLowerCase();
  const shown = (threads ?? []).filter((thread) => !needle || thread.patientName.toLowerCase().includes(needle));

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-col gap-2 border-b p-3">
        <div className="flex justify-end"><ExpandingSearch placeholder={`Search by ${t.customer}`} label={`Search conversations by ${t.customer}`} value={search} onValueChange={onSearch} openClassName="w-full" /></div>
        <ToggleGroup
          aria-label="Show conversations"
          variant="outline"
          size="sm"
          className="w-full"
          value={[filter]}
          onValueChange={(next: string[]) => {
            const chosen = filters.find((item) => item.value === next[0]);
            if (chosen) onFilter(chosen.value);
          }}
        >
          {filters.map((item) => <ToggleGroupItem key={item.value} value={item.value} className="min-h-11 flex-1 sm:min-h-8">{item.label}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div role="status" aria-label="Loading conversations" className="flex flex-col gap-2 p-3">
            {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-16 w-full" />)}
          </div>
        ) : null}

        {!loading && failed && !threads ? (
          <div className="p-3">
            <Alert variant="error">
              <AlertTitle>Conversations could not be loaded</AlertTitle>
              <AlertDescription>
                <p>Check your connection and try again.</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}><RefreshCw aria-hidden="true" /> Retry</Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {failed && threads ? (
          <div className="p-3 pb-0">
            <Alert variant="warning">
              <AlertDescription className="flex items-center justify-between gap-2">
                <span>Could not refresh. Showing what loaded last.</span>
                <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {!loading && threads && shown.length === 0 ? (
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessagesSquare aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{threads.length === 0 && filter === "all" ? "No conversations yet" : "No matching conversations"}</EmptyTitle>
              <EmptyDescription>
                {threads.length === 0 && filter === "all"
                  ? `No conversations yet. Replies from ${t.customers} on WhatsApp land here.`
                  : needle ? `No ${t.customer} matches that name.` : filter === "unread" ? "Everything has been read." : "Nothing is assigned to you."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {shown.length ? (
          <ul aria-label="Conversations" className="flex flex-col divide-y">
            {shown.map((thread) => (
              <li key={thread.id}>
                <button
                  type="button"
                  onClick={() => onSelect(thread.id)}
                  aria-current={thread.id === selectedId ? "true" : undefined}
                  className={cn("flex min-h-16 w-full flex-col gap-0.5 px-3 py-2.5 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", thread.id === selectedId && "bg-accent")}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn("min-w-0 truncate text-sm", thread.unreadCount ? "font-semibold" : "font-medium")}>{thread.patientName}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{shortWhen(thread.lastMessageAt)}</span>
                  </span>
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{thread.preview}</span>
                    {thread.unreadCount ? (
                      <Badge variant="default" size="lg" aria-label={`${thread.unreadCount} unread`}>{thread.unreadCount}</Badge>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </ScrollArea>
    </div>
  );
}
