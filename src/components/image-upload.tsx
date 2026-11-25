"use client";

import Image from "next/image";
import { ImageIcon, ImagePlus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui/button";
import { usePictureEditor } from "@/components/picture-editor";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { photoProblem } from "@/lib/image-resize";
import { mediaIdFromUrl, mediaShapes, mediaSubjects, mediaTargets, type MediaKind } from "@/lib/media";
import { cn } from "@/lib/utils";
import { staffMutation, staffUpload } from "@/features/clinic/staff-snapshot-provider";

const frameShape: Record<MediaKind, string> = {
  business_logo: "aspect-square w-28",
  business_cover: "aspect-video w-full",
  service: "aspect-[4/3] w-full max-w-xs",
  staff_photo: "aspect-square w-28",
};

export interface ImageUploadProps {
  kind: MediaKind;
  /** The service the picture belongs to. Only for service pictures. */
  ownerId?: string;
  label: string;
  description?: string;
  /** The saved picture's address, if there is one. */
  url?: string | null;
  /** False in preview mode: the picture shows for this visit only and nothing is sent. */
  saves: boolean;
  disabled?: boolean;
  /** Called after a picture is saved or removed, to reload what the page shows. */
  onChanged?: () => Promise<void> | void;
  className?: string;
}

/** What `usePictureUpload` needs: one business picture, saved straight away (or held in the tab in preview). */
export type PictureUploadOptions = Pick<ImageUploadProps, "kind" | "ownerId" | "url" | "saves" | "disabled" | "onChanged">;

/**
 * The add, replace and remove behaviour behind `ImageUpload`, for screens that show the picture their own way (the
 * profile header, for one). A chosen photo opens in the picture editor first, and the browser crops and shrinks it to
 * the size the kind of picture needs; a saved picture that is still being virus-checked shows from this tab's own copy
 * until it is served. Render `editor` once, next to the controls.
 */
export function usePictureUpload({ kind, ownerId, url, saves, disabled = false, onChanged }: PictureUploadOptions) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { edit, editor } = usePictureEditor();
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
  const [problem, setProblem] = useState("");
  // What the last change returned, until the page reloads the saved address. In preview it is a
  // picture held in this browser tab (or a removal) on top of the sample, and nothing is sent.
  const [override, setOverride] = useState<{ from: string | null; to: string | null } | null>(null);
  // A saved picture is virus-checked before it is served. Until then this tab shows its own copy.
  const [checking, setChecking] = useState<{ url: string; preview: string } | null>(null);

  useEffect(() => () => {
    if (override?.to?.startsWith("blob:")) URL.revokeObjectURL(override.to);
  }, [override]);

  useEffect(() => {
    if (!checking) return;
    let attempts = 0;
    let stopped = false;
    const timer = window.setInterval(async () => {
      attempts += 1;
      const ready = await fetch(checking.url, { cache: "no-store" }).then((response) => response.ok, () => false);
      if (stopped) return;
      if (ready || attempts >= 60) {
        window.clearInterval(timer);
        if (!ready) setProblem("The picture is still being checked, or it was refused. Reload the page later to see it.");
        setChecking(null);
      }
    }, 3_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      URL.revokeObjectURL(checking.preview);
    };
  }, [checking]);

  const saved = url ?? null;
  // A new address (a reload, or another sample in preview) replaces any change made here.
  const [shownFor, setShownFor] = useState(saved);
  if (shownFor !== saved) {
    setShownFor(saved);
    setOverride(null);
  }
  const current = override && override.from === saved ? override.to : saved;
  const shown = checking && current === checking.url ? checking.preview : current;
  const locked = disabled || busy !== null;

  /** Opens the editor on a new file or on the saved picture, and saves what comes back. Cancelling changes nothing. */
  async function editAndSave(source: File | string) {
    const blob = await edit({ source, target: mediaTargets[kind], shape: mediaShapes[kind], subject: mediaSubjects[kind] });
    if (!blob) return;
    setBusy("upload");
    try {
      if (!saves) {
        setOverride({ from: saved, to: URL.createObjectURL(blob) });
        return;
      }
      const form = new FormData();
      form.set("file", blob, "picture.jpg");
      form.set("kind", kind);
      if (ownerId) form.set("ownerId", ownerId);
      const result = await staffUpload<{ url: string; scanStatus?: string }>("/api/staff/media", form);
      if (result.scanStatus === "pending") setChecking({ url: result.url, preview: URL.createObjectURL(blob) });
      setOverride({ from: saved, to: result.url });
      await onChanged?.();
    } catch (cause: unknown) {
      setProblem(cause instanceof Error ? cause.message : "The picture could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function choose(file: File | undefined) {
    if (!file || locked) return;
    setProblem("");
    const issue = photoProblem(file);
    if (issue) {
      setProblem(issue);
      return;
    }
    await editAndSave(file);
  }

  /** Opens the editor on the picture already saved. The original is not kept, so this crops what was saved. */
  async function adjust() {
    if (locked || !shown) return;
    setProblem("");
    await editAndSave(shown);
  }

  async function remove() {
    if (locked) return;
    setProblem("");
    if (!saves) {
      setOverride({ from: saved, to: null });
      return;
    }
    const id = current ? mediaIdFromUrl(current) : null;
    if (!id) return;
    setBusy("remove");
    try {
      await staffMutation(`/api/staff/media/${encodeURIComponent(id)}`, "DELETE", {});
      setOverride({ from: saved, to: null });
      await onChanged?.();
    } catch (cause: unknown) {
      setProblem(cause instanceof Error ? cause.message : "The picture could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  /** Opens the file chooser. */
  function pick() {
    if (!locked) fileInput.current?.click();
  }

  const input = (
    <input
      ref={fileInput}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      disabled={locked}
      onChange={(event) => {
        void choose(event.target.files?.[0]);
        event.target.value = "";
      }}
    />
  );

  return { shown, current, busy, problem, checking: Boolean(checking && current === checking.url), locked, pick, choose, adjust, remove, input, editor, fileInput };
}

/**
 * Adds, replaces and removes one business picture. The browser crops and
 * shrinks the photo before it is sent, so uploads stay small.
 */
export function ImageUpload({
  kind,
  ownerId,
  label,
  description,
  url,
  saves,
  disabled = false,
  onChanged,
  className,
}: ImageUploadProps) {
  const inputId = useId();
  const { shown, current, busy, problem, checking, locked, choose, adjust, remove, fileInput, editor } = usePictureUpload({ kind, ownerId, url, saves, disabled, onChanged });
  const [dragging, setDragging] = useState(false);

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    if (locked || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void choose(event.dataTransfer.files[0]);
  }

  return (
    <Field invalid={Boolean(problem)} className={cn("w-full", className)}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <div
        className={cn(
          "relative flex items-center justify-center overflow-hidden rounded-lg border bg-muted/40 transition-colors",
          frameShape[kind],
          current ? "border-solid" : "border-dashed",
          dragging && "border-primary bg-accent",
        )}
        data-dragging={dragging || undefined}
        onDragOver={onDragOver}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {shown ? (
          <Image
            src={shown}
            alt={`${label} now in use`}
            fill
            unoptimized
            sizes={kind === "business_cover" ? "(min-width: 768px) 640px, 100vw" : "320px"}
            className="object-cover"
          />
        ) : (
          <div className="flex flex-col items-center gap-1 px-3 text-center text-muted-foreground">
            <ImageIcon className="size-5" aria-hidden="true" />
            <span className="text-xs max-md:hidden">{kind === "business_logo" ? "Drop here" : "Drag a picture here"}</span>
            <span className="text-xs md:hidden">No picture</span>
          </div>
        )}
        {busy ? (
          <div className="absolute inset-0 flex items-center justify-center bg-background/64">
            <Spinner aria-hidden="true" />
          </div>
        ) : checking ? (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/72 px-2 text-center text-xs font-medium">
            <Spinner aria-hidden="true" className="size-3.5 shrink-0" />
            <span className={kind === "business_logo" ? "sr-only" : undefined}>Checking picture…</span>
          </div>
        ) : null}
      </div>
      <input
        ref={fileInput}
        id={inputId}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        tabIndex={-1}
        disabled={locked}
        onChange={(event) => {
          void choose(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => fileInput.current?.click()}>
          {busy === "upload" ? <Spinner aria-hidden="true" /> : <ImagePlus aria-hidden="true" />}
          {busy === "upload" ? "Uploading…" : current ? "Replace" : "Add picture"}
        </Button>
        {current ? (
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => void adjust()}>
            <SlidersHorizontal aria-hidden="true" />
            Adjust
          </Button>
        ) : null}
        {current ? (
          <Button type="button" variant="ghost" size="sm" disabled={locked} onClick={() => void remove()}>
            {busy === "remove" ? <Spinner aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
            Remove
          </Button>
        ) : null}
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {!saves ? (
        <FieldDescription>Preview doesn&apos;t save pictures. This one shows until you leave the page.</FieldDescription>
      ) : null}
      <FieldError match={Boolean(problem)} role="alert">{problem}</FieldError>
      {editor}
      <span className="sr-only" aria-live="polite">
        {busy === "upload" ? "Uploading picture" : busy === "remove" ? "Removing picture" : checking ? "Checking picture" : ""}
      </span>
    </Field>
  );
}
