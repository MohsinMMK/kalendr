"use client";

import { useRef, useState } from "react";
import { GripVertical, LockIcon, RotateCcw } from "lucide-react";

import { Sortable, SortableItem, SortableItemHandle } from "@/components/reui/sortable";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  isSidebarCustomised,
  maxSidebarNameLength,
  renameEntry,
  renameHeading,
  reorderSection,
  setEntryHidden,
  defaultSidebarSettings,
  type SidebarEntry,
  type SidebarEntryId,
  type SidebarSection,
} from "@/lib/sidebar";
import { cn } from "@/lib/utils";

import { entryActions, useEntryAvailable, useSidebarSettings } from "./sidebar-nav";

/**
 * A name that is changed in place. It saves when you leave the field or press Enter, Escape puts back what was there, and
 * emptying it brings back the standard name. When the saved name changes from outside (Reset, for one), the field follows.
 */
function NameInput({ label, value, placeholder, disabled, onCommit, onMove, className }: {
  label: string;
  value: string;
  placeholder: string;
  disabled?: boolean;
  onCommit: (name: string) => void;
  /**
   * Alt with an arrow key moves the entry, the keyboard way to reorder next to dragging. A name typed but not yet saved
   * comes along, so the move and the rename land in one save rather than the move overwriting the rename.
   */
  onMove?: (direction: -1 | 1, rename: string | undefined) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value);
  }
  /** The name to save, or undefined when the field holds what is already saved. */
  const pending = (): string | undefined => {
    const name = draft.trim();
    if (!name) setDraft(placeholder);
    return (name || placeholder) !== value ? name : undefined;
  };
  const commit = () => {
    const name = pending();
    if (name !== undefined) onCommit(name);
  };
  return (
    <Input
      aria-label={label}
      className={className}
      disabled={disabled}
      maxLength={maxSidebarNameLength}
      placeholder={placeholder}
      size="sm"
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      aria-keyshortcuts={onMove ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
      onKeyDown={(event) => {
        if (onMove && event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
          event.preventDefault();
          onMove(event.key === "ArrowUp" ? -1 : 1, pending());
        } else if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape" && draft !== value) {
          // Only the field's own undo: a second Escape still closes the panel.
          event.stopPropagation();
          setDraft(value);
        }
      }}
    />
  );
}

function EntryRow({ entry, disabled, onRename, onHidden, onMove, handle }: {
  entry: SidebarEntry;
  disabled: boolean;
  onRename: (name: string) => void;
  onHidden: (hidden: boolean) => void;
  onMove?: (direction: -1 | 1, rename: string | undefined) => void;
  /** The drag handle, left out for entries that cannot be moved. */
  handle: boolean;
}) {
  const Icon = entryActions[entry.id].icon;
  return (
    <div className="flex min-h-12 items-center gap-2 px-3 py-1.5">
      {handle ? (
        <SortableItemHandle
          render={<Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={`Move ${entry.label}. Drag it, or press Alt with an arrow key in its name.`} />}
        >
          <GripVertical aria-hidden="true" />
        </SortableItemHandle>
      ) : <span className="size-8 shrink-0" aria-hidden="true" />}
      <Icon aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground", entry.hidden && "opacity-50")} />
      <NameInput
        label={`Name for ${entry.defaultLabel}`}
        value={entry.label}
        placeholder={entry.defaultLabel}
        disabled={disabled}
        onCommit={onRename}
        onMove={onMove}
        className="min-w-0 flex-1"
      />
      {entry.locked ? (
        <Tooltip>
          <TooltipTrigger render={<span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground" aria-label={`${entry.label} is always shown`} role="img" tabIndex={0} />}>
            <LockIcon aria-hidden="true" className="size-4" />
          </TooltipTrigger>
          <TooltipPopup>Always shown. You can rename it.</TooltipPopup>
        </Tooltip>
      ) : (
        <Switch
          aria-label={`Show ${entry.label} in the sidebar`}
          checked={!entry.hidden}
          disabled={disabled}
          onCheckedChange={(checked: boolean) => onHidden(!checked)}
        />
      )}
    </div>
  );
}

function SectionEditor({ section, available, disabled }: {
  section: SidebarSection;
  available: (id: SidebarEntryId) => boolean;
  disabled: boolean;
}) {
  const { settings, save } = useSidebarSettings();
  // Entries this person has no access to, or whose feature is off, would never show, so they are not offered.
  const entries = section.entries.filter((entry) => available(entry.id));
  const listRef = useRef<HTMLDivElement>(null);
  // Alt with an arrow key in a name moves that entry one place. Focus follows it, because moving the row can drop focus.
  function move(id: SidebarEntryId, direction: -1 | 1, rename: string | undefined) {
    // Both changes start from the same settings, so they go in one save: two saves in one keypress would each start from
    // the layout before the other and the second would undo the first.
    const named = rename === undefined ? settings : renameEntry(settings, id, rename);
    const ids = entries.map((entry) => entry.id);
    const from = ids.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= ids.length) {
      if (named !== settings) save(named);
      return;
    }
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    save(reorderSection(named, section.id, ids));
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>(`[data-value="${id}"] input`)?.focus());
  }
  return (
    <Frame>
      <FrameHeader className="gap-1.5 px-3 py-2">
        <span className="text-xs font-medium text-muted-foreground">Section heading</span>
        <NameInput
          label="Section heading"
          value={section.label}
          placeholder={section.defaultLabel}
          disabled={disabled}
          onCommit={(name) => save(renameHeading(settings, section.id, name))}
        />
      </FrameHeader>
      <FramePanel className="p-0">
        <Sortable
          value={entries}
          onValueChange={(next) => save(reorderSection(settings, section.id, next.map((entry) => entry.id)))}
          getItemValue={(entry) => entry.id}
          role="group"
          aria-label={`${section.label}, in the order shown in the sidebar`}
          className="divide-y"
          ref={listRef}
        >
          {entries.map((entry) => (
            <SortableItem key={entry.id} value={entry.id} disabled={disabled || entries.length < 2} role="group" tabIndex={-1} className="bg-card">
              <EntryRow
                entry={entry}
                disabled={disabled}
                handle={!disabled && entries.length > 1}
                onRename={(name) => save(renameEntry(settings, entry.id, name))}
                onHidden={(hidden) => save(setEntryHidden(settings, entry.id, hidden))}
                onMove={disabled || entries.length < 2 ? undefined : (direction, rename) => move(entry.id, direction, rename)}
              />
            </SortableItem>
          ))}
        </Sortable>
      </FramePanel>
    </Frame>
  );
}

/**
 * Rename, hide and reorder the sidebar. Changes show at once and save for everyone on the team. Used in Settings and in
 * the "Customize sidebar" panel, so there is one editor in two places.
 */
export function SidebarEditor() {
  const { settings, resolved, canEdit, save } = useSidebarSettings();
  const available = useEntryAvailable();
  const profile = resolved.entries.profile;
  return (
    <div className="flex flex-col gap-4">
      {canEdit ? null : (
        <Alert role="note">
          <AlertDescription>Only the owner or an admin can change the sidebar.</AlertDescription>
        </Alert>
      )}
      {resolved.sections.map((section) => (
        <SectionEditor key={section.id} section={section} available={available} disabled={!canEdit} />
      ))}
      <Frame>
        <FrameHeader className="px-3 py-2">
          <h3 className="text-sm font-medium">In the account menu</h3>
        </FrameHeader>
        <FramePanel className="p-0">
          <EntryRow entry={profile} disabled={!canEdit} handle={false} onRename={(name) => save(renameEntry(settings, "profile", name))} onHidden={() => {}} />
        </FramePanel>
      </Frame>
      <p className="text-xs text-muted-foreground">
        Drag the handle to move an entry, or press Alt with the up or down arrow while you are in its name. Hiding an entry only
        removes it from the sidebar: what each person can open does not change.
      </p>
      <Button
        variant="ghost"
        className="self-start"
        disabled={!canEdit || !isSidebarCustomised(settings)}
        onClick={() => save(defaultSidebarSettings)}
      >
        <RotateCcw aria-hidden="true" />
        Reset sidebar
      </Button>
    </div>
  );
}

/** The "Customize sidebar" panel, opened from a section heading's ⋯ or from Settings. */
export function CustomizeSidebarDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Drawer
      position="right"
      open={open}
      onOpenChange={(next, details) => {
        // Letting go of a dragged entry sends a click to the page body, outside the panel. That is the end of a reorder, not a
        // click on the backdrop (which lands on the backdrop itself), so it does not close the panel.
        if (!next && details.reason === "outside-press" && details.event.target === document.body) return;
        onOpenChange(next);
      }}
    >
      <DrawerPopup showCloseButton variant="inset" aria-label="Customize sidebar">
        <DrawerHeader>
          <DrawerTitle>Customize sidebar</DrawerTitle>
          <DrawerDescription>Rename, hide and reorder what your team sees. Changes save right away.</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel>
          <SidebarEditor />
        </DrawerPanel>
        <DrawerFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DrawerFooter>
      </DrawerPopup>
    </Drawer>
  );
}
