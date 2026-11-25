"use client"

import { createContext, useContext } from "react"

/**
 * What a table lets people do to its columns, Notion style. A grid that wants the full column menu wraps itself in a provider
 * with these actions (the business's layout is the single source of column state), and every column header it renders reads them.
 * Without a provider a header behaves as it always did, so the other tables are untouched.
 */
export interface GridCustomize {
  /** Owners and admins arrange columns for the whole business; everyone else only sees them and sorts or filters. */
  canEdit: boolean
  /** Whether the column can step one place left or right among the columns showing. */
  canMove: (id: string, direction: -1 | 1) => boolean
  rename: (id: string, name: string) => void
  hide: (id: string) => void
  move: (id: string, direction: -1 | 1) => void
  /** Drops a dragged column where another one sits. */
  moveTo: (id: string, targetId: string) => void
  /** Adds this column to the filter bar. Absent when the table has no filter at all. */
  filter?: (id: string) => void
  /** Whether this column can be filtered. Absent means every column can, when `filter` is given. */
  canFilter?: (id: string) => boolean
  /** Opens "Add a field", for the "+" at the end of the header. Absent when this table has no fields of its own. */
  onAddField?: () => void
  /** A field the system needs: can be renamed and hidden, never deleted. */
  isSystem: (id: string) => boolean
  /** The business's own fields: Edit and Delete in the menu, only for people who may change fields. */
  field?: {
    isField: (id: string) => boolean
    canManage: boolean
    edit: (id: string) => void
    remove: (id: string) => void
  }
}

const GridCustomizeContext = createContext<GridCustomize | null>(null)

export const GridCustomizeProvider = GridCustomizeContext.Provider

export function useGridCustomize(): GridCustomize | null {
  return useContext(GridCustomizeContext)
}
