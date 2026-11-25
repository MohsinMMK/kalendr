"use client";

import { useEffect, useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, X } from "lucide-react";
import { ShareEmbedButton } from "./share-embed/share-embed-sheet";
import { TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { toastManager } from "@/components/ui/toast";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import type { Clinic } from "@/lib/domain";
import { useTerms } from "@/features/terms/business-profile-context";
import { identityKeys, useEmbedOrigins } from "./queries/identity";
import { staffMutation } from "./queries/http";
import { useStaffAccess } from "./staff-access";
import {
  bookingUrl,
  normalizeExactOrigin,
  websiteSnippet,
  type WebsiteMethod,
  type WebsiteSetup,
} from "./website-connection";

export function WebsiteInstallGuide({
  clinic,
}: {
  clinic: Pick<Clinic, "name" | "slug">;
}) {
  const t = useTerms();
  const domain = t.business.toLowerCase().replace(/\s+/g, "-");
  const [origin, setOrigin] = useState("");
  const [websiteOrigin, setWebsiteOrigin] = useState("");
  const [method, setMethod] = useState<WebsiteMethod>("link");
  const [message, setMessage] = useState("");
  const inputId = useId();
  const queryClient = useQueryClient();
  const canChange = useStaffAccess().can("settings.manage");
  const allowed = useEmbedOrigins();
  useEffect(() => {
    queueMicrotask(() => setOrigin(window.location.origin));
  }, []);
  const normalized = normalizeExactOrigin(
    websiteOrigin,
    process.env.NODE_ENV !== "production",
  );
  const setup: WebsiteSetup = {
    id: "clinic-widget",
    name: clinic.name,
    bookingOrigin: origin,
    websiteOrigins: normalized ? [normalized] : [],
    method,
    buttonLabel: `Book ${t.anAppointment}`,
    iframeHeight: 800,
  };
  const code = origin ? websiteSnippet(setup, clinic) : "";
  const url = origin ? bookingUrl(setup, false, clinic) : "";
  const ready = Boolean(origin && (method === "link" || normalized));

  /** Saves the website so the booking widget may load on it. Saving one that is already allowed changes nothing. */
  async function allowWebsite(site: string): Promise<boolean> {
    try {
      await staffMutation("/api/staff/embed-origins", "POST", { origin: site });
      await queryClient.invalidateQueries({ queryKey: identityKeys.embedOrigins() });
      return true;
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not allow this website", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
      return false;
    }
  }

  async function disallow(id: string) {
    try {
      await staffMutation(`/api/staff/embed-origins/${id}`, "DELETE", {});
      await queryClient.invalidateQueries({ queryKey: identityKeys.embedOrigins() });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not remove this website", description: cause instanceof Error ? cause.message : "Try again.", type: "error" });
    }
  }

  async function copyCode() {
    // Generating the code for a website is what allows that website, so nobody has to ask anyone else.
    if (method !== "link" && normalized && canChange && !(await allowWebsite(normalized))) return;
    await copy(code, "Installation code");
  }

  async function copy(value: string, description: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${description} copied.`);
    } catch (cause: unknown) {
      console.error(
        "Website installation copy failed",
        cause instanceof Error ? cause.name : "Unknown error",
      );
      setMessage("Copy failed. Select the code below and copy it manually.");
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-label={`${t.Business} website installation`}>
      <Frame>
        <FrameHeader>
          <h3 className="text-sm font-semibold">Share your booking page</h3>
          <FrameDescription className="text-xs">
            Use this {t.business}’s link immediately, or generate the code for your
            website. The address uses this deployment.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-3">
          <p className="min-w-0 rounded-lg bg-muted px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">
            {url || "Loading booking address…"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!origin}
              onClick={() => void copy(url, "Booking link")}
            >
              <Copy aria-hidden="true" />
              Copy {t.business} booking link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              render={
                <a
                  href={`/book/${clinic.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              Review {t.customer} page
              <ExternalLink aria-hidden="true" />
            </Button>
            <ShareEmbedButton />
          </div>
        </FramePanel>
      </Frame>
      <Frame>
        <FrameHeader>
          <h3 className="text-sm font-semibold">Add booking to your website</h3>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          <Tabs
            value={method}
            onValueChange={(value) => {
              if (value === "link" || value === "iframe" || value === "popup") {
                setMethod(value);
                setMessage("");
              }
            }}
          >
            <TabsList aria-label="Website installation method" activateOnFocus className="w-full">
              <TabsTab value="link" className="flex-1 max-sm:h-auto max-sm:px-1 max-sm:py-1 max-sm:text-xs max-sm:whitespace-normal">Booking link</TabsTab>
              <TabsTab value="iframe" className="flex-1 max-sm:h-auto max-sm:px-1 max-sm:py-1 max-sm:text-xs max-sm:whitespace-normal">Inline booking</TabsTab>
              <TabsTab value="popup" className="flex-1 max-sm:h-auto max-sm:px-1 max-sm:py-1 max-sm:text-xs max-sm:whitespace-normal">Popup button</TabsTab>
            </TabsList>
            <TabsPanel value="link" className="pt-3 text-xs text-muted-foreground">
              Paste the link into a website button, email, or message. No
              frame-origin configuration is needed for a normal link.
            </TabsPanel>
            <TabsPanel value="iframe" className="pt-3 text-xs text-muted-foreground">
              Place the booking page inside your website. The website is allowed
              automatically when you copy the code.
            </TabsPanel>
            <TabsPanel value="popup" className="pt-3 text-xs text-muted-foreground">
              Add a booking button that opens the {t.customer} flow in a popup. Your site
              must allow the widget script. The website is allowed automatically when you
              copy the code.
            </TabsPanel>
          </Tabs>
          {method !== "link" && (
            <TextField
              id={inputId}
              label={`${t.Business} website origin`}
              value={websiteOrigin}
              onChange={(event) => {
                setWebsiteOrigin(event.target.value);
                setMessage("");
              }}
              placeholder={`https://www.your-${domain}.example`}
              hint="Use the exact HTTPS address of your website, without a path. Copying the code allows this website to show your booking page."
              error={
                websiteOrigin && !normalized
                  ? "Enter an exact HTTPS origin without paths, credentials, or wildcards."
                  : undefined
              }
            />
          )}
          <ScrollAreaPrimitive.Root className="rounded-lg bg-muted">
            <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-72 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ScrollAreaPrimitive.Content>
                <pre aria-label={`${t.Business} installation code`} className="p-3 font-mono text-xs leading-5"><code>{code || "Loading installation code…"}</code></pre>
              </ScrollAreaPrimitive.Content>
            </ScrollAreaPrimitive.Viewport>
            <ScrollBar orientation="vertical" />
            <ScrollBar orientation="horizontal" />
          </ScrollAreaPrimitive.Root>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={!ready}
            onClick={() => void copyCode()}
          >
            <Copy aria-hidden="true" />
            Copy {t.business} installation code
          </Button>
          {method !== "link" && normalized && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground [overflow-wrap:anywhere]">{normalized}</span>{" "}
              {allowed.data?.some((entry) => entry.origin === normalized) ? "is allowed to show your booking page." : "will be allowed to show your booking page when you copy the code."}
            </p>
          )}
          <p role="status" className="text-xs text-muted-foreground empty:hidden">
            {message}
          </p>
        </FramePanel>
      </Frame>
      <Frame>
        <FrameHeader>
          <h3 className="text-sm font-semibold">Websites allowed to show your booking page</h3>
          <FrameDescription className="text-xs">Any other website that tries to frame your booking page is blocked by the browser.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-2">
          {allowed.isPending ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
          {allowed.isError ? <p className="text-xs text-destructive-foreground">{allowed.error.message}</p> : null}
          {allowed.data && allowed.data.length === 0 ? <p className="text-xs text-muted-foreground">No websites yet. Pick Inline booking or Popup button above and copy the code to add one.</p> : null}
          {allowed.data?.map((entry) => (
            <div key={entry.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-1.5">
              <p className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{entry.origin}</p>
              <Button size="icon-sm" variant="ghost" disabled={!canChange} aria-label={`Stop allowing ${entry.origin}`} onClick={() => void disallow(entry.id)}><X aria-hidden="true" /></Button>
            </div>
          ))}
        </FramePanel>
      </Frame>
    </section>
  );
}
