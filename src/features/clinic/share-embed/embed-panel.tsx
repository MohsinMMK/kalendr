"use client";

import { Copy } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { OptionSelect, SelectField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { embedThemes } from "@/lib/embed/appearance";
import { defaultEmbedOptions, embedModeLabels, embedModes, embedSnippet, eventListenerSnippet, type EmbedMode, type EmbedOptions } from "@/lib/embed/builder";
import type { EmbedContextView } from "@/server/email-times";

import { copyText } from "./copy";

interface KalendrGlobal {
  embed: (options: Record<string, unknown>) => { destroy: () => void };
}

function loadEmbedScript(): Promise<KalendrGlobal> {
  const existing = (window as unknown as { Kalendr?: KalendrGlobal }).Kalendr;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/embed.js";
    script.async = true;
    script.onload = () => {
      const loaded = (window as unknown as { Kalendr?: KalendrGlobal }).Kalendr;
      if (loaded) resolve(loaded);
      else reject(new Error("The preview could not start."));
    };
    script.onerror = () => reject(new Error("The preview could not load."));
    document.head.appendChild(script);
  });
}

/** Runs the real embed on this page, so what the owner sees is what their website will show. */
function LivePreview({ business, options }: { business: string; options: EmbedOptions }) {
  const mount = useRef<HTMLDivElement>(null);
  const key = JSON.stringify([business, options]);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const problem = failure?.key === key ? failure.message : "";
  useEffect(() => {
    let instance: { destroy: () => void } | undefined;
    let cancelled = false;
    loadEmbedScript().then((kalendr) => {
      if (cancelled || !mount.current) return;
      // A floating button would leave the preview box, so the preview shows it as a popup button.
      instance = kalendr.embed({
        business, service: options.service ?? undefined, mode: options.mode === "floating" ? "popup" : options.mode, mount: mount.current,
        theme: options.theme, brand: options.brand ?? undefined, label: options.label || undefined,
      });
    }).catch((error: unknown) => setFailure({ key, message: error instanceof Error ? error.message : "The preview could not start." }));
    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [business, options, key]);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-sm">Preview</p>
      <ScrollAreaPrimitive.Root className="rounded-lg border bg-muted/20">
        <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-[28rem] rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ScrollAreaPrimitive.Content>
            <div ref={mount} className="p-3" aria-live="polite" />
          </ScrollAreaPrimitive.Content>
        </ScrollAreaPrimitive.Viewport>
        <ScrollBar orientation="vertical" />
        <ScrollBar orientation="horizontal" />
      </ScrollAreaPrimitive.Root>
      {problem ? <p role="alert" className="text-destructive-foreground text-xs">{problem}</p> : null}
      {options.mode === "floating" ? <p className="text-muted-foreground text-xs">On your website this button stays in the {options.position} corner of every page. Here it is shown as a popup button.</p> : null}
    </div>
  );
}

/** Choose how booking appears on a website and copy one snippet. */
export function EmbedPanel({ context, serviceSlug }: { context: EmbedContextView; serviceSlug: string | null }) {
  const [mode, setMode] = useState<EmbedMode>(defaultEmbedOptions.mode);
  const [theme, setTheme] = useState<EmbedOptions["theme"]>("auto");
  const [brand, setBrand] = useState<string | null>(null);
  const [label, setLabel] = useState(defaultEmbedOptions.label);
  const [position, setPosition] = useState<EmbedOptions["position"]>("right");
  const options = useMemo<EmbedOptions>(() => ({ mode, service: serviceSlug, theme, brand, label, position }), [mode, serviceSlug, theme, brand, label, position]);
  const snippet = embedSnippet(context.origin, context.clinicSlug, options);
  const brandInvalid = brand !== null && !/^#[0-9a-fA-F]{6}$/.test(brand);
  const previewOptions = useMemo(() => (brandInvalid ? { ...options, brand: null } : options), [options, brandInvalid]);

  return (
    <div className="flex flex-col gap-5">
      <Field className="w-full">
        <FieldLabel>How it shows</FieldLabel>
        <SegmentedControl size="lg" className="w-full" render={<ToggleGroupPrimitive aria-label="How it shows" value={[mode]} onValueChange={(next: string[]) => { const chosen = embedModes.find((entry) => entry === next[0]); if (chosen) setMode(chosen); }} />}>
          {embedModes.map((entry) => (
            <SegmentedControlItem key={entry} className="min-h-11 flex-1" render={<TogglePrimitive value={entry} />}>
              {embedModeLabels[entry].label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <FieldDescription>{embedModeLabels[mode].description}</FieldDescription>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Theme" value={theme} options={embedThemes.map((value) => ({ value, label: value === "auto" ? "Match the visitor's device" : value === "light" ? "Light" : "Dark" }))} onValueChange={(value) => setTheme(embedThemes.find((entry) => entry === value) ?? "auto")} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="embed-brand" className="font-medium text-sm">Brand colour</label>
          <div className="flex gap-2">
            <input type="color" aria-label="Pick a brand colour" value={brand && !brandInvalid ? brand : "#262626"} onChange={(event) => setBrand(event.target.value)} className="size-11 shrink-0 cursor-pointer rounded-md border bg-transparent p-1" />
            <TextField id="embed-brand" label="" aria-label="Brand colour hex" placeholder="Business colour" value={brand ?? ""} maxLength={7} fieldClassName="[&>div:first-child]:hidden"
              error={brandInvalid ? "Use six letters or digits, like #1f6feb." : undefined} onChange={(event) => setBrand(event.target.value.trim() === "" ? null : event.target.value.trim())} />
          </div>
        </div>
        {mode !== "inline" ? <TextField label="Button text" value={label} maxLength={40} onChange={(event) => setLabel(event.target.value)} /> : null}
        {mode === "floating" ? (
          <Field className="w-full">
            <FieldLabel>Corner</FieldLabel>
            <OptionSelect value={position} options={[{ value: "right", label: "Bottom right" }, { value: "left", label: "Bottom left" }]} onValueChange={(value) => setPosition(value === "left" ? "left" : "right")} />
          </Field>
        ) : null}
      </div>
      <LivePreview business={context.clinicSlug} options={previewOptions} />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium text-sm">Paste this into your website</p>
          <Button size="sm" variant="outline" onClick={() => void copyText(snippet, "Snippet")}><Copy aria-hidden="true" /> Copy snippet</Button>
        </div>
        <ScrollAreaPrimitive.Root className="rounded-lg bg-muted">
          <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-56 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ScrollAreaPrimitive.Content>
              <pre aria-label="Embed snippet" className="p-3 font-mono text-xs leading-5"><code>{snippet}</code></pre>
            </ScrollAreaPrimitive.Content>
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar orientation="vertical" />
          <ScrollBar orientation="horizontal" />
        </ScrollAreaPrimitive.Root>
      </div>
      <Collapsible className="rounded-lg border p-3 text-sm">
        <CollapsibleTrigger className="min-h-11 w-full text-start font-medium">Know when someone books</CollapsibleTrigger>
        <CollapsiblePanel>
        <p className="py-2 text-muted-foreground text-xs">Your page hears <code>opened</code>, <code>service_selected</code>, <code>slot_selected</code>, <code>booked</code>, <code>rescheduled</code>, <code>cancelled</code> and <code>failed</code>. They carry ids and times only, never a name, email or phone.</p>
        <ScrollAreaPrimitive.Root className="rounded-lg bg-muted">
          <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-40 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ScrollAreaPrimitive.Content>
              <pre className="p-3 font-mono text-xs leading-5"><code>{eventListenerSnippet}</code></pre>
            </ScrollAreaPrimitive.Content>
          </ScrollAreaPrimitive.Viewport>
          <ScrollBar orientation="vertical" />
          <ScrollBar orientation="horizontal" />
        </ScrollAreaPrimitive.Root>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => void copyText(eventListenerSnippet, "Code")}><Copy aria-hidden="true" /> Copy</Button>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
