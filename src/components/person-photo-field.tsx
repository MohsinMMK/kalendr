"use client";

import { Camera, ImagePlus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { usePictureEditor } from "@/components/picture-editor";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { blobToDataUrl, photoProblem } from "@/lib/image-resize";
import { personPhoto } from "@/lib/media";
import { cn } from "@/lib/utils";

interface PersonPhotoFieldProps {
  name: string;
  /** The photo as a data address, or null. */
  photo: string | null;
  onChange: (photo: string | null) => void;
  /** Called with a plain sentence when the photo cannot be used, and with "" when a new one is fine. */
  onProblem: (message: string) => void;
  /** Disables the controls, for someone who may look but not change. */
  disabled?: boolean;
  avatarClassName?: string;
  /** The line under the button, such as what the photo is cropped to. */
  hint?: ReactNode;
  className?: string;
}

/**
 * A team member's booking-profile photo: an avatar and one Change photo menu (upload, adjust, remove). A chosen photo
 * opens in the picture editor first and comes out a square JPEG of the size every profile photo is stored at.
 */
export function PersonPhotoField({ name, photo, onChange, onProblem, disabled = false, avatarClassName = "size-16", hint = "Cropped to a circle. JPEG, PNG or WebP.", className }: PersonPhotoFieldProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { edit, editor } = usePictureEditor();

  async function open(source: File | string) {
    try {
      const blob = await edit({ source, target: personPhoto, shape: "round", subject: "Photo", quality: personPhoto.quality });
      if (!blob) return;
      onChange(await blobToDataUrl(blob));
      onProblem("");
    } catch (cause: unknown) {
      onProblem(cause instanceof Error ? cause.message : "This photo could not be read.");
    }
  }

  function choose(file: File | undefined) {
    if (!file) return;
    const issue = photoProblem(file);
    if (issue) {
      onProblem(issue);
      return;
    }
    void open(file);
  }

  return (
    <div className={cn("flex items-center gap-4", className)}>
      <PersonAvatar name={name} image={photo} className={avatarClassName} />
      <div className="flex flex-col items-start gap-1">
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          aria-label="Profile photo"
          tabIndex={-1}
          disabled={disabled}
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <Menu>
          <MenuTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled} />}>
            <Camera aria-hidden="true" />
            {photo ? "Change photo" : "Add photo"}
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem onClick={() => fileInput.current?.click()}><ImagePlus aria-hidden="true" /> {photo ? "Upload a new photo" : "Upload a photo"}</MenuItem>
            {photo ? <MenuItem onClick={() => void open(photo)}><SlidersHorizontal aria-hidden="true" /> Adjust photo</MenuItem> : null}
            {photo ? <MenuItem variant="destructive" onClick={() => onChange(null)}><Trash2 aria-hidden="true" /> Remove photo</MenuItem> : null}
          </MenuPopup>
        </Menu>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {editor}
      </div>
    </div>
  );
}
