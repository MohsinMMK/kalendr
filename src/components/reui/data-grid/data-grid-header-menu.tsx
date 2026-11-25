"use client"

import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  EyeOffIcon,
  FilterIcon,
  GripVerticalIcon,
  LockIcon,
  PencilIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
} from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { DragEvent } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu"
import { MAX_COLUMN_NAME } from "@/lib/grid-columns"
import { cn } from "@/lib/utils"

import { useGridCustomize } from "./data-grid-customize"

export type ColumnSortState = false | "asc" | "desc"

export interface ColumnHeaderMenuProps {
  id: string
  title: string
  /** Absent when the column cannot be sorted. */
  sort?: { direction: ColumnSortState; set: (direction: ColumnSortState) => void }
  className?: string
  disabled?: boolean
}

const dragType = "application/x-kalendr-column"

/**
 * One header menu for every table, as Notion has it: the column's name opens Rename (inline, in the header), Sort, Filter, Move,
 * Hide, and for the business's own fields Edit and Delete. Dragging the header moves the column too. People who may not arrange
 * columns see Sort and Filter only. Needs a `GridCustomizeProvider` above it for the arranging items.
 */
export function ColumnHeaderMenu({ id, title, sort, className, disabled }: ColumnHeaderMenuProps) {
  const customize = useGridCustomize()
  const [renaming, setRenaming] = useState(false)
  const [dropping, setDropping] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  // Enter or Escape in the name box hands focus back to the column's button, not to the page.
  const refocus = useRef(false)
  useEffect(() => {
    if (!renaming && refocus.current) {
      refocus.current = false
      wrapper.current?.querySelector<HTMLButtonElement>("button")?.focus()
    }
  }, [renaming])
  const canEdit = Boolean(customize?.canEdit)
  const field = customize?.field
  const isField = Boolean(field?.isField(id))
  const system = Boolean(customize?.isSystem(id))
  const filter = customize?.filter && (customize.canFilter?.(id) ?? true) ? customize.filter : undefined

  const trigger = (
    <Button
      variant="ghost"
      disabled={disabled}
      className={cn(
        "text-secondary-foreground/80 hover:bg-secondary data-[state=open]:bg-secondary hover:text-foreground data-[state=open]:text-foreground px-2 font-normal h-6 rounded-lg",
        className
      )}
    >
      <span className="truncate">{title}</span>
      {sort ? <SortIcon direction={sort.direction} /> : null}
    </Button>
  )

  if (renaming && customize) {
    return (
      <RenameInput
        title={title}
        maxLength={isField ? FIELD_NAME_MAX : MAX_COLUMN_NAME}
        onCancel={(byKey) => {
          refocus.current = byKey
          setRenaming(false)
        }}
        onCommit={(name, byKey) => {
          refocus.current = byKey
          setRenaming(false)
          if (name !== title) customize.rename(id, name)
        }}
      />
    )
  }

  const hasItems = canEdit || sort || filter || (isField && field?.canManage)
  if (!hasItems) {
    return <div className="text-secondary-foreground/80 inline-flex h-full items-center font-normal text-[0.8125rem]">{title}</div>
  }

  // Any header is a place to drop; the grip at its edge is what picks one up (the name itself opens the menu on press).
  const dropProps =
    canEdit && customize
      ? {
          onDragOver: (event: DragEvent) => {
            if (!event.dataTransfer.types.includes(dragType)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = "move"
            setDropping(true)
          },
          onDragLeave: () => setDropping(false),
          onDrop: (event: DragEvent) => {
            setDropping(false)
            const from = event.dataTransfer.getData(dragType)
            if (from) {
              event.preventDefault()
              customize.moveTo(from, id)
            }
          },
        }
      : {}

  return (
    <div
      ref={wrapper}
      data-column-id={id}
      data-dropping={dropping || undefined}
      className="group/header relative -ms-2 flex h-full items-center rounded-lg data-dropping:bg-primary/10 data-dropping:ring-1 data-dropping:ring-primary/40"
      {...dropProps}
    >
      {canEdit ? (
        <span
          data-drag-handle=""
          aria-hidden="true"
          draggable
          className="absolute end-3.5 top-1/2 z-10 flex h-5 w-3 -translate-y-1/2 cursor-grab items-center justify-center text-muted-foreground opacity-0 transition-opacity group-focus-within/header:opacity-100 group-hover/header:opacity-100 active:cursor-grabbing"
          onDragStart={(event) => {
            event.dataTransfer.setData(dragType, id)
            event.dataTransfer.effectAllowed = "move"
            if (wrapper.current) event.dataTransfer.setDragImage(wrapper.current, 12, 12)
          }}
        >
          <GripVerticalIcon className="size-3.5" />
        </span>
      ) : null}
      <Menu>
        <MenuTrigger render={trigger} />
        <MenuPopup align="start" className="w-56">
          {canEdit ? (
            <MenuItem onClick={() => setRenaming(true)}>
              <PencilIcon aria-hidden="true" />
              Rename
            </MenuItem>
          ) : null}
          {isField && field?.canManage ? (
            <MenuItem onClick={() => field.edit(id)}>
              <SlidersHorizontalIcon aria-hidden="true" />
              Edit field
            </MenuItem>
          ) : null}
          {canEdit || (isField && field?.canManage) ? (sort || filter ? <MenuSeparator /> : null) : null}
          {sort ? (
            <>
              <MenuItem onClick={() => sort.set(sort.direction === "asc" ? false : "asc")}>
                <ArrowUpIcon aria-hidden="true" />
                <span className="grow">Sort ascending</span>
                {sort.direction === "asc" ? <CheckIcon aria-hidden="true" className="text-primary" /> : null}
              </MenuItem>
              <MenuItem onClick={() => sort.set(sort.direction === "desc" ? false : "desc")}>
                <ArrowDownIcon aria-hidden="true" />
                <span className="grow">Sort descending</span>
                {sort.direction === "desc" ? <CheckIcon aria-hidden="true" className="text-primary" /> : null}
              </MenuItem>
            </>
          ) : null}
          {filter ? (
            <MenuItem onClick={() => filter(id)}>
              <FilterIcon aria-hidden="true" />
              Filter
            </MenuItem>
          ) : null}
          {canEdit && customize ? (
            <>
              {sort || filter ? <MenuSeparator /> : null}
              <MenuItem disabled={!customize.canMove(id, -1)} onClick={() => customize.move(id, -1)}>
                <ArrowLeftIcon aria-hidden="true" />
                Move left
              </MenuItem>
              <MenuItem disabled={!customize.canMove(id, 1)} onClick={() => customize.move(id, 1)}>
                <ArrowRightIcon aria-hidden="true" />
                Move right
              </MenuItem>
              <MenuItem onClick={() => customize.hide(id)}>
                <EyeOffIcon aria-hidden="true" />
                Hide
              </MenuItem>
            </>
          ) : null}
          {system && canEdit ? (
            <>
              <MenuSeparator />
              <MenuItem disabled>
                <LockIcon aria-hidden="true" />
                <span className="grow text-xs">Can&apos;t be deleted, Kalendr needs it</span>
              </MenuItem>
            </>
          ) : null}
          {isField && field?.canManage ? (
            <>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => field.remove(id)}>
                <Trash2Icon aria-hidden="true" />
                Delete field
              </MenuItem>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  )
}

function SortIcon({ direction }: { direction: ColumnSortState }) {
  if (direction === "desc") return <ArrowDownIcon aria-hidden="true" className="size-3.25" />
  if (direction === "asc") return <ArrowUpIcon aria-hidden="true" className="size-3.25" />
  return <ChevronsUpDownIcon aria-hidden="true" className="mt-px size-3.25 opacity-60" />
}

/** The header title turned into a text box: Enter or leaving it saves, Escape keeps the old name, an empty name brings the default back. */
// The business's own fields take longer names than a renamed column (the same limit as the field's own form).
const FIELD_NAME_MAX = 60

function RenameInput({ title, maxLength, onCommit, onCancel }: {
  title: string
  maxLength: number
  onCommit: (name: string, byKey: boolean) => void
  onCancel: (byKey: boolean) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    // The menu hands focus back to its trigger as it closes; take it again once that has happened.
    const frame = requestAnimationFrame(() => {
      // On a slow machine typing may already have begun; never select (and so replace) what was typed.
      if (input.current?.value !== title) return
      input.current?.focus()
      input.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  const finish = (save: boolean, byKey: boolean) => {
    if (done.current) return
    done.current = true
    if (save) onCommit(input.current?.value ?? title, byKey)
    else onCancel(byKey)
  }
  return (
    <div className="-ms-2 flex h-full items-center">
      <Input
        ref={input}
        size="sm"
        className="w-40"
        defaultValue={title}
        maxLength={maxLength}
        aria-label={`Name of the ${title} column`}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            finish(true, true)
          } else if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            finish(false, true)
          }
          event.stopPropagation()
        }}
        onBlur={() => finish(true, false)}
      />
    </div>
  )
}
