"use client";

import Cropper, { type Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import { FlipHorizontal2, RotateCcw, RotateCw, Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { loadPictureSource, releasePictureSource, renderPicture, type PictureSource } from "@/lib/image-resize";
import {
  clamp,
  clampPosition,
  editRanges,
  isNeutral,
  minimumZoom,
  minimumZoomFor,
  neutralEdit,
  previewFilter,
  rotationDegrees,
  turnQuarter,
  type PictureEdit,
  type Point,
  type Size,
} from "@/lib/picture-edit";
import { cn } from "@/lib/utils";

/** The shape of the crop frame: round for a person, rounded for a logo, a plain rectangle for wide and landscape pictures. */
export type PictureShape = "round" | "rounded" | "rect";

export interface PictureRequest {
  /** The file just chosen, or the address of a picture that is already saved. */
  source: File | string;
  /** The exact size of the picture that comes out. */
  target: Size;
  shape: PictureShape;
  /** What the editor is called, such as "Logo" or "Photo". */
  subject: string;
  /** JPEG quality of the result. */
  quality?: number;
}

type Loaded = { status: "loading" } | { status: "ready"; source: PictureSource } | { status: "error"; message: string };

const arrowStep = 8;
const zoomKeyStep = 0.1;

function one(value: number | readonly number[]): number {
  return Array.isArray(value) ? (value[0] ?? 0) : (value as number);
}

function signed(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

interface SliderRowProps {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

function SliderRow({ label, value, display, min, max, step, onChange }: SliderRowProps) {
  return (
    <Field className="w-full">
      <Slider value={value} min={min} max={max} step={step} onValueChange={(next) => onChange(one(next))}>
        <div className="mb-2 flex items-baseline justify-between gap-3 text-sm">
          <FieldLabel>{label}</FieldLabel>
          <span className="text-muted-foreground tabular-nums" aria-hidden="true">{display}</span>
        </div>
      </Slider>
    </Field>
  );
}

function ToolButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="ghost" size="icon" aria-label={label} disabled={disabled} onClick={onClick} />}>
        {children}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

interface PictureEditorProps {
  request: PictureRequest;
  open: boolean;
  /** Called with the finished picture, or null when the person cancels or the picture cannot be read. */
  onFinish: (result: Blob | null) => void;
  onClosed: () => void;
  finalFocus: () => HTMLElement | null;
}

/**
 * The picture editor: a large crop area in the shape of the picture, then Crop and Adjust tabs. Drag, scroll, pinch or
 * use the arrow keys to place the picture and + and - to zoom; turn, straighten and flip it; change brightness, contrast
 * and saturation. Save gives back a JPEG of exactly the target size. Nothing is uploaded here.
 */
export function PictureEditor({ request, open, onFinish, onClosed, finalFocus }: PictureEditorProps) {
  const { source: input, target, shape, subject, quality } = request;
  const aspect = target.width / target.height;
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [edit, setEdit] = useState<PictureEdit>(neutralEdit);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  // The picture as shown at zoom 1 and the crop frame, as the cropper measured them, in screen pixels.
  const [media, setMedia] = useState<Size | null>(null);
  const [frame, setFrame] = useState<Size | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState("crop");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const area = useRef<Area | null>(null);

  useEffect(() => {
    let current: PictureSource | null = null;
    let stopped = false;
    loadPictureSource(input).then(
      (source) => {
        if (stopped) return releasePictureSource(source);
        current = source;
        setLoaded({ status: "ready", source });
      },
      (cause: unknown) => {
        if (!stopped) setLoaded({ status: "error", message: cause instanceof Error ? cause.message : "This picture could not be read." });
      },
    );
    return () => {
      stopped = true;
      releasePictureSource(current);
    };
  }, [input]);

  const source = loaded.status === "ready" ? loaded.source : null;
  const degrees = rotationDegrees(edit);
  const minZoom = useMemo(() => {
    if (media && frame) return minimumZoomFor(media, frame, degrees);
    return source ? minimumZoom(source.size, aspect, degrees) : 1;
  }, [media, frame, source, aspect, degrees]);
  const zoomValue = clamp(zoom, minZoom, editRanges.zoom.max);
  // A mirrored picture is turned the other way on screen, so a tilted one has its corners cut off on the other side.
  const screenDegrees = edit.flipped ? -degrees : degrees;
  // The picture stays where the frame is full: a tilted picture is not a box, so its corners must not slide in.
  const placed = useMemo(
    () => (media && frame ? clampPosition(crop, media, frame, zoomValue, screenDegrees) : crop),
    [media, frame, crop, zoomValue, screenDegrees],
  );
  const keep = useCallback((point: Point) => setCrop(media && frame ? clampPosition(point, media, frame, zoomValue, screenDegrees) : point), [media, frame, zoomValue, screenDegrees]);
  const pristine = isNeutral(edit) && zoomValue === 1 && crop.x === 0 && crop.y === 0;

  function change(next: Partial<PictureEdit>, recentre = false) {
    setEdit((previous) => ({ ...previous, ...next }));
    if (recentre) setCrop({ x: 0, y: 0 });
  }

  function turn(direction: 1 | -1) {
    setEdit((previous) => turnQuarter(previous, direction));
    setCrop({ x: 0, y: 0 });
  }

  function flip() {
    setEdit((previous) => ({ ...previous, flipped: !previous.flipped }));
    // Mirrors the picture about the frame, so what was at the left edge is at the right edge.
    setCrop((previous) => ({ x: -previous.x, y: previous.y }));
  }

  function reset() {
    setEdit(neutralEdit);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
  }

  function zoomBy(amount: number) {
    setZoom(clamp(zoomValue + amount, minZoom, editRanges.zoom.max));
  }

  function onStageKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(zoomKeyStep);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(-zoomKeyStep);
    }
  }

  async function save() {
    if (!source || !area.current || saving) return;
    setSaving(true);
    setProblem("");
    try {
      onFinish(await renderPicture(source, area.current, edit, target, quality));
    } catch (cause: unknown) {
      setProblem(cause instanceof Error ? cause.message : "The picture could not be prepared.");
      setSaving(false);
    }
  }

  const title = `Adjust ${subject.toLowerCase()}`;
  const filter = previewFilter(edit);
  const fatal = loaded.status === "error" ? loaded.message : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onFinish(null);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
    >
      <DialogPopup
        bottomStickOnMobile={false}
        showCloseButton={false}
        finalFocus={finalFocus}
        className="max-w-2xl max-sm:fixed max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:rounded-none max-sm:border-0"
        data-picture-editor=""
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <span className="sm:hidden">Drag to place the picture and pinch to zoom.</span>
            <span className="max-sm:hidden">Drag to place the picture and scroll or use the slider to zoom. With a keyboard, the arrow keys move it and + and - zoom.</span>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {fatal ? (
            <Alert variant="error"><AlertDescription>{fatal}</AlertDescription></Alert>
          ) : (
            <>
              <div
                className="relative h-[min(48dvh,24rem)] overflow-hidden rounded-xl bg-neutral-950 max-sm:h-[40dvh]"
                data-slot="picture-editor-stage"
                onKeyDown={onStageKey}
              >
                {source ? (
                  <Cropper
                    image={source.previewUrl}
                    crop={placed}
                    zoom={zoomValue}
                    rotation={degrees}
                    aspect={aspect}
                    minZoom={minZoom}
                    maxZoom={editRanges.zoom.max}
                    cropShape={shape === "round" ? "round" : "rect"}
                    showGrid
                    keyboardStep={arrowStep}
                    transform={`translate(${placed.x}px, ${placed.y}px) scale(${edit.flipped ? -1 : 1}, 1) rotate(${degrees}deg) scale(${zoomValue})`}
                    onCropChange={keep}
                    setMediaSize={(size) => setMedia((previous) => (previous?.width === size.width && previous.height === size.height ? previous : { width: size.width, height: size.height }))}
                    setCropSize={(size) => setFrame((previous) => (previous?.width === size.width && previous.height === size.height ? previous : { width: size.width, height: size.height }))}
                    onZoomChange={setZoom}
                    onCropComplete={(_, pixels) => { area.current = pixels; }}
                    onCropAreaChange={(_, pixels) => { area.current = pixels; }}
                    disableAutomaticStylesInjection
                    style={{ mediaStyle: { filter } }}
                    classes={{ cropAreaClassName: cn("text-black/60 border-white/70", shape === "rounded" && "rounded-[22%]") }}
                    cropperProps={{ role: "group", "aria-label": "Crop area. Arrow keys move the picture, plus and minus zoom." }}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-white/80">
                    <Spinner aria-label="Opening the picture" />
                  </div>
                )}
              </div>

              <Tabs value={tab} onValueChange={setTab}>
                <div className="flex items-center justify-between gap-2">
                  <TabsList>
                    <TabsTab value="crop">Crop</TabsTab>
                    <TabsTab value="adjust">Adjust</TabsTab>
                  </TabsList>
                  <TooltipProvider>
                    <div className="flex items-center gap-0.5" role="group" aria-label="Turn, flip and reset">
                      <ToolButton label="Rotate left" onClick={() => turn(-1)} disabled={!source}><RotateCcw aria-hidden="true" /></ToolButton>
                      <ToolButton label="Rotate right" onClick={() => turn(1)} disabled={!source}><RotateCw aria-hidden="true" /></ToolButton>
                      <ToolButton label="Flip" onClick={flip} disabled={!source}><FlipHorizontal2 aria-hidden="true" /></ToolButton>
                      <ToolButton label="Reset" onClick={reset} disabled={!source || pristine}><Undo2 aria-hidden="true" /></ToolButton>
                    </div>
                  </TooltipProvider>
                </div>
                <TabsPanel value="crop" className="flex min-h-36 flex-col gap-4 pt-2">
                  <SliderRow label="Zoom" value={zoomValue} display={`${Math.round(zoomValue * 100)}%`} min={minZoom} max={editRanges.zoom.max} step={editRanges.zoom.step} onChange={setZoom} />
                  <SliderRow label="Straighten" value={edit.straighten} display={`${edit.straighten.toFixed(1)}°`} {...editRanges.straighten} onChange={(value) => change({ straighten: value })} />
                </TabsPanel>
                <TabsPanel value="adjust" className="flex min-h-36 flex-col gap-4 pt-2">
                  <SliderRow label="Brightness" value={edit.brightness} display={signed(edit.brightness)} {...editRanges.brightness} onChange={(value) => change({ brightness: value })} />
                  <SliderRow label="Contrast" value={edit.contrast} display={signed(edit.contrast)} {...editRanges.contrast} onChange={(value) => change({ contrast: value })} />
                  <SliderRow label="Saturation" value={edit.saturation} display={signed(edit.saturation)} {...editRanges.saturation} onChange={(value) => change({ saturation: value })} />
                </TabsPanel>
              </Tabs>
              {problem ? <Alert variant="error"><AlertDescription>{problem}</AlertDescription></Alert> : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter className="max-sm:flex-row max-sm:justify-end">
          <DialogClose render={<Button type="button" variant="ghost" disabled={saving} />}>Cancel</DialogClose>
          <Button type="button" disabled={!source || saving} loading={saving} onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Where focus goes back to when the editor closes: the control that was in use. A menu item is about to disappear with
 * its menu, so for one the menu's own button is used.
 */
function focusOrigin(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const menu = active.closest('[role="menu"]');
  const owner = menu?.getAttribute("aria-labelledby");
  return (owner ? document.getElementById(owner) : null) ?? active;
}

/**
 * Asks for a picture to be edited and waits for the answer: `edit` resolves with the finished JPEG, or null when the
 * person cancelled. Render `editor` once, near the controls that call it; inside a Drawer it is rendered inside the
 * Drawer so the two stack and give focus back in order.
 */
export function usePictureEditor() {
  const [state, setState] = useState<{ request: PictureRequest; open: boolean } | null>(null);
  const settle = useRef<((result: Blob | null) => void) | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const edit = useCallback((request: PictureRequest): Promise<Blob | null> => {
    settle.current?.(null);
    returnTo.current = focusOrigin() ?? returnTo.current;
    return new Promise<Blob | null>((resolve) => {
      settle.current = resolve;
      setState({ request, open: true });
    });
  }, []);

  const finish = useCallback((result: Blob | null) => {
    settle.current?.(result);
    settle.current = null;
    setState((previous) => (previous ? { ...previous, open: false } : previous));
  }, []);

  // A page that goes away with the editor open (a closed Drawer) must not leave its caller waiting.
  useEffect(() => () => settle.current?.(null), []);

  const finalFocus = useCallback(() => (returnTo.current?.isConnected ? returnTo.current : null), []);

  const editor = state ? (
    <PictureEditor
      key={state.request.source instanceof File ? `${state.request.source.name}-${state.request.source.size}-${state.request.source.lastModified}` : state.request.source}
      request={state.request}
      open={state.open}
      onFinish={finish}
      onClosed={() => setState(null)}
      finalFocus={finalFocus}
    />
  ) : null;

  return { edit, editor };
}
