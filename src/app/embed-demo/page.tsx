import Script from "next/script";
import { CodeIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { ScrollArea } from "@/components/ui/scroll-area";
import { demoClinic } from "@/lib/demo-data";
import { getPublicClinicCatalog } from "@/server/public-catalog";

export const metadata = {
  title: "Website embed demo",
  description: "Add Kalendr booking to any business website with one script.",
};

const snippet = `<div id="kalendr-booking"></div>
<script
  src="https://booking.example.com/kalendr-widget.js?v=3"
  data-kalendr-clinic="${demoClinic.slug}"
  data-kalendr-mount="#kalendr-booking"
  defer
></script>`;

/** The demo business's name as its booking page shows it, so the label and the widget agree. */
async function demoBusinessName(): Promise<string> {
  try {
    return (await getPublicClinicCatalog(demoClinic.slug))?.clinic.name ?? demoClinic.name;
  } catch {
    return demoClinic.name;
  }
}

export default async function EmbedDemoPage() {
  const businessName = await demoBusinessName();
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-12">
      <section className="flex flex-col items-start gap-3">
        <Badge variant="outline" size="lg">
          <CodeIcon aria-hidden="true" />
          Website connection demo
        </Badge>
        <h1 className="font-heading font-semibold text-2xl">
          Add booking to an existing website with one script.
        </h1>
        <p className="max-w-2xl text-muted-foreground text-sm">
          The loader opens Kalendr in a responsive, isolated iframe. Booking details
          stay inside Kalendr. Your page only learns that a booking was completed, through
          a reference code.
        </p>
      </section>

      <Frame>
        <FrameHeader>
          <FrameTitle>
            <h2 className="font-heading font-semibold text-base">Live example</h2>
          </FrameTitle>
          <FrameDescription>
            This page uses the same loader any business can paste into its website.
            The example business here is {businessName}.
          </FrameDescription>
        </FrameHeader>
        <FramePanel>
          <div id="kalendr-booking" />
          <Script
            id="kalendr-widget-demo"
            src="/kalendr-widget.js?v=3"
            strategy="afterInteractive"
            data-kalendr-clinic={demoClinic.slug}
            data-kalendr-mount="#kalendr-booking"
            data-kalendr-label={`Book with ${businessName}`}
          />
        </FramePanel>
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle>
            <h2 className="font-heading font-semibold text-base">Copy-ready snippet</h2>
          </FrameTitle>
          <FrameDescription>
            Sites with a strict Content Security Policy must allow the loader in{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">script-src</code>
            {" "}and the booking origin in{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">frame-src</code>.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="p-0">
          <ScrollArea clampContentMinWidth={false}>
            <pre className="p-5 font-mono text-xs leading-6">
              <code>{snippet}</code>
            </pre>
          </ScrollArea>
        </FramePanel>
      </Frame>
    </main>
  );
}
