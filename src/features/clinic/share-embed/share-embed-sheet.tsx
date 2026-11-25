"use client";

import { Share2 } from "lucide-react";
import { useState } from "react";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";

import { EmailTimesPanel } from "./email-times-panel";
import { EmbedPanel } from "./embed-panel";
import { LinkPanel } from "./link-panel";
import { useEmbedContext } from "./queries";
import { TrackingPanel } from "./tracking-panel";

const WHOLE_PAGE = "__page__";

/** "Share and embed": the link, QR code and short links, the website embed builder, times for an email and tracking. */
export function ShareEmbedSheet({ open, onOpenChange, initialServiceSlug = null }: { open: boolean; onOpenChange: (open: boolean) => void; initialServiceSlug?: string | null }) {
  const context = useEmbedContext(open);
  const [tab, setTab] = useState("link");
  const [service, setService] = useState<string | null>(initialServiceSlug);
  const serviceSlug = service && context.data?.services.some((entry) => entry.slug === service) ? service : null;
  const everything = context.data;

  return (
    <ResponsiveDrawer open={open} onOpenChange={onOpenChange}>
      <ResponsiveDrawerPopup className="sm:max-w-2xl">
        <DrawerHeader>
          <DrawerTitle>Share and embed</DrawerTitle>
          <DrawerDescription>Send people to your booking page, put it on your website, or email open times.</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel>
          {context.isPending ? (
            <div className="flex flex-col gap-3" role="status" aria-label="Loading"><Skeleton className="h-11 w-full" /><Skeleton className="h-40 w-full" /></div>
          ) : context.isError || !everything ? (
            <Alert variant="error"><AlertDescription>
              <p>{context.error?.message ?? "This could not be loaded."}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void context.refetch()}>Try again</Button>
            </AlertDescription></Alert>
          ) : (
            <div className="flex flex-col gap-4">
              <SelectField
                label="What to share"
                value={serviceSlug ?? WHOLE_PAGE}
                options={[{ value: WHOLE_PAGE, label: "My whole booking page" }, ...everything.services.map((entry) => ({ value: entry.slug, label: entry.hidden ? `${entry.name} (hidden)` : entry.name }))]}
                onValueChange={(value) => setService(value === WHOLE_PAGE ? null : value)}
              />
              <Tabs value={tab} onValueChange={(next) => setTab(String(next))}>
                <ScrollAreaPrimitive.Root className="-mx-1">
                  <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <ScrollAreaPrimitive.Content className="px-1 pb-1">
                      <TabsList variant="underline" aria-label="Share options">
                        <TabsTab value="link" className="min-h-11">Link and QR</TabsTab>
                        <TabsTab value="embed" className="min-h-11">Website embed</TabsTab>
                        <TabsTab value="email" className="min-h-11">Times for an email</TabsTab>
                        <TabsTab value="tracking" className="min-h-11">Tracking</TabsTab>
                      </TabsList>
                    </ScrollAreaPrimitive.Content>
                  </ScrollAreaPrimitive.Viewport>
                  <ScrollBar orientation="horizontal" />
                </ScrollAreaPrimitive.Root>
                <TabsPanel value="link" className="pt-4"><LinkPanel context={everything} serviceSlug={serviceSlug} /></TabsPanel>
                <TabsPanel value="embed" className="pt-4">{tab === "embed" ? <EmbedPanel context={everything} serviceSlug={serviceSlug} /> : null}</TabsPanel>
                <TabsPanel value="email" className="pt-4">{tab === "email" ? <EmailTimesPanel context={everything} serviceSlug={serviceSlug} /> : null}</TabsPanel>
                <TabsPanel value="tracking" className="pt-4">{tab === "tracking" ? <TrackingPanel /> : null}</TabsPanel>
              </Tabs>
            </div>
          )}
        </DrawerPanel>
      </ResponsiveDrawerPopup>
    </ResponsiveDrawer>
  );
}

/** A button that opens the sheet. */
export function ShareEmbedButton({ serviceSlug = null, label = "Share and embed", variant = "outline" }: { serviceSlug?: string | null; label?: string; variant?: "outline" | "default" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size="sm" onClick={() => setOpen(true)}><Share2 aria-hidden="true" /> {label}</Button>
      {open ? <ShareEmbedSheet open onOpenChange={setOpen} initialServiceSlug={serviceSlug} /> : null}
    </>
  );
}

