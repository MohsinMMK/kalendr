"use client";

import { useCallback, useEffect, useState } from "react";

import { staffMutation, staffQuery, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { usePreviewAppointments } from "./preview-appointments";

export interface ShiftNote {
  id: string;
  text: string;
  author: string;
  at: string;
  canRemove: boolean;
}

/**
 * Handover notes for Today. With a database they are shared by the whole team;
 * in the preview they stay in this browser.
 */
export function useHandoverNotes(authorName: string) {
  const { operations, addHandoverNote, removeHandoverNote, database } = usePreviewAppointments();
  const [stored, setStored] = useState<ShiftNote[] | null>(null);
  const [loadError, setLoadError] = useState("");
  // Bumped when someone on another screen adds or removes a note.
  const notesVersion = useOptionalStaffSnapshot()?.notesVersion ?? 0;

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      setStored(await staffQuery<ShiftNote[]>("/api/staff/handover-notes", signal));
      setLoadError("");
    } catch (error: unknown) {
      if (signal?.aborted) return;
      setLoadError(error instanceof Error ? error.message : "Handover notes could not be loaded.");
    }
  }, []);

  useEffect(() => {
    if (!database) return;
    const controller = new AbortController();
    queueMicrotask(() => { void reload(controller.signal); });
    return () => controller.abort();
  }, [database, reload, notesVersion]);

  const notes: ShiftNote[] = database
    ? stored ?? []
    : operations.handoverNotes.map((note) => ({ ...note, canRemove: true }));

  /** Saves a note. Throws with a readable message when it could not be saved. */
  async function add(text: string): Promise<ShiftNote> {
    if (database) {
      const note = await staffMutation<ShiftNote>("/api/staff/handover-notes", "POST", { body: text });
      setStored((current) => [note, ...(current ?? [])]);
      return note;
    }
    const note = { id: `handover_${crypto.randomUUID()}`, text, author: authorName, at: operations.clockIso };
    if (!addHandoverNote(note)) throw new Error("Could not save the handover note in this browser.");
    return { ...note, canRemove: true };
  }

  async function remove(note: ShiftNote): Promise<void> {
    if (database) {
      await staffMutation(`/api/staff/handover-notes/${encodeURIComponent(note.id)}`, "DELETE", {});
      setStored((current) => (current ?? []).filter((entry) => entry.id !== note.id));
      return;
    }
    if (!removeHandoverNote(note.id)) throw new Error("Could not remove the handover note.");
  }

  return { notes, loading: database && stored === null && !loadError, loadError, add, remove, reload };
}
