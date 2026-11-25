"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CircleCheck, Copy, ExternalLink } from "lucide-react";

import { RowButton } from "@/components/row-button";
import { TextField, TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack } from "@/components/ui/progress";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";
import { demoClinic } from "@/lib/demo-data";
import { useTerms } from "@/features/terms/business-profile-context";

import { bookingUrl, readWebsiteSetups, saveWebsiteSetups, toWebsiteDraft, validateWebsiteDraft, websiteSnippet } from "./website-connection";
import type { WebsiteDraft, WebsiteMethod, WebsiteSetup } from "./website-connection";

type Step = "choose" | "configure" | "install" | "review" | "result" | "remove";

const methods: { id: WebsiteMethod; title: string; fit: string; requires: string }[] = [
  { id: "link", title: "Hosted booking link", fit: "Fastest setup · works with most site builders", requires: "A place to add a link or button" },
  { id: "iframe", title: "Inline booking", fit: "Keep the full booking flow on your page", requires: "HTML editing and approved frame origins" },
  { id: "popup", title: "Popup booking button", fit: "Open booking without leaving the page", requires: "Script access and approved frame origins" },
  { id: "api", title: "Custom API integration", fit: "Build a tailored booking experience", requires: "A developer and a website backend" },
];

const stepProgress: Partial<Record<Step, { index: number; label: string }>> = {
  configure: { index: 2, label: "Configure" },
  install: { index: 3, label: "Install and test" },
  review: { index: 4, label: "Review and save" },
};

const allowLocalHttp = process.env.NODE_ENV !== "production";

function newDraft(method: WebsiteMethod, bookingOrigin: string): WebsiteDraft {
  return { id: crypto.randomUUID(), name: "", websiteOriginsInput: "", bookingOriginInput: bookingOrigin, method, buttonLabel: "Book an appointment", iframeHeightInput: "760" };
}

export function WebsiteConnectionWorkspace({ onBack }: { onBack: () => void }) {
  const t = useTerms();
  const domain = t.business.toLowerCase().replace(/\s+/g, "-");
  const [step, setStep] = useState<Step>("choose");
  const [saved, setSaved] = useState<WebsiteSetup[]>([]);
  const [draft, setDraft] = useState<WebsiteDraft | null>(null);
  const [removing, setRemoving] = useState<WebsiteSetup | null>(null);
  const [appOrigin, setAppOrigin] = useState("");
  const [message, setMessage] = useState("");
  const [resultText, setResultText] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    queueMicrotask(() => {
      setAppOrigin(window.location.origin);
      try {
        setSaved(readWebsiteSetups());
      } catch (error: unknown) {
        console.error("Could not load preview website setups", error);
        setMessage("Saved website setups could not be read in this browser.");
      }
    });
  }, []);
  useEffect(() => { if (step !== "choose") headingRef.current?.focus(); }, [step]);

  const checked = draft ? validateWebsiteDraft(draft, saved, allowLocalHttp, `https://${domain}.example`) : {};
  const setup = checked.setup;
  const method = methods.find((item) => item.id === draft?.method);
  const localBookingUrl = appOrigin ? `${appOrigin}/book/${encodeURIComponent(demoClinic.slug)}` : `/book/${encodeURIComponent(demoClinic.slug)}`;
  const messageIsConfirmation = message.includes("copied");

  function choose(nextMethod: WebsiteMethod) {
    setDraft(newDraft(nextMethod, appOrigin));
    setMessage("");
    setStep("configure");
  }

  function edit(item: WebsiteSetup) {
    setDraft(toWebsiteDraft(item));
    setMessage("");
    setStep("configure");
  }

  function update<K extends keyof WebsiteDraft>(key: K, value: WebsiteDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setMessage("");
  }

  function continueToInstall() {
    if (!checked.setup) {
      setMessage(checked.error ?? "Check this website setup before continuing.");
      return;
    }
    setMessage("");
    setStep("install");
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMessage(`${label} copied.`);
    } catch (error: unknown) {
      console.error("Could not copy website setup text", error);
      setMessage("Clipboard unavailable. Select and copy the code shown here.");
    }
  }

  function save() {
    if (!setup) {
      setMessage("Check the setup details before saving.");
      setStep("configure");
      return;
    }
    const next = saved.some((item) => item.id === setup.id) ? saved.map((item) => item.id === setup.id ? setup : item) : [...saved, setup];
    try {
      saveWebsiteSetups(next);
      setSaved(next);
      setResultText(`${setup.name} was saved in this browser preview. Install the code on the website and verify it there before treating the connection as live.`);
      setMessage("");
      setStep("result");
    } catch (error: unknown) {
      console.error("Could not save preview website setup", error);
      setMessage("Could not save in this browser. Check storage access and try again.");
    }
  }

  function remove() {
    if (!removing) return;
    const next = saved.filter((item) => item.id !== removing.id);
    try {
      saveWebsiteSetups(next);
      setSaved(next);
      setResultText(`${removing.name} was removed from this browser preview. No website code or deployed setting was changed.`);
      setRemoving(null);
      setMessage("");
      setStep("result");
    } catch (error: unknown) {
      console.error("Could not remove preview website setup", error);
      setMessage("Could not remove this setup in the browser. Check storage access and try again.");
    }
  }

  const progress = stepProgress[step];

  return <div className="flex flex-col gap-4">
    <Button variant="ghost" size="sm" className="-ms-2 self-start" onClick={step === "choose" || step === "result" ? onBack : () => { setMessage(""); setStep(step === "review" ? "install" : step === "install" ? "configure" : "choose"); }}>
      <ArrowLeft aria-hidden="true" /> {step === "choose" || step === "result" ? "Back to settings" : "Back"}
    </Button>
    <div>
      <h3 ref={headingRef} tabIndex={-1} className="font-heading text-base font-semibold outline-none">{step === "choose" ? "Connect a website" : step === "configure" ? `Configure ${method?.title.toLowerCase() ?? "website setup"}` : step === "install" ? "Install and test" : step === "review" ? "Review website setup" : step === "remove" ? "Remove website setup" : "Website setup recorded"}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{step === "choose" ? "Choose the way a website will open booking. A saved setup is a plan in this browser until the website code and deployment settings are installed and tested." : step === "result" ? "The browser preview records setup choices; it cannot connect or verify an external website." : "Keep the website origin separate from the Kalendr booking origin. External installation and any frame approval happen outside this preview."}</p>
    </div>
    {progress ? (
      <Progress value={(progress.index / 4) * 100} aria-label="Website setup progress">
        <div className="flex items-baseline justify-between gap-3">
          <ProgressLabel className="text-sm font-medium">{progress.label}</ProgressLabel>
          <span className="text-xs text-muted-foreground tabular-nums">Step {progress.index} of 4</span>
        </div>
        <ProgressTrack><ProgressIndicator /></ProgressTrack>
      </Progress>
    ) : null}
    {message ? (
      <Alert role={messageIsConfirmation ? "status" : "alert"} variant={messageIsConfirmation ? "success" : "error"}>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    ) : null}

    {step === "choose" ? <>
      {saved.length ? (
        <Frame>
          <FrameHeader className="flex-row flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-sm font-semibold">Saved preview setups</h4>
            <span className="text-xs text-muted-foreground">{saved.length} recorded</span>
          </FrameHeader>
          <FramePanel className="flex flex-col divide-y py-1">
            {saved.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{item.name}</p>
                  <p className="break-all text-xs text-muted-foreground">{methods.find((entry) => entry.id === item.method)?.title} · {item.websiteOrigins.join(", ")}</p>
                  <p className="text-xs text-muted-foreground">Saved in this browser · Installation not verified</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => edit(item)}>Edit</Button>
                  <Button size="sm" variant="destructive-outline" onClick={() => { setRemoving(item); setMessage(""); setStep("remove"); }}>Remove</Button>
                </div>
              </div>
            ))}
          </FramePanel>
        </Frame>
      ) : null}
      <Frame>
        <FrameHeader>
          <h4 className="text-sm font-semibold">Choose a connection method</h4>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-1 p-1.5">
          {methods.map((item) => (
            <RowButton key={item.id} variant="outline" onClick={() => choose(item.id)} className="justify-between gap-3 border-transparent bg-transparent px-3 py-2.5 shadow-none">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">{item.title}{" "}{item.id === "link" ? <Badge variant="info">Recommended</Badge> : null}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{item.fit}</span>
                <span className="block text-xs text-muted-foreground">Needs: {item.requires}</span>
              </span>
              <ArrowRight className="shrink-0" aria-hidden="true" />
            </RowButton>
          ))}
        </FramePanel>
      </Frame>
    </> : null}

    {step === "configure" && draft ? (
      <Frame>
        <FramePanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Setup name" value={draft.name} onChange={(event) => update("name", event.target.value)} maxLength={80} placeholder={`Main ${t.business} website`} />
              <TextField label="Kalendr booking origin" value={draft.bookingOriginInput} onChange={(event) => update("bookingOriginInput", event.target.value)} placeholder={`https://booking.${domain}.example`} inputMode="url" />
            </div>
            <p className="text-xs text-muted-foreground">This app is currently served from {appOrigin || "this browser origin"}. Use your verified deployed Kalendr origin for website code; a localhost URL works only for local tests.</p>
          </div>
          <TextareaField
            label={`${t.Business} website origins, one per line`}
            value={draft.websiteOriginsInput}
            onChange={(event) => update("websiteOriginsInput", event.target.value)}
            rows={3}
            placeholder={`https://www.${domain}.example`}
            hint="Use exact HTTPS origins without paths or wildcards. For iframe and popup, an operator must separately approve these in Kalendr frame-ancestor settings. Localhost HTTP is accepted only in development."
          />
          {draft.method === "link" || draft.method === "popup" ? <TextField label="Button label" fieldClassName="max-w-md" value={draft.buttonLabel} onChange={(event) => update("buttonLabel", event.target.value)} maxLength={80} /> : null}
          {draft.method === "iframe" ? <TextField label="Minimum iframe height (px)" fieldClassName="max-w-xs" type="number" min={600} max={1600} value={draft.iframeHeightInput} onChange={(event) => update("iframeHeightInput", event.target.value)} /> : null}
          {draft.method === "api" ? (
            <Alert role="note">
              <AlertDescription>Custom API work runs on your website backend. The public routes do not provide browser cross-origin access, API keys, webhooks, or an automatic website connection.</AlertDescription>
            </Alert>
          ) : null}
        </FramePanel>
        <FrameFooter className="flex flex-wrap justify-between gap-3">
          <Button variant="ghost" onClick={() => setStep("choose")}>Back to methods</Button>
          <Button onClick={continueToInstall}>View installation <ArrowRight aria-hidden="true" /></Button>
        </FrameFooter>
      </Frame>
    ) : null}

    {step === "install" && setup ? (
      <>
        <Frame>
          <FrameHeader>
            <h4 className="text-sm font-semibold">{methods.find((item) => item.id === setup.method)?.title}</h4>
            <FrameDescription className="text-xs">{setup.method === "api" ? `Place this example on your website server. Collect real ${t.customer} details and privacy consent before calling the booking route.` : "Paste this code into a website area that accepts HTML. Confirm your site builder permits the required markup or script."}</FrameDescription>
          </FrameHeader>
          <FramePanel className="flex flex-col gap-3">
            <ScrollAreaPrimitive.Root className="rounded-lg bg-muted">
              <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-72 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ScrollAreaPrimitive.Content>
                  <pre aria-label="Installation code" className="p-3 font-mono text-xs leading-5"><code>{websiteSnippet(setup)}</code></pre>
                </ScrollAreaPrimitive.Content>
              </ScrollAreaPrimitive.Viewport>
              <ScrollBar orientation="vertical" />
              <ScrollBar orientation="horizontal" />
            </ScrollAreaPrimitive.Root>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => void copy(websiteSnippet(setup), setup.method === "api" ? "Server example" : "Installation code")}><Copy aria-hidden="true" /> Copy {setup.method === "api" ? "server example" : "installation code"}</Button>
              {setup.method === "link" ? <Button variant="outline" size="sm" onClick={() => void copy(bookingUrl(setup), "Booking URL")}>Copy booking URL</Button> : null}
            </div>
          </FramePanel>
        </Frame>
        <Frame>
          <FrameHeader>
            <h4 className="text-sm font-semibold">Test the booking flow</h4>
            <FrameDescription className="text-xs">The local preview opens this app’s real booking page. The configured Kalendr origin in the code above has not been verified here.</FrameDescription>
          </FrameHeader>
          <FramePanel className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" render={<a href={localBookingUrl} target="_blank" rel="noopener noreferrer" />}>Open local booking <ExternalLink aria-hidden="true" /></Button>
              {setup.method === "popup" ? <Button variant="outline" size="sm" render={<a href="/embed-demo" target="_blank" rel="noopener noreferrer" />}>Try local popup demo <ExternalLink aria-hidden="true" /></Button> : null}
            </div>
            {setup.method === "iframe" ? (
              <ScrollAreaPrimitive.Root className="rounded-lg border">
                <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-80 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <ScrollAreaPrimitive.Content>
                    <iframe src={`${localBookingUrl}?embed=1`} title="Local inline booking preview" loading="lazy" className="h-80 w-full border-0" />
                  </ScrollAreaPrimitive.Content>
                </ScrollAreaPrimitive.Viewport>
                <ScrollBar orientation="vertical" />
                <ScrollBar orientation="horizontal" />
              </ScrollAreaPrimitive.Root>
            ) : null}
          </FramePanel>
          <FramePanel>
            <h5 className="text-sm font-medium">Before calling this connected</h5>
            <ol className="mt-2 flex list-decimal flex-col gap-2 ps-5 text-sm text-muted-foreground">
              {setup.method === "link" ? <>
                <li>Add the link to the website navigation or booking button.</li>
                <li>Open it from the real website on desktop and mobile; confirm the deployed Kalendr origin serves the {t.business} booking page.</li>
              </> : setup.method === "api" ? <>
                <li>Use a backend route on your website. Pass current location and service IDs, then offer only returned slots.</li>
                <li>Collect the required {t.customer} fields and privacy consent; submit a chosen slot with an Idempotency-Key reused for retries.</li>
                <li>Handle field errors and unavailable slots: on a 409 conflict, reload availability and ask the {t.customer} to choose again. Do not expose {t.customer} data in analytics or URLs.</li>
              </> : <>
                <li>Approve each website origin in the deployment’s KALENDR_BOOKING_FRAME_ANCESTORS setting. Saving this preview does not change it.</li>
                <li>Allow {setup.bookingOrigin} in the website’s {setup.method === "popup" ? "frame-src and script-src" : "frame-src"} Content Security Policy directives.</li>
                <li>Test desktop and mobile, keyboard focus, and browser console on the real website.</li>
              </>}
            </ol>
          </FramePanel>
          <FrameFooter className="flex flex-wrap justify-between gap-3">
            <Button variant="ghost" onClick={() => setStep("configure")}>Back to configuration</Button>
            <Button onClick={() => { setMessage(""); setStep("review"); }}>Review setup <ArrowRight aria-hidden="true" /></Button>
          </FrameFooter>
        </Frame>
      </>
    ) : null}

    {step === "review" && setup ? (
      <Frame>
        <FrameHeader>
          <FrameDescription className="text-xs">Saving records this setup in the current browser session only. It does not update the {t.business} website, a deployment origin allowlist, or Kalendr’s production database.</FrameDescription>
        </FrameHeader>
        <FramePanel className="py-1">
          <dl className="flex flex-col divide-y text-sm">
            <div className="grid gap-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"><dt className="text-muted-foreground">Setup</dt><dd className="font-medium">{setup.name} · {methods.find((item) => item.id === setup.method)?.title}</dd></div>
            <div className="grid gap-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"><dt className="text-muted-foreground">Website origins</dt><dd className="break-all font-medium">{setup.websiteOrigins.join(", ")}</dd></div>
            <div className="grid gap-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"><dt className="text-muted-foreground">Kalendr booking origin</dt><dd className="break-all font-medium">{setup.bookingOrigin}</dd></div>
            <div className="grid gap-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"><dt className="text-muted-foreground">Installation</dt><dd className="font-medium">Code provided · External installation and test still required</dd></div>
          </dl>
        </FramePanel>
        <FrameFooter className="flex flex-wrap justify-between gap-3">
          <Button variant="ghost" onClick={() => setStep("install")}>Back to instructions</Button>
          <Button onClick={save}><Check aria-hidden="true" /> Save preview setup</Button>
        </FrameFooter>
      </Frame>
    ) : null}

    {step === "remove" && removing ? (
      <Frame>
        <FramePanel className="flex flex-col gap-1">
          <p className="text-sm">Remove <span className="font-medium">{removing.name}</span> from this browser preview?</p>
          <p className="text-xs text-muted-foreground">Any code already placed on the website will keep running until someone removes it there.</p>
        </FramePanel>
        <FrameFooter className="flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={() => { setRemoving(null); setStep("choose"); }}>Keep setup</Button>
          <Button variant="destructive" onClick={remove}>Remove preview setup</Button>
        </FrameFooter>
      </Frame>
    ) : null}

    {step === "result" ? (
      <Frame role="status">
        <FramePanel className="flex items-start gap-3">
          <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-foreground" />
          <div className="flex min-w-0 flex-col items-start gap-1">
            <h4 className="text-sm font-semibold">Preview choice saved</h4>
            <p className="text-sm text-muted-foreground">{resultText}</p>
            <Button variant="outline" className="mt-3" onClick={() => { setDraft(null); setStep("choose"); }}>View website setups</Button>
          </div>
        </FramePanel>
      </Frame>
    ) : null}
  </div>;
}
