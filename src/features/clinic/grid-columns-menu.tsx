"use client";

import { Columns3, LockIcon, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Menu, MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";

import type { GridColumns } from "./use-grid-columns";

/**
 * Every column of a table in one place: tick to show, untick to hide, and bring the defaults back. Hidden columns are found here
 * again. Only people who may arrange columns see it; for everyone else the table simply shows the business's arrangement,
 * except while a saved view's columns are on screen, which anyone may change or reset.
 */
export function GridColumnsMenu({ columns, label = "Columns" }: { columns: GridColumns; label?: string }) {
  if (!columns.canEdit && !columns.personal) return null;
  const onlyOneShowing = columns.visible.length <= 1;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="outline" size="sm" className="shrink-0" />}>
        <Columns3 aria-hidden="true" />
        {label}
      </MenuTrigger>
      <MenuPopup align="end" className="w-60">
        <MenuGroup>
          <MenuGroupLabel>Show or hide columns</MenuGroupLabel>
          {columns.all.map((column) => (
            <MenuCheckboxItem
              key={column.id}
              checked={!column.hidden}
              disabled={!column.hidden && onlyOneShowing}
              onCheckedChange={(checked) => (checked ? columns.show(column.id) : columns.hide(column.id))}
            >
              <span className="flex items-center gap-2">
                {column.title}
                {column.system ? <LockIcon aria-label="Kalendr needs this field, so it can't be deleted" className="size-3 text-muted-foreground" /> : null}
              </span>
            </MenuCheckboxItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuItem disabled={!columns.changed} onClick={columns.reset}>
          <RotateCcw aria-hidden="true" />
          Reset columns
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
