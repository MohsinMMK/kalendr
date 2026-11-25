"use client";

import { Copy, ExternalLink, Printer, Share2 } from "lucide-react";
import { useState } from "react";

import { SelectField } from "@/components/form-fields";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import type { ListingView } from "@/lib/listing";
import { parsePosterSize, posterPath, posterSizes, type PosterSize } from "@/lib/share-kit";

import { copyText } from "./share-embed/copy";

const sizeLabel: Record<PosterSize, string> = { a4: "A4", a5: "A5" };

/** A line of read-only text with the buttons that act on it. */
function CopyRow({ label, value, what, multiline = false }: { label: string; value: string; what: string; multiline?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-medium text-sm">{label}</p>
      <div className="flex gap-2">
        <Input readOnly size="lg" value={value} aria-label={label} className={multiline ? "text-xs" : "font-mono text-xs"} onFocus={(event) => event.currentTarget.select()} />
        <Button variant="outline" size="icon-lg" aria-label={`Copy ${what}`} onClick={() => void copyText(value, what)}><Copy aria-hidden="true" /></Button>
        {value.startsWith("http") ? <Button variant="outline" size="icon-lg" aria-label={`Open ${what}`} render={<a href={value} target="_blank" rel="noopener noreferrer" />}><ExternalLink aria-hidden="true" /></Button> : null}
      </div>
    </div>
  );
}

const googleSteps = [
  "Open business.google.com and sign in with the Google account that owns your business.",
  "Pick your business, then choose Edit profile.",
  "Open Booking links (some accounts call it Appointment link).",
  "Paste the Google Business Profile link from above and save.",
  "Google checks the change. A Book button can take a few days to appear on your profile.",
];

/**
 * Settings → Find and share, second half: the booking link for each place it is posted (each tagged with its source so Reports
 * can tell them apart), the printable QR poster, an email signature line, and help with a Google Business Profile.
 */
export function ShareKit({ view }: { view: ListingView }) {
  const [channelId, setChannelId] = useState(view.links[0]?.id ?? "instagram");
  const [size, setSize] = useState<PosterSize>("a4");
  const link = view.links.find((entry) => entry.id === channelId) ?? view.links[0];

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle className="flex items-center gap-2"><Share2 aria-hidden="true" className="size-4" />Share your booking link</FrameTitle>
        <FrameDescription>Each place gets its own link, so your reports show where bookings come from.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-6">
        <section aria-label="Links" className="flex flex-col gap-3">
          <SelectField
            label="Where will you share it?"
            value={channelId}
            onValueChange={(value) => setChannelId(value as typeof channelId)}
            options={view.links.map((entry) => ({ value: entry.id, label: entry.label }))}
            hint={link?.hint}
          />
          {link ? <CopyRow label={`${link.label} link`} value={link.url} what="Link" /> : null}
        </section>

        <section aria-label="Poster" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <h3 className="font-medium text-sm">Printable poster</h3>
              <p className="text-muted-foreground text-xs">Your name and colour, with a QR code that opens your booking page. Put it on the counter or the door.</p>
            </div>
            <div className="flex items-center gap-2">
              <SegmentedControl aria-label="Poster paper size">
                {posterSizes.map((option) => (
                  <SegmentedControlItem key={option} aria-current={option === size ? "page" : undefined} onClick={() => setSize(parsePosterSize(option))}>{sizeLabel[option]}</SegmentedControlItem>
                ))}
              </SegmentedControl>
              <Button variant="outline" render={<a href={posterPath(size)} target="_blank" rel="noopener noreferrer" />}><Printer aria-hidden="true" />Open poster</Button>
            </div>
          </div>
        </section>

        <section aria-label="Email signature" className="flex flex-col gap-3">
          <CopyRow label="Email signature line" value={view.emailSignature} what="Signature line" multiline />
        </section>

        <section aria-label="Google Business Profile help">
          <Accordion>
            <AccordionItem value="google">
              <AccordionTrigger>Add a Book button to your Google Business Profile</AccordionTrigger>
              <AccordionPanel>
                <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
                  {googleSteps.map((step) => <li key={step}>{step}</li>)}
                </ol>
                <p className="mt-3 text-muted-foreground text-xs">Use the Google Business Profile link, not the plain one, so bookings from Google show up under Google in Reports.</p>
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
        </section>
      </FramePanel>
    </Frame>
  );
}
