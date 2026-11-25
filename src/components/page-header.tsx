import type { ReactNode } from "react";

import {
  ActionBar,
  type ActionMenuEntry,
  type BarAction,
} from "@/components/action-bar";
import { cn } from "@/lib/utils";

type HeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  /** Legacy free-form actions. Prefer `bar`, which never wraps. */
  actions?: ReactNode;
  /** One row of actions that collapses into a ⋯ menu when space runs out. */
  bar?: BarAction[];
  /** Entries that always live in the ⋯ menu, like Customize. */
  menu?: ActionMenuEntry[];
  /** Something shown right after the title, like a status badge. */
  titleAddon?: ReactNode;
  /** Gives the heading an id and lets a script focus it, so a screen reader hears the new title after a view change. */
  headingId?: string;
  className?: string;
};

function HeaderRow({
  title,
  description,
  actions,
  bar,
  menu,
  titleAddon,
  headingId,
  className,
  level,
}: HeaderProps & { level: "page" | "section" }) {
  const Heading = level === "page" ? "h1" : "h2";
  const usesBar = Boolean(bar || menu);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-4",
        !usesBar && actions ? "flex-wrap gap-y-3" : null,
        className,
      )}
    >
      <div className="min-w-0 flex-[0_1_auto]">
        <div className="flex min-w-0 items-center gap-2">
          <Heading
            id={headingId}
            tabIndex={headingId ? -1 : undefined}
            className={cn(
              "truncate font-heading font-semibold outline-none",
              level === "page" ? "text-xl" : "text-base",
            )}
          >
            {title}
          </Heading>
          {titleAddon}
        </div>
        {description ? (
          <p className="truncate text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {usesBar ? (
        <ActionBar actions={bar ?? []} menu={menu} />
      ) : actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/** The title block at the top of a workspace page. */
export function PageHeader(props: HeaderProps) {
  return <HeaderRow {...props} level="page" />;
}

/** The title block of a section or card: title, one line of subtext, one row of actions. */
export function SectionHeader(props: HeaderProps) {
  return <HeaderRow {...props} level="section" />;
}
