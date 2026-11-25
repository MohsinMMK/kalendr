"use client";

import { useState } from "react";

import { Booker, type BookerEvent } from "../../../packages/booker/src";
import "../../../packages/booker/src/booker.css";

/** The Booker component on a plain page, with the events it reports shown underneath. */
export function DemoBooker({ clinicSlug }: { clinicSlug: string }) {
  const [events, setEvents] = useState<BookerEvent[]>([]);
  return (
    <div className="flex flex-col gap-6">
      <Booker clinicSlug={clinicSlug} onEvent={(event) => setEvents((current) => [...current, event])} />
      <section aria-label="Events reported to this page" className="rounded-lg border p-4">
        <h2 className="mb-2 font-heading font-semibold text-base">Events this page received</h2>
        <ol className="font-mono text-xs" data-testid="booker-events">
          {events.map((event, index) => <li key={`${event.type}-${index}`} className="break-all">{JSON.stringify(event)}</li>)}
        </ol>
      </section>
    </div>
  );
}
