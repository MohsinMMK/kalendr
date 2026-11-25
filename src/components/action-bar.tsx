"use client";

/**
 * One row of actions that never wraps. Actions that do not fit move into a
 * "More" (⋯) menu, lowest priority first. Actions with `items` are dropdowns
 * inline and cascading submenus inside the overflow menu. On small touch
 * screens the menus open as bottom sheets where submenus replace the level.
 */

import { ChevronDownIcon, EllipsisIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import {
  RichMenu,
  RichMenuCheckboxItem,
  RichMenuContent,
  RichMenuGroupLabel,
  RichMenuItem,
  RichMenuRadioGroup,
  RichMenuRadioItem,
  RichMenuSeparator,
  RichMenuSub,
  RichMenuSubContent,
  RichMenuSubTrigger,
  RichMenuTrigger,
} from "@/components/rich-menu";
import { buttonVariants } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ActionMenuEntry =
  | {
      kind?: "item";
      id: string;
      label: string;
      icon?: React.ReactNode;
      hint?: React.ReactNode;
      onSelect?: () => void;
      href?: string;
      destructive?: boolean;
      disabled?: boolean;
    }
  | { kind: "separator"; id: string }
  | { kind: "label"; id: string; label: string }
  | {
      kind: "radio";
      id: string;
      label?: string;
      value: string;
      options: { value: string; label: string; disabled?: boolean }[];
      onValueChange: (value: string) => void;
    }
  | {
      kind: "checkbox";
      id: string;
      label: string;
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
    }
  | {
      kind: "submenu";
      id: string;
      label: string;
      icon?: React.ReactNode;
      hint?: React.ReactNode;
      items: ActionMenuEntry[];
      disabled?: boolean;
    };

export type BarAction = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  /** A small count shown beside the label, like open items. */
  badge?: React.ReactNode;
  /** Text shown at the end of the row in the overflow menu, like the current choice. */
  hint?: React.ReactNode;
  variant?: "default" | "outline" | "ghost" | "secondary";
  onSelect?: () => void;
  href?: string;
  /** A dropdown inline, a submenu in the overflow menu. */
  items?: ActionMenuEntry[];
  /** Custom inline element instead of a button. Shown in the overflow menu only with `onSelect`, `href` or `items`. */
  inline?: React.ReactNode;
  /** Higher stays in the row longer. */
  priority?: number;
  /** Never moves to the overflow menu. */
  pinned?: boolean;
  /** Show only the icon inline (label stays for screen readers and the overflow menu). */
  iconOnly?: boolean;
  disabled?: boolean;
};

const buttonClass = (variant: BarAction["variant"] = "outline", iconOnly?: boolean) =>
  cn(buttonVariants({ size: iconOnly ? "icon-sm" : "sm", variant }), "shrink-0");

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex min-w-4.5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[0.6875rem] text-primary-foreground tabular-nums leading-4.5">
      {children}
    </span>
  );
}

export function MenuEntries({ entries }: { entries: ActionMenuEntry[] }) {
  return (
    <>
      {entries.map((entry) => {
        switch (entry.kind) {
          case "separator":
            return <RichMenuSeparator key={entry.id} />;
          case "label":
            return (
              <RichMenuGroupLabel key={entry.id}>{entry.label}</RichMenuGroupLabel>
            );
          case "radio":
            return (
              <RichMenuRadioGroup
                key={entry.id}
                onValueChange={(value: string) => entry.onValueChange(value)}
                value={entry.value}
              >
                {entry.label ? (
                  <RichMenuGroupLabel>{entry.label}</RichMenuGroupLabel>
                ) : null}
                {entry.options.map((option) => (
                  <RichMenuRadioItem
                    disabled={option.disabled}
                    key={option.value}
                    value={option.value}
                  >
                    {option.label}
                  </RichMenuRadioItem>
                ))}
              </RichMenuRadioGroup>
            );
          case "checkbox":
            return (
              <RichMenuCheckboxItem
                checked={entry.checked}
                closeOnSelect={false}
                key={entry.id}
                onCheckedChange={(checked: boolean) => entry.onCheckedChange(checked)}
                value={entry.id}
              >
                {entry.label}
              </RichMenuCheckboxItem>
            );
          case "submenu":
            return (
              <RichMenuSub key={entry.id}>
                <RichMenuSubTrigger
                  disabled={entry.disabled}
                  hint={entry.hint}
                  icon={entry.icon}
                >
                  {entry.label}
                </RichMenuSubTrigger>
                <RichMenuSubContent>
                  <MenuEntries entries={entry.items} />
                </RichMenuSubContent>
              </RichMenuSub>
            );
          default:
            return (
              <RichMenuItem
                destructive={entry.destructive}
                disabled={entry.disabled}
                hint={entry.hint}
                icon={entry.icon}
                key={entry.id}
                onSelect={entry.onSelect}
                render={entry.href ? <Link href={entry.href} /> : undefined}
                value={entry.id}
              >
                {entry.label}
              </RichMenuItem>
            );
        }
      })}
    </>
  );
}

/** A button that opens a rich dropdown menu. */
export function ActionMenuButton({
  label,
  icon,
  badge,
  items,
  variant = "outline",
  iconOnly,
  disabled,
  align = "end",
  className,
}: {
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  items: ActionMenuEntry[];
  variant?: BarAction["variant"];
  iconOnly?: boolean;
  disabled?: boolean;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  return (
    <RichMenu>
      <RichMenuTrigger
        aria-label={iconOnly && typeof label === "string" ? label : undefined}
        className={cn(buttonClass(variant, iconOnly), className)}
        disabled={disabled}
      >
        {icon}
        {iconOnly ? null : label}
        {badge != null && badge !== false ? <Badge>{badge}</Badge> : null}
        {iconOnly ? null : <ChevronDownIcon className="-me-1 opacity-64" />}
      </RichMenuTrigger>
      <RichMenuContent align={align}>
        <MenuEntries entries={items} />
      </RichMenuContent>
    </RichMenu>
  );
}

function InlineAction({ action }: { action: BarAction }) {
  if (action.inline) return <>{action.inline}</>;
  if (action.items) {
    return (
      <ActionMenuButton
        badge={action.badge}
        disabled={action.disabled}
        icon={action.icon}
        iconOnly={action.iconOnly}
        items={action.items}
        label={action.label}
        variant={action.variant}
      />
    );
  }
  const content = (
    <>
      {action.icon}
      {action.iconOnly ? null : action.label}
      {action.badge != null && action.badge !== false ? (
        <Badge>{action.badge}</Badge>
      ) : null}
    </>
  );
  if (action.href) {
    return (
      <Link
        aria-label={action.iconOnly ? action.label : undefined}
        className={buttonClass(action.variant, action.iconOnly)}
        href={action.href}
      >
        {content}
      </Link>
    );
  }
  const button = (
    <button
      aria-label={action.iconOnly ? action.label : undefined}
      className={buttonClass(action.variant, action.iconOnly)}
      disabled={action.disabled}
      onClick={action.onSelect}
      type="button"
    >
      {content}
    </button>
  );
  if (!action.iconOnly) return button;
  // An icon on its own says what it does on hover and focus, in the coss tooltip.
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup>{action.label}</TooltipPopup>
    </Tooltip>
  );
}

function toEntry(action: BarAction): ActionMenuEntry | null {
  if (action.items) {
    return {
      disabled: action.disabled,
      hint: action.hint ?? action.badge,
      icon: action.icon,
      id: action.id,
      items: action.items,
      kind: "submenu",
      label: action.label,
    };
  }
  if (!action.onSelect && !action.href) return null;
  return {
    disabled: action.disabled,
    hint: action.hint ?? action.badge,
    href: action.href,
    icon: action.icon,
    id: action.id,
    label: action.label,
    onSelect: action.onSelect,
  };
}

const GAP = 8;

export function ActionBar({
  actions,
  menu,
  overflowLabel = "More actions",
  className,
}: {
  actions: BarAction[];
  /** Entries that always live in the overflow menu, like Customize. */
  menu?: ActionMenuEntry[];
  overflowLabel?: string;
  className?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const [visibleIds, setVisibleIds] = React.useState<Set<string> | null>(null);
  // Pinned actions and the ⋯ button always need their room, even next to a long title.
  const [minWidth, setMinWidth] = React.useState(32);

  const actionKey = actions.map((action) => action.id).join("|");

  const recompute = React.useCallback(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;
    const available = container.clientWidth;
    const widths = new Map<string, number>();
    for (const node of Array.from(measure.children) as HTMLElement[]) {
      const id = node.dataset.actionId;
      if (id) widths.set(id, node.getBoundingClientRect().width);
    }
    const overflowWidth = widths.get("__overflow") ?? 32;
    const total = actions.reduce(
      (sum, action) => sum + (widths.get(action.id) ?? 0) + GAP,
      0,
    );
    const pinnedWidth = actions
      .filter((action) => action.pinned)
      .reduce((sum, action) => sum + (widths.get(action.id) ?? 0) + GAP, 0);
    setMinWidth(Math.ceil(pinnedWidth + overflowWidth));
    const alwaysMenu = Boolean(menu?.length);
    if (!alwaysMenu && total - GAP <= available) {
      setVisibleIds(new Set(actions.map((action) => action.id)));
      return;
    }
    let budget = available - overflowWidth;
    const ranked = actions
      .map((action, index) => ({ action, index }))
      .sort(
        (a, b) =>
          Number(Boolean(b.action.pinned)) - Number(Boolean(a.action.pinned)) ||
          (b.action.priority ?? 0) - (a.action.priority ?? 0) ||
          b.index - a.index,
      );
    const next = new Set<string>();
    for (const { action } of ranked) {
      const width = (widths.get(action.id) ?? 0) + GAP;
      if (action.pinned || width <= budget) {
        next.add(action.id);
        budget -= width;
      }
    }
    setVisibleIds((current) => {
      if (
        current &&
        current.size === next.size &&
        [...next].every((id) => current.has(id))
      ) {
        return current;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionKey, menu?.length]);

  React.useLayoutEffect(() => {
    recompute();
    const observer = new ResizeObserver(() => recompute());
    if (containerRef.current) observer.observe(containerRef.current);
    if (measureRef.current) observer.observe(measureRef.current);
    return () => observer.disconnect();
  }, [recompute]);

  const visible = actions.filter(
    (action) => !visibleIds || visibleIds.has(action.id),
  );
  const hidden = visibleIds
    ? actions.filter((action) => !visibleIds.has(action.id))
    : [];
  const overflowEntries: ActionMenuEntry[] = hidden
    .map(toEntry)
    .filter((entry): entry is ActionMenuEntry => entry !== null);
  if (menu?.length) {
    if (overflowEntries.length) {
      overflowEntries.push({ id: "__menu-separator", kind: "separator" });
    }
    overflowEntries.push(...menu);
  }

  return (
    <div
      className={cn(
        "relative flex min-w-8 flex-[1_1_0%] items-center justify-end gap-2 overflow-clip [overflow-clip-margin:4px]",
        className,
      )}
      ref={containerRef}
      style={{ minWidth }}
    >
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 flex w-max items-center gap-2"
        inert
        ref={measureRef}
      >
        {actions.map((action) => (
          <div className="flex shrink-0" data-action-id={action.id} key={action.id}>
            <InlineAction action={action} />
          </div>
        ))}
        <div className="flex shrink-0" data-action-id="__overflow">
          <span className={buttonClass("ghost", true)}>
            <EllipsisIcon />
          </span>
        </div>
      </div>
      {visibleIds
        ? visible.map((action) => <InlineAction action={action} key={action.id} />)
        : null}
      {overflowEntries.length ? (
        <RichMenu>
          <RichMenuTrigger
            aria-label={overflowLabel}
            className={buttonClass("ghost", true)}
            title={overflowLabel}
          >
            <EllipsisIcon />
          </RichMenuTrigger>
          <RichMenuContent>
            <MenuEntries entries={overflowEntries} />
          </RichMenuContent>
        </RichMenu>
      ) : null}
    </div>
  );
}
