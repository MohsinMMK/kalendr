"use client";

import { Printer } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { qrCodePath } from "@/lib/check-in";
import { posterSizes, type PosterSize } from "@/lib/share-kit";

const paper: Record<PosterSize, { label: string; css: string; ratio: string; unitsAcross: number; widthMm: number; heightMm: number }> = {
  a4: { label: "A4", css: "A4", ratio: "210 / 297", unitsAcross: 21, widthMm: 210, heightMm: 297 },
  a5: { label: "A5", css: "A5", ratio: "148 / 210", unitsAcross: 14.8, widthMm: 148, heightMm: 210 },
};

/**
 * The poster, drawn in container units so one design fits A4 and A5 and the screen preview alike: 1em is 1/21 of the sheet's width on A4
 * (1 cm) and 1/14.8 on A5. Printing hides the controls, removes the margins and fits the sheet to the paper.
 */
export function PosterSheet({ size, businessName, city, url, shortUrl, accent, textColor, showBadge, preview }: {
  size: PosterSize;
  businessName: string;
  city: string | null;
  /** The QR code's address, tagged with its source. */
  url: string;
  /** What is printed under the code for people who type it. */
  shortUrl: string;
  accent: string;
  textColor: string;
  showBadge: boolean;
  preview: boolean;
}) {
  const qr = useMemo(() => qrCodePath(url), [url]);
  const sheet = paper[size];
  const nameSize = businessName.length > 36 ? 1.5 : businessName.length > 22 ? 1.9 : 2.4;

  return (
    <div className="flex min-h-svh flex-col items-center gap-4 bg-muted/40 p-4 print:min-h-0 print:bg-white print:p-0">
      <style>{`@page { size: ${sheet.css} portrait; margin: 0; } @media print { html, body { background: #fff !important; height: auto !important; min-height: 0 !important; } .poster-article { width: ${sheet.widthMm}mm !important; height: ${sheet.heightMm - 1}mm !important; aspect-ratio: auto !important; } }`}</style>
      <div className="flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex flex-col gap-1">
          <h1 className="font-heading font-semibold text-base">Booking poster</h1>
          <p className="text-muted-foreground text-xs">{preview ? "A sample: the preview has no real booking link." : "Print it on a normal printer, or save it as a PDF."}</p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl aria-label="Paper size">
            {posterSizes.map((option) => (
              <SegmentedControlItem key={option} render={<a href={`?size=${option}`} />} aria-current={option === size ? "page" : undefined}>{paper[option].label}</SegmentedControlItem>
            ))}
          </SegmentedControl>
          <Button size="lg" onClick={() => window.print()}><Printer aria-hidden="true" />Print</Button>
        </div>
      </div>
      <div className="w-full max-w-[210mm] print:max-w-none" style={{ containerType: "inline-size" }}>
        <article
          aria-label={`Poster for ${businessName}`}
          className="poster-article flex w-full flex-col overflow-hidden bg-white shadow-lg print:shadow-none"
          style={{ aspectRatio: sheet.ratio, fontSize: `calc(100cqw / ${sheet.unitsAcross})`, color: "#111827", breakInside: "avoid" }}
        >
          <header className="flex flex-col justify-center" style={{ background: accent, color: textColor, padding: "1.6em 1.4em", minHeight: "26%" }}>
            <p style={{ fontSize: "0.7em", letterSpacing: "0.12em", textTransform: "uppercase" }}>{city ?? "Book online"}</p>
            <p style={{ fontSize: `${nameSize}em`, fontWeight: 700, lineHeight: 1.1, marginTop: "0.3em", overflowWrap: "anywhere" }}>{businessName}</p>
          </header>
          <div className="flex flex-1 flex-col items-center justify-center text-center" style={{ gap: "0.9em", padding: "1em 1.4em" }}>
            <p style={{ fontSize: "1.7em", fontWeight: 700, lineHeight: 1.15 }}>Book your appointment in a minute</p>
            <p style={{ fontSize: "0.85em", color: "#4b5563" }}>Point your phone camera at the code. No app to install.</p>
            <div style={{ border: `0.25em solid ${accent}`, borderRadius: "0.7em", padding: "0.6em", background: "#fff", width: "9.5em" }}>
              <svg role="img" aria-label={`QR code that opens the booking page of ${businessName}`} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" style={{ display: "block", width: "100%", height: "auto" }}>
                <rect width={qr.size} height={qr.size} fill="#fff" />
                <path d={qr.path} fill="#000" />
              </svg>
            </div>
            <p style={{ fontSize: "0.75em", color: "#4b5563", overflowWrap: "anywhere" }}>or go to <strong style={{ color: "#111827" }}>{shortUrl}</strong></p>
          </div>
          {showBadge ? <footer style={{ padding: "0.6em 1.4em", fontSize: "0.55em", color: "#6b7280", textAlign: "center" }}>Bookings by Kalendr</footer> : null}
        </article>
      </div>
    </div>
  );
}
