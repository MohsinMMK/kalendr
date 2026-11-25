"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";
import { Palette } from "lucide-react";

import { OptionSelect } from "@/components/form-fields";
import { ImageUpload } from "@/components/image-upload";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { useUpgradePrompt } from "@/features/billing/upgrade-prompt";
import { useTerms } from "@/features/terms/business-profile-context";
import { accentSchema, brandSettingsSchema, cornerStyles, defaultBrand, readAccent, type BrandSettings, type CornerStyle } from "@/lib/brand-theme";

import { BrandPreview } from "./brand-preview";
import { useCatalogLookups } from "./clinic-catalog";
import { identityKeys, useBrand } from "./queries/identity";
import { staffMutation, StaffApiError } from "./queries/http";
import { useStaffAccess } from "./staff-access";

const swatches = ["#0f766e", "#2563eb", "#4f46e5", "#9333ea", "#e11d48", "#ea580c", "#f5b800", "#059669", "#334155"];

const cornerLabels: Record<CornerStyle, string> = { square: "Square corners", soft: "Soft corners", round: "Round corners" };

const sameBrand = (first: BrandSettings, second: BrandSettings): boolean =>
  first.accent === second.accent && first.corners === second.corners && first.hideBadge === second.hideBadge;

/**
 * Logo, colour and corners for the booking pages, the manage page and emails (feature 13). The owner picks one accent
 * colour; readable text on it is chosen automatically and the owner is told when that changes, and a live preview
 * on phone and desktop sits beside the controls. Staff screens keep Kalendr's own look.
 */
export function BrandSettingsPanel() {
  const t = useTerms();
  const { database, clinic } = useCatalogLookups();
  const canChange = useStaffAccess().can("settings.manage");
  // The logo and cover have their own switch under Team, so the owner can hand them to one person.
  const canChangePictures = useStaffAccess().can("brand.manage");
  const upgrade = useUpgradePrompt();
  const queryClient = useQueryClient();
  const brand = useBrand(database);
  const accentId = useId();
  const [draft, setDraft] = useState<BrandSettings>(defaultBrand);
  const [accentText, setAccentText] = useState("");
  const [device, setDevice] = useState<"phone" | "desktop">("phone");
  const [saving, setSaving] = useState(false);
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);

  const saved = brand.data?.settings;
  // Start the draft from the saved look once, and again whenever a different saved look arrives (after a save).
  useEffect(() => {
    if (!saved) return;
    const key = JSON.stringify(saved);
    if (key === loadedFrom) return;
    queueMicrotask(() => {
      setDraft(saved);
      setAccentText(saved.accent ?? "");
      setLoadedFrom(key);
    });
  }, [saved, loadedFrom]);

  const reading = useMemo(() => (draft.accent ? readAccent(draft.accent) : null), [draft.accent]);
  const accentProblem = accentText && !accentSchema.safeParse(accentText).success ? "Use a colour code like #0f766e." : "";
  const dirty = saved ? !sameBrand(saved, draft) : false;

  if (!database) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Palette aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Branding is not available in the preview</EmptyTitle>
          <EmptyDescription>Your colours are saved on the {t.business} database. Start the local database to try them.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (brand.isPending) return <Skeleton className="h-96 w-full rounded-xl" />;
  if (brand.isError) {
    return (
      <Alert variant="error">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          {brand.error.message}
          <Button size="sm" variant="outline" onClick={() => void brand.refetch()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }

  function setAccent(next: string) {
    setAccentText(next);
    const parsed = accentSchema.safeParse(next);
    if (parsed.success) setDraft((current) => ({ ...current, accent: parsed.data }));
    else if (next === "") setDraft((current) => ({ ...current, accent: null }));
  }

  async function save() {
    const parsed = brandSettingsSchema.safeParse(draft);
    if (!parsed.success) return;
    setSaving(true);
    try {
      await staffMutation("/api/staff/brand", "PUT", parsed.data);
      await queryClient.invalidateQueries({ queryKey: identityKeys.brand() });
      toastManager.add({ title: "Branding saved", description: "Your booking pages and emails use it now.", type: "success" });
    } catch (cause: unknown) {
      if (upgrade.fromError(cause)) {
        setDraft((current) => ({ ...current, hideBadge: false }));
      } else {
        toastManager.add({ title: "Could not save branding", description: cause instanceof StaffApiError ? cause.message : "Try again.", type: "error" });
      }
    } finally {
      setSaving(false);
    }
  }

  const data = brand.data;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <Frame>
          <FrameHeader>
            <FrameTitle>Logo and cover</FrameTitle>
            <FrameDescription>Shown at the top of your booking pages and in emails.</FrameDescription>
          </FrameHeader>
          <FramePanel className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
            <ImageUpload
              kind="business_logo"
              label="Logo"
              description="Square, at least 256 by 256."
              url={data.logoUrl}
              saves
              disabled={!canChangePictures}
              onChanged={() => queryClient.invalidateQueries({ queryKey: identityKeys.brand() })}
            />
            <ImageUpload
              kind="business_cover"
              label="Cover photo"
              description="A wide photo of your place, your team or your work. It runs across the top of your page, with your logo on it, and on the first booking screen. 16:9 works best."
              url={data.coverUrl}
              saves
              disabled={!canChangePictures}
              onChanged={() => queryClient.invalidateQueries({ queryKey: identityKeys.brand() })}
            />
          </FramePanel>
        </Frame>

        <Frame>
          <FrameHeader>
            <FrameTitle>Colour and corners</FrameTitle>
            <FrameDescription>One colour is enough. We choose readable text for it.</FrameDescription>
          </FrameHeader>
          <FramePanel className="flex flex-col gap-4">
            <Field invalid={Boolean(accentProblem)}>
              <FieldLabel htmlFor={accentId}>Accent colour</FieldLabel>
              <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Suggested colours">
                {swatches.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    disabled={!canChange}
                    aria-label={`Use ${swatch}`}
                    aria-pressed={draft.accent === swatch}
                    onClick={() => setAccent(swatch)}
                    style={{ backgroundColor: swatch }}
                    className="size-8 rounded-full border border-black/10 outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground pointer-coarse:size-11"
                  />
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick a colour"
                  disabled={!canChange}
                  value={draft.accent ?? "#0f766e"}
                  onChange={(event) => setAccent(event.target.value)}
                  className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5 pointer-coarse:size-11"
                />
                <Input
                  id={accentId}
                  size="lg"
                  value={accentText}
                  disabled={!canChange}
                  placeholder="#0f766e"
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(event) => setAccent(event.target.value.trim())}
                  className="max-w-40 font-mono"
                />
                {draft.accent ? <Button variant="ghost" size="sm" disabled={!canChange} onClick={() => setAccent("")}>Use Kalendr’s colour</Button> : null}
              </div>
              {accentProblem ? <FieldError match>{accentProblem}</FieldError> : <FieldDescription>Leave it empty to keep Kalendr’s own teal.</FieldDescription>}
            </Field>
            {reading && reading.notes.length > 0 ? (
              <Alert variant="info" role="status">
                <AlertDescription>{reading.notes.join(" ")}</AlertDescription>
              </Alert>
            ) : null}
            <Field>
              <FieldLabel>Corners</FieldLabel>
              <OptionSelect
                aria-label="Corners"
                value={draft.corners}
                disabled={!canChange}
                onValueChange={(next) => setDraft((current) => ({ ...current, corners: cornerStyles.find((style) => style === next) ?? current.corners }))}
                options={cornerStyles.map((style) => ({ value: style, label: cornerLabels[style] }))}
              />
            </Field>
            <Field>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <FieldLabel>Hide the Kalendr badge</FieldLabel>
                  <FieldDescription>Removes “Scheduling by Kalendr” from your pages and “using Kalendr” from emails.{data.canHideBadge ? "" : " Included from the Growth plan."}</FieldDescription>
                </div>
                <Switch
                  aria-label="Hide the Kalendr badge"
                  checked={draft.hideBadge}
                  disabled={!canChange}
                  onCheckedChange={(checked) => setDraft((current) => ({ ...current, hideBadge: checked }))}
                />
              </div>
            </Field>
          </FramePanel>
        </Frame>

        <div className="flex items-center gap-2">
          <Button disabled={!canChange || !dirty || saving || Boolean(accentProblem)} onClick={() => void save()}>
            {saving ? <Spinner /> : null}
            Save branding
          </Button>
          {dirty ? <Button variant="ghost" disabled={saving} onClick={() => saved && (setDraft(saved), setAccentText(saved.accent ?? ""))}>Discard changes</Button> : null}
        </div>
      </div>

      <Frame className="h-fit lg:sticky lg:top-0">
        <FrameHeader className="flex-row items-center justify-between gap-2">
          <FrameTitle>Preview</FrameTitle>
          <Tabs value={device} onValueChange={(value) => setDevice(value === "desktop" ? "desktop" : "phone")}>
            <TabsList aria-label="Preview size">
              <TabsTab value="phone">Phone</TabsTab>
              <TabsTab value="desktop">Desktop</TabsTab>
            </TabsList>
          </Tabs>
        </FrameHeader>
        <FramePanel className="bg-muted/40">
          <BrandPreview brand={draft} businessName={clinic.name} logoUrl={data.logoUrl} coverUrl={data.coverUrl} device={device} />
        </FramePanel>
      </Frame>
    </div>
  );
}
