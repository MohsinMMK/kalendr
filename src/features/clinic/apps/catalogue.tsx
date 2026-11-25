"use client";

import {
  BarChart3, Blocks, Calendar, Code2, CreditCard, Globe, MessageSquare, Plug, RefreshCw, SearchX, Users, Video, type LucideIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { ExpandingSearch } from "@/components/expanding-search";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { appCategories, appCategoryLabels, type AppCard, type AppCategory, type AppState } from "@/lib/apps/catalog";

import { errorText } from "../developers/shared";
import { requestSettingsSection } from "../settings-navigation";
import type { SettingsSection } from "../settings-workspace";
import { useApps } from "./api";

const icons: Record<AppCategory, LucideIcon> = {
  messaging: MessageSquare, crm: Users, analytics: BarChart3, website: Globe, calendar: Calendar, video: Video, payments: CreditCard, developer: Code2,
};

function StateBadge({ state }: { state: AppState }) {
  switch (state) {
    case "active": case "connected": return <Badge variant="success">Connected</Badge>;
    case "paused": return <Badge variant="secondary">Paused</Badge>;
    case "failing": return <Badge variant="error">Needs attention</Badge>;
    case "uninstalling": return <Badge variant="warning">Removing</Badge>;
    case "unavailable": return <Badge variant="outline">Not available</Badge>;
    default: return null;
  }
}

function AppTile({ app, onOpen }: { app: AppCard; onOpen: (key: string) => void }) {
  const Icon = icons[app.category] ?? Blocks;
  const on = app.state === "active" || app.state === "connected" || app.state === "paused" || app.state === "failing" || app.state === "uninstalling";
  const action = app.kind === "native"
    ? <Button type="button" size="lg" variant={on ? "outline" : "default"} disabled={app.state === "uninstalling"} onClick={() => onOpen(app.key)}>{on ? "Manage" : "Install"}</Button>
    : app.manage?.href
      ? <Button size="lg" variant="outline" render={<a href={app.manage.href} />}>{app.manage.label}</Button>
      : app.manage?.section
        ? <Button type="button" size="lg" variant="outline" onClick={() => requestSettingsSection(app.manage?.section as SettingsSection)}>{app.manage.label}</Button>
        : null;
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted" aria-hidden="true"><Icon className="size-5" /></span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between gap-2"><h3 className="truncate font-medium">{app.name}</h3><StateBadge state={app.state} /></div>
          <p className="text-muted-foreground text-sm">{app.tagline}</p>
        </div>
      </div>
      {app.statusText ? <p className="text-muted-foreground text-xs">{app.statusText}</p> : <p className="text-muted-foreground text-xs">{appCategoryLabels[app.category]}</p>}
      {app.needsUpgrade && app.state !== "active" ? <p className="text-xs">Comes with the Growth plan.</p> : null}
      <div className="mt-auto flex items-center justify-end gap-2">{action}</div>
    </li>
  );
}

/** Every app and connection in one list, with search and a category filter. */
export function Catalogue({ onOpen }: { onOpen: (key: string) => void }) {
  const query = useApps();
  const [text, setText] = useState("");
  const [category, setCategory] = useState("all");
  const options = useMemo(() => [{ value: "all", label: "All categories" }, ...appCategories.map((value) => ({ value, label: appCategoryLabels[value] }))], []);

  if (query.isPending) {
    return <div role="status" aria-label="Loading apps" className="grid gap-3 sm:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 w-full rounded-xl" />)}</div>;
  }
  if (query.isError) {
    return (
      <Alert variant="error">
        <AlertTitle>Apps could not be loaded</AlertTitle>
        <AlertDescription><p>{errorText(query.error, "Check your connection and try again.")}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button></AlertDescription>
      </Alert>
    );
  }

  const needle = text.trim().toLowerCase();
  const shown = query.data.apps.filter((app) => (category === "all" || app.category === category)
    && (needle === "" || `${app.name} ${app.tagline}`.toLowerCase().includes(needle)));
  const installed = shown.filter((app) => app.state === "active" || app.state === "paused" || app.state === "failing" || app.state === "uninstalling" || app.state === "connected");
  const rest = shown.filter((app) => !installed.includes(app));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-2">
        <ExpandingSearch label="Search apps" placeholder="Search apps" value={text} onValueChange={setText} />
        <OptionSelect aria-label="Category" value={category} onValueChange={setCategory} options={options} className="sm:max-w-52" />
      </div>
      {shown.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><SearchX aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>Nothing matches</EmptyTitle>
            <EmptyDescription>Try another word, or show all categories.</EmptyDescription>
          </EmptyHeader>
          <Button type="button" variant="outline" onClick={() => { setText(""); setCategory("all"); }}>Clear the search</Button>
        </Empty>
      ) : (
        <>
          {installed.length > 0 ? <Group title="Connected" apps={installed} onOpen={onOpen} /> : null}
          {rest.length > 0 ? <Group title={installed.length > 0 ? "More apps" : "Apps"} apps={rest} onOpen={onOpen} /> : null}
        </>
      )}
      <p className="flex items-center gap-2 text-muted-foreground text-xs"><Plug aria-hidden="true" className="size-3.5" /> Calendars, payments, WhatsApp and the rest are listed so you can find every connection here. They are managed on their own screens.</p>
    </div>
  );
}

function Group({ title, apps, onOpen }: { title: string; apps: AppCard[]; onOpen: (key: string) => void }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      <ul className="grid gap-3 sm:grid-cols-2">{apps.map((app) => <AppTile key={app.key} app={app} onOpen={onOpen} />)}</ul>
    </section>
  );
}
