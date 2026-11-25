"use client";

import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import type { ActionMenuEntry, BarAction } from "@/components/action-bar";
import { PageHeader } from "@/components/page-header";
import { useNavLabels } from "@/features/clinic/sidebar-nav";
import { Button } from "@/components/ui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import type { SidebarEntryId } from "@/lib/sidebar";
import { cn } from "@/lib/utils";

/**
 * How a page uses the height of the screen.
 * - `flow`: the page grows with its content and the window scrolls. Most pages.
 * - `desktop`: from 1024px the page fills the screen and its frame scrolls inside; below that it flows.
 * - `screen`: the page always fills the screen, so a long list or calendar scrolls inside its frame.
 */
export type WorkspaceFit = "flow" | "desktop" | "screen";

const fitClass: Record<WorkspaceFit, string> = {
  flow: "",
  desktop: "lg:h-full lg:min-h-0 lg:overflow-hidden",
  // The app bar is 3.5rem; on phones the bottom bar takes another 3.5rem, and from 768px the page panel sits 0.5rem in from
  // the window's top and bottom.
  screen:
    "h-[calc(100svh-3.5rem)] md:h-[calc(100svh-4.5rem)] min-h-[36rem] max-sm:h-[calc(100svh-7rem-env(safe-area-inset-bottom))] max-sm:min-h-[28rem] lg:h-full lg:min-h-0 lg:overflow-hidden",
};

/**
 * The page every staff screen uses: the same gutter on all four sides, a title on the left with
 * its actions on the right, then the page's content, usually one WorkspaceFrame. The content
 * always spans the full width; width and spacing live here only, so pages cannot drift apart.
 * Never wrap a page's content in its own padding, `mx-auto` or `max-w-*`: cap a field, not a page.
 */
export function WorkspacePage({
  title,
  nav,
  back,
  description,
  headingId,
  titleAddon,
  bar,
  menu,
  actions,
  fit = "flow",
  className,
  children,
}: {
  /** The title, for a screen that is not a sidebar page. A sidebar page passes `nav` instead. */
  title?: ReactNode;
  /** The sidebar entry this page belongs to: its title is that entry's name, as the business renamed it. */
  nav?: SidebarEntryId;
  /** A screen inside a page, like an editor, shows a back button before its title. */
  back?: { label: string; onClick: () => void };
  /** One short line under the title, for screens like settings sections that need to say what they hold. */
  description?: ReactNode;
  /** Lets the page move focus to its title after a view change. */
  headingId?: string;
  /** Something small right after the title, like a glance button. */
  titleAddon?: ReactNode;
  /** One row of actions that collapses into a ⋯ menu when space runs out. */
  bar?: BarAction[];
  /** Entries that always live in the ⋯ menu. */
  menu?: ActionMenuEntry[];
  /** Free-form actions, for controls the action bar cannot express. Prefer `bar`. */
  actions?: ReactNode;
  fit?: WorkspaceFit;
  className?: string;
  children: ReactNode;
}) {
  const labels = useNavLabels();
  return (
    <div data-slot="workspace-page" className={cn("flex min-w-0 flex-col gap-4 p-4 md:p-6", fitClass[fit], className)}>
      <div className="flex min-w-0 shrink-0 items-center gap-1">
        {back ? (
          <Button variant="ghost" size="icon-sm" className="-ms-2 shrink-0" aria-label={back.label} onClick={back.onClick}>
            <ArrowLeft aria-hidden="true" />
          </Button>
        ) : null}
        <PageHeader className="flex-1" title={nav ? labels[nav] : title} description={description} headingId={headingId} titleAddon={titleAddon} bar={bar} menu={menu} actions={actions} />
      </div>
      {children}
    </div>
  );
}

/**
 * The card that holds a page's content: tabs or filters on the left of its toolbar, controls on
 * the right, and the content in the panel below. Inside a fitted page it fills the rest of the
 * height; pass `panelClassName="overflow-auto"` (or hidden, when the content scrolls itself).
 */
export function WorkspaceFrame({
  start,
  end,
  footer,
  flush = false,
  className,
  panelClassName,
  children,
}: {
  /** Left of the toolbar: tabs, a date switcher, a search box. */
  start?: ReactNode;
  /** Right of the toolbar: filters, view switches, secondary buttons. */
  end?: ReactNode;
  /** Under the panel: a pager, a save row. */
  footer?: ReactNode;
  /** Drop the panel padding, for tables and edge-to-edge lists. */
  flush?: boolean;
  className?: string;
  panelClassName?: string;
  children: ReactNode;
}) {
  return (
    <Frame className={cn("min-h-0 min-w-0 flex-1", className)}>
      {start || end ? (
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 px-2 py-1.5">
          {start ? <div className="-m-0.5 flex min-w-0 max-w-full items-center gap-2 overflow-x-auto overflow-y-hidden p-0.5 [scrollbar-width:none]">{start}</div> : <span />}
          {end ? <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2">{end}</div> : null}
        </FrameHeader>
      ) : null}
      <FramePanel className={cn("flex min-h-0 min-w-0 flex-1 flex-col", flush ? "overflow-hidden p-0" : "p-4 md:p-5", panelClassName)}>
        {children}
      </FramePanel>
      {footer ? <FrameFooter className="flex flex-row flex-wrap items-center justify-between gap-2 px-3 py-2">{footer}</FrameFooter> : null}
    </Frame>
  );
}
