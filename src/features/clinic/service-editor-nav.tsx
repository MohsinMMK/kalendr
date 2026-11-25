"use client";

import { useState, type ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { TabsList, TabsTab } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useTerms } from "@/features/terms/business-profile-context";

import {
  groupOfTab, searchSettings, serviceEditorGroupIds, serviceEditorGroupLabels, serviceEditorGroups, type SettingIndexEntry,
} from "./service-editor-registry";

/** The search box over the settings. Choosing a match opens its tab and scrolls to it. */
export function SettingsSearch({ onJump }: { onJump: (entry: SettingIndexEntry) => void }) {
  const t = useTerms();
  const [query, setQuery] = useState("");
  const matches = searchSettings(query, t);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Input type="search" aria-label="Search settings" placeholder="Search settings" autoComplete="off" className="min-h-11 sm:min-h-0" value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Enter jumps to the first match and must not submit the editor's form.
            if (event.key === "Enter") { event.preventDefault(); const first = matches[0]; if (first) { onJump(first); setQuery(""); } }
            if (event.key === "Escape") setQuery("");
          }} />
      </div>
      {query.trim() ? (
        matches.length > 0 ? (
          <ul aria-label="Matching settings" className="flex flex-col rounded-lg border bg-popover p-1">
            {matches.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="flex min-h-11 w-full flex-col items-start justify-center rounded-md px-2 text-start text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { onJump(entry); setQuery(""); }}>
                  <span className="font-medium">{entry.title(t)}</span>
                  <span className="text-muted-foreground text-xs">{serviceEditorGroupLabels[groupOfTab(entry.tab)]}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p role="status" className="px-1 text-muted-foreground text-xs">No setting matches “{query.trim()}”.</p>
      ) : null}
    </div>
  );
}

/** The left nav: the four groups, each tab one entry. Keeps `role="tab"` so keyboard and deep links work as before. */
export function EditorNav({ labels, marks, footer }: { labels: Record<string, string>; marks: Record<string, ReactNode>; footer?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="-mx-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:overflow-visible lg:px-0 lg:pb-0">
        <TabsList variant="underline" aria-label="Settings" className="w-max max-w-none items-stretch lg:w-full">
          {serviceEditorGroupIds.map((group) => (
            <div key={group} role="presentation" className="flex items-center gap-0.5 lg:flex-col lg:items-stretch">
              <span aria-hidden="true" className={cn("hidden px-2 pb-1 font-medium text-muted-foreground text-xs lg:block", group !== "setup" && "pt-3")}>{serviceEditorGroupLabels[group]}</span>
              {serviceEditorGroups[group].map((id) => (
                <TabsTab key={id} value={id} className="min-h-11 justify-start">{labels[id] ?? id}{marks[id] ?? null}</TabsTab>
              ))}
            </div>
          ))}
        </TabsList>
      </div>
      {footer}
    </div>
  );
}
