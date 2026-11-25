import { useCallback, useEffect, useId, useState } from "react";

import { copyRich, copyText } from "../lib/clipboard";
import { bookingLine, dayLabel, matches, timesAsText } from "../lib/format";
import type { Failure } from "../lib/messages";
import type { Service, Today } from "../lib/schemas";
import { useBridge } from "./bridge";
import { ActionMenu } from "./menu";

type Load<T> = { phase: "loading" } | { phase: "error"; error: Failure } | { phase: "ready"; data: T };

/** One read from the worker, with the three states every screen needs and a way to try again. */
function useLoad<T>(run: () => Promise<{ ok: true; data: T } | { ok: false; error: Failure }>, onSignedOut: () => void): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    void run().then((reply) => {
      if (stopped) return;
      if (reply.ok) setState({ phase: "ready", data: reply.data });
      else if (reply.error.kind === "signed_out") onSignedOut();
      else setState({ phase: "error", error: reply.error });
    });
    return () => { stopped = true; };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps -- reruns only when the person presses Try again
  return [state, () => { setState({ phase: "loading" }); setAttempt((value) => value + 1); }];
}

function Failed({ error, retry }: { error: Failure; retry: () => void }) {
  return (
    <div role="alert" className="notice">
      <p>{error.message}</p>
      <button type="button" className="secondary" onClick={retry}>Try again</button>
    </div>
  );
}

function Loading({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="skeletons"><span /><span /><span /></div>;
}

function Services({ onSignedOut, say }: { onSignedOut: () => void; say: (text: string) => void }) {
  const bridge = useBridge();
  const [state, retry] = useLoad<Service[]>(() => bridge({ type: "services" }), onSignedOut);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const searchId = useId();

  const run = useCallback(async (service: Service, what: "times" | "link") => {
    setBusy(service.id);
    try {
      if (what === "times") {
        const reply = await bridge({ type: "emailTimes", serviceId: service.id });
        if (!reply.ok) { if (reply.error.kind === "signed_out") onSignedOut(); else say(reply.error.message); return; }
        if (reply.data.times.length === 0) { say("No open times to copy right now."); return; }
        await copyRich(reply.data.html, timesAsText(service.name, reply.data.times, service.url));
        say("Times copied. Paste them into your email.");
      } else {
        const reply = await bridge({ type: "createLink", serviceId: service.id });
        if (!reply.ok) { if (reply.error.kind === "signed_out") onSignedOut(); else say(reply.error.message); return; }
        await copyText(reply.data.url);
        say("Single-use link copied. It books once, then stops working.");
      }
    } catch {
      say("Could not copy. Try again.");
    } finally {
      setBusy(null);
    }
  }, [bridge, onSignedOut, say]);

  if (state.phase === "loading") return <Loading label="Loading services" />;
  if (state.phase === "error") return <Failed error={state.error} retry={retry} />;
  const shown = state.data.filter((service) => matches(service.name, text));
  return (
    <div className="stack">
      {state.data.length > 6 ? (
        <>
          <label htmlFor={searchId} className="sr-only">Search services</label>
          <input id={searchId} type="search" placeholder="Search services" value={text} onChange={(event) => setText(event.target.value)} />
        </>
      ) : null}
      {state.data.length === 0 ? <p className="muted">No services are open for booking yet. Add one in Kalendr.</p> : null}
      {state.data.length > 0 && shown.length === 0 ? <p className="muted">Nothing matches that.</p> : null}
      <ul className="rows" aria-label="Services">
        {shown.map((service) => (
          <li key={service.id} className="row">
            <div className="grow">
              <span className="title">{service.name}</span>
              <span className="muted">{service.durationMinutes} min{service.hidden ? " · link only" : ""}</span>
            </div>
            <button type="button" className="secondary" disabled={busy === service.id}
              onClick={() => void copyText(service.url).then(() => say(`Link to ${service.name} copied.`), () => say("Could not copy. Try again."))}>Copy link</button>
            <ActionMenu label={`More for ${service.name}`} actions={[
              { label: "Copy times for an email", onSelect: () => void run(service, "times") },
              { label: "New single-use link", onSelect: () => void run(service, "link") },
            ]}>⋯</ActionMenu>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TodayList({ onSignedOut }: { onSignedOut: () => void }) {
  const bridge = useBridge();
  const [state, retry] = useLoad<Today>(() => bridge({ type: "today" }), onSignedOut);
  if (state.phase === "loading") return <Loading label="Loading today's bookings" />;
  if (state.phase === "error") return <Failed error={state.error} retry={retry} />;
  const { bookings, timezone, date } = state.data;
  return (
    <div className="stack">
      <p className="muted">{dayLabel(date, timezone)}</p>
      {bookings.length === 0 ? <p>Nothing booked today.</p> : (
        <ul className="rows" aria-label="Today's bookings">
          {bookings.map((booking) => {
            const line = bookingLine(booking, timezone);
            return (
              <li key={booking.id} className="row">
                <span className="time">{line.time}</span>
                <div className="grow"><span className="title">{line.who}</span><span className="muted">{line.what} · {line.status}</span></div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The connected screen: the business, a way to disconnect, and two tabs. */
export function Home({ onDisconnected }: { onDisconnected: () => void }) {
  const bridge = useBridge();
  const [tab, setTab] = useState<"links" | "today">("links");
  const [note, setNote] = useState("");
  const [me, retryMe] = useLoad(() => bridge({ type: "me" }), onDisconnected);

  async function disconnect() {
    await bridge({ type: "disconnect" });
    onDisconnected();
  }

  return (
    <main className="screen home">
      <header className="bar">
        <h1>{me.phase === "ready" ? me.data.businessName : "Kalendr"}</h1>
        <ActionMenu label="More" actions={[{ label: "Disconnect this browser", destructive: true, onSelect: () => void disconnect() }]}>⋯</ActionMenu>
      </header>
      {me.phase === "error" ? <Failed error={me.error} retry={retryMe} /> : null}
      <div role="tablist" aria-label="Kalendr" className="tabs">
        <button type="button" role="tab" id="tab-links" aria-selected={tab === "links"} aria-controls="panel-links" onClick={() => setTab("links")}>Booking links</button>
        <button type="button" role="tab" id="tab-today" aria-selected={tab === "today"} aria-controls="panel-today" onClick={() => setTab("today")}>Today</button>
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "links" ? <Services onSignedOut={onDisconnected} say={setNote} /> : <TodayList onSignedOut={onDisconnected} />}
      </div>
      <p className="note" role="status" aria-live="polite">{note}</p>
    </main>
  );
}
