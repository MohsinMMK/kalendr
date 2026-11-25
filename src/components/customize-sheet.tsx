"use client";

import { ArrowDownIcon, ArrowUpIcon, LockIcon, RotateCcwIcon } from "lucide-react";

import { OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import {
  Drawer,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Switch } from "@/components/ui/switch";
import {
  arrangeList,
  moveInList,
  withListLayout,
  withOption,
  type LayoutOption,
  type PageLayout,
} from "@/lib/workspace-layout";
import { cn } from "@/lib/utils";

export type CustomizeList = {
  id: string;
  label: string;
  description?: string;
  items: { id: string; label: string; description?: string; locked?: boolean }[];
};

export type CustomizeOption =
  | { id: string; label: string; description?: string; kind: "choice"; choices: { value: string; label: string }[]; defaultValue: string }
  | { id: string; label: string; description?: string; kind: "switch"; defaultValue: boolean };

/** Reads an option with its default. */
export function layoutOption<T extends LayoutOption>(layout: PageLayout, id: string, fallback: T): T {
  const value = layout.options?.[id];
  return (typeof value === typeof fallback ? value : fallback) as T;
}

/** Edits one list: show or hide each item, and move it up or down. */
export function CustomizeListEditor({ list, layout, onChange, disabled }: {
  list: CustomizeList;
  layout: PageLayout;
  onChange: (next: PageLayout) => void;
  disabled?: boolean;
}) {
  const stored = layout.lists?.[list.id];
  const arranged = arrangeList(list.items, stored);
  const ids = arranged.map((entry) => entry.item.id);
  const hidden = new Set(stored?.hidden ?? []);
  const set = (order: string[], nextHidden: Set<string>) =>
    onChange(withListLayout(layout, list.id, { order, hidden: [...nextHidden] }));

  return (
    <Frame>
      <FrameHeader className="px-3 py-2">
        <h3 className="truncate font-medium text-sm">{list.label}</h3>
        {list.description ? <p className="truncate text-muted-foreground text-xs">{list.description}</p> : null}
      </FrameHeader>
      <FramePanel className="p-0">
        <ul className="divide-y" aria-label={list.label}>
          {arranged.map(({ item }, index) => {
            const isHidden = hidden.has(item.id);
            return (
              <li key={item.id} className="flex min-h-11 items-center gap-2 px-3 py-1.5">
                <div className="flex shrink-0 items-center">
                  <Button
                    aria-label={`Move ${item.label} up`}
                    disabled={disabled || index === 0}
                    onClick={() => set(moveInList(ids, item.id, -1), hidden)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    aria-label={`Move ${item.label} down`}
                    disabled={disabled || index === arranged.length - 1}
                    onClick={() => set(moveInList(ids, item.id, 1), hidden)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <ArrowDownIcon />
                  </Button>
                </div>
                <div className={cn("min-w-0 flex-1", isHidden && "text-muted-foreground")}>
                  <p className="truncate text-sm">{item.label}</p>
                  {item.description ? <p className="truncate text-muted-foreground text-xs">{item.description}</p> : null}
                </div>
                {item.locked ? (
                  <LockIcon aria-label="Always shown" className="size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <Switch
                    aria-label={`Show ${item.label}`}
                    checked={!isHidden}
                    disabled={disabled}
                    onCheckedChange={(checked: boolean) => {
                      const next = new Set(hidden);
                      if (checked) next.delete(item.id);
                      else next.add(item.id);
                      set(ids, next);
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </FramePanel>
    </Frame>
  );
}

/** Edits a page's view options. */
export function CustomizeOptionsEditor({ options, layout, onChange, disabled }: {
  options: CustomizeOption[];
  layout: PageLayout;
  onChange: (next: PageLayout) => void;
  disabled?: boolean;
}) {
  return (
    <Frame>
      <FrameHeader className="px-3 py-2">
        <h3 className="truncate font-medium text-sm">View</h3>
      </FrameHeader>
      <FramePanel className="p-0">
        <ul className="divide-y">
          {options.map((option) => (
            <li key={option.id} className="flex min-h-11 items-center justify-between gap-3 px-3 py-1.5">
              <div className="min-w-0">
                <p className="truncate text-sm">{option.label}</p>
                {option.description ? <p className="truncate text-muted-foreground text-xs">{option.description}</p> : null}
              </div>
              {option.kind === "switch" ? (
                <Switch
                  aria-label={option.label}
                  checked={layoutOption(layout, option.id, option.defaultValue)}
                  disabled={disabled}
                  onCheckedChange={(checked: boolean) => onChange(withOption(layout, option.id, checked === option.defaultValue ? undefined : checked))}
                />
              ) : (
                <OptionSelect
                  aria-label={option.label}
                  className="w-auto min-w-32"
                  disabled={disabled}
                  onValueChange={(value) => onChange(withOption(layout, option.id, value === option.defaultValue ? undefined : value))}
                  options={option.choices}
                  size="sm"
                  value={layoutOption(layout, option.id, option.defaultValue)}
                />
              )}
            </li>
          ))}
        </ul>
      </FramePanel>
    </Frame>
  );
}

/** The "Customize" panel of a page: what shows, in what order, and how it opens. Saved for the whole business. */
export function CustomizeSheet({ open, onOpenChange, title, description, lists, options = [], layout, onChange, canEdit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  lists: CustomizeList[];
  options?: CustomizeOption[];
  layout: PageLayout;
  onChange: (next: PageLayout) => void;
  canEdit: boolean;
}) {
  return (
    <Drawer position="right" open={open} onOpenChange={onOpenChange}>
      <DrawerPopup showCloseButton variant="inset" aria-label={title}>
        <DrawerHeader>
          <DrawerTitle>{title}</DrawerTitle>
          <DrawerDescription>
            {canEdit
              ? description ?? "Changes save right away for everyone on your team."
              : "Only the owner or an admin can change this layout."}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerPanel className="flex flex-col gap-4">
          {options.length ? <CustomizeOptionsEditor disabled={!canEdit} layout={layout} onChange={onChange} options={options} /> : null}
          {lists.map((list) => (
            <CustomizeListEditor disabled={!canEdit} key={list.id} layout={layout} list={list} onChange={onChange} />
          ))}
        </DrawerPanel>
        <DrawerFooter>
          <Button disabled={!canEdit} onClick={() => onChange({})} variant="ghost">
            <RotateCcwIcon aria-hidden="true" />
            Reset to default
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DrawerFooter>
      </DrawerPopup>
    </Drawer>
  );
}
