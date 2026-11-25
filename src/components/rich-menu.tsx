"use client";

/**
 * Rich menus built on ui-sdk (https://ui-sdk.dev) and styled like coss menus.
 * They open as a popover on wide screens and as a bottom sheet on small touch
 * screens, where submenus replace the current level like a cascader.
 */

import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemIcon,
  MenuItemIndicator,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** These rows take plain children; render-function children are not used here. */
type WithChildren<T extends React.ElementType> = Omit<React.ComponentProps<T>, "children"> & { children?: React.ReactNode };

const contentClass =
  "z-50 min-w-48 max-w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg/5 outline-none max-h-(--available-height) origin-(--transform-origin) not-dark:bg-clip-padding " +
  "transition-[opacity,scale] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 " +
  "data-[presentation=sheet]:w-full data-[presentation=sheet]:max-w-none data-[presentation=sheet]:max-h-[80dvh] data-[presentation=sheet]:rounded-b-none data-[presentation=sheet]:rounded-t-2xl data-[presentation=sheet]:p-2 data-[presentation=sheet]:pb-[max(0.5rem,env(safe-area-inset-bottom))] data-[presentation=sheet]:scale-100 data-[presentation=sheet]:opacity-100";

const itemClass =
  "flex min-h-8 w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-1 text-base text-foreground outline-none data-disabled:pointer-events-none data-disabled:opacity-64 data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:min-h-7 sm:text-sm in-data-[presentation=sheet]:min-h-11 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='opacity-'])]:opacity-80";

export function RichMenu(props: React.ComponentProps<typeof Menu>) {
  return <Menu presentation="auto" {...props} />;
}

export function RichMenuTrigger({
  className,
  ...props
}: React.ComponentProps<typeof MenuTrigger>) {
  return <MenuTrigger className={className} {...props} />;
}

export function RichMenuContent({
  className,
  sideOffset = 4,
  align = "end",
  ...props
}: React.ComponentProps<typeof MenuContent>) {
  return (
    <MenuContent
      align={align}
      className={cn(contentClass, className)}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export function RichMenuItem({
  className,
  icon,
  hint,
  children,
  ...props
}: WithChildren<typeof MenuItem> & {
  icon?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <MenuItem
      className={cn(
        itemClass,
        props.destructive && "text-destructive-foreground",
        className,
      )}
      {...props}
    >
      {icon ? <MenuItemIcon>{icon}</MenuItemIcon> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? (
        <span className="ms-auto shrink-0 text-muted-foreground text-xs">
          {hint}
        </span>
      ) : null}
    </MenuItem>
  );
}

export function RichMenuSub(props: React.ComponentProps<typeof MenuSub>) {
  return <MenuSub {...props} />;
}

export function RichMenuSubTrigger({
  className,
  icon,
  hint,
  children,
  ...props
}: WithChildren<typeof MenuSubTrigger> & {
  icon?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <MenuSubTrigger
      className={cn(itemClass, "data-open:bg-accent", className)}
      {...props}
    >
      {icon ? <MenuItemIcon>{icon}</MenuItemIcon> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? (
        <span className="max-w-28 shrink-0 truncate text-muted-foreground text-xs">
          {hint}
        </span>
      ) : null}
      <ChevronRightIcon className="-me-1 size-4 opacity-64 rtl:rotate-180" />
    </MenuSubTrigger>
  );
}

export function RichMenuSubContent({
  className,
  sideOffset = 0,
  align = "start",
  ...props
}: React.ComponentProps<typeof MenuSubContent>) {
  return (
    <MenuSubContent
      align={align}
      className={cn(contentClass, className)}
      side="right"
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export function RichMenuRadioGroup(
  props: React.ComponentProps<typeof MenuRadioGroup>,
) {
  return <MenuRadioGroup {...props} />;
}

export function RichMenuRadioItem({
  className,
  children,
  ...props
}: WithChildren<typeof MenuRadioItem>) {
  return (
    <MenuRadioItem className={cn(itemClass, "ps-2", className)} {...props}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <MenuItemIndicator>
          <CheckIcon className="size-4" />
        </MenuItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </MenuRadioItem>
  );
}

export function RichMenuCheckboxItem({
  className,
  children,
  ...props
}: WithChildren<typeof MenuCheckboxItem>) {
  return (
    <MenuCheckboxItem className={cn(itemClass, className)} {...props}>
      <span className="flex size-4 shrink-0 items-center justify-center">
        <MenuItemIndicator>
          <CheckIcon className="size-4" />
        </MenuItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </MenuCheckboxItem>
  );
}

export function RichMenuGroup(props: React.ComponentProps<typeof MenuGroup>) {
  return <MenuGroup {...props} />;
}

export function RichMenuGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof MenuGroupLabel>) {
  return (
    <MenuGroupLabel
      className={cn(
        "px-2 py-1.5 font-medium text-muted-foreground text-xs",
        className,
      )}
      {...props}
    />
  );
}

export function RichMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof MenuSeparator>) {
  return (
    <MenuSeparator
      className={cn("mx-2 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}
