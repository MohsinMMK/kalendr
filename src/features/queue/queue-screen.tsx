"use client";

import { useEffect, useRef, useState } from "react";
import { Volume2, WifiOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { QueueScreen } from "@/server/queue-screens";

import { usePoll } from "./use-poll";

const POLL_MS = 4_000;

/** A short two-note chime, made in the browser so there is no sound file to load. */
function chime(context: AudioContext) {
  const now = context.currentTime;
  [880, 660].forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    oscillator.type = "sine";
    const start = now + index * 0.35;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.4, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.65);
  });
}

function clock(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** The waiting-room TV: who is being called, and the next tokens. Token numbers only, never names. */
export function QueueScreenView({ token, initial }: { token: string; initial: QueueScreen }) {
  const { data, gone, offline } = usePoll<QueueScreen>(`/api/public/queue/screen/${encodeURIComponent(token)}`, initial, POLL_MS);
  const audio = useRef<AudioContext | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const seen = useRef(new Set(initial.calling.map((call) => `${call.number}:${call.calledAt}`)));
  const [flash, setFlash] = useState<number | null>(null);

  useEffect(() => {
    const fresh = data.calling.filter((call) => !seen.current.has(`${call.number}:${call.calledAt}`));
    for (const call of data.calling) seen.current.add(`${call.number}:${call.calledAt}`);
    if (fresh.length === 0) return;
    if (audio.current) chime(audio.current);
    setFlash(fresh[0]!.number);
    const timer = setTimeout(() => setFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [data.calling]);

  function turnOnSound() {
    const AudioContextClass = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audio.current = new AudioContextClass();
    void audio.current.resume();
    chime(audio.current);
    setSoundOn(true);
  }

  if (gone) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-background p-8 text-center">
        <h1 className="text-3xl font-semibold">This screen link was turned off</h1>
        <p className="text-lg text-muted-foreground">Ask the front desk for the new waiting-room link.</p>
      </main>
    );
  }

  const [current, ...earlier] = data.calling;
  return (
    <main className="flex h-dvh flex-col gap-6 overflow-hidden bg-background p-6 sm:p-10">
      <header className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold sm:text-3xl">{data.businessName}</h1>
          <p className="truncate text-lg text-muted-foreground">{data.locationName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {offline ? <span className="flex items-center gap-1.5 text-sm text-warning-foreground"><WifiOff className="size-4" aria-hidden="true" />Reconnecting…</span> : null}
          {!soundOn ? <Button variant="outline" onClick={turnOnSound}><Volume2 aria-hidden="true" />Tap to turn on sound</Button> : null}
          <span className="text-2xl font-medium tabular-nums text-muted-foreground">{clock(data.at)}</span>
        </div>
      </header>

      <section aria-live="polite" className={`flex min-h-0 flex-1 flex-col items-center justify-center rounded-3xl border-2 p-6 text-center transition-colors ${flash !== null ? "border-primary bg-primary/10" : "bg-muted/40"}`}>
        {current ? (
          <>
            <p className="text-2xl font-medium text-muted-foreground sm:text-3xl">Now calling</p>
            <p className="text-[clamp(6rem,22vh,16rem)] font-bold leading-none tabular-nums">{current.number}</p>
            <p className="text-3xl font-semibold sm:text-4xl">Please go to {current.to}</p>
          </>
        ) : (
          <p className="text-3xl font-medium text-muted-foreground">Please wait to be called</p>
        )}
      </section>

      <section className="grid shrink-0 gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border p-5">
          <h2 className="text-lg font-medium text-muted-foreground">Also called</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {earlier.length === 0 ? <li className="text-xl text-muted-foreground">—</li> : earlier.map((call) => (
              <li key={`${call.number}:${call.calledAt}`} className="flex items-baseline justify-between gap-3 text-2xl">
                <span className="font-semibold tabular-nums">{call.number}</span>
                <span className="truncate text-muted-foreground">{call.to}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-2xl border p-5">
          <h2 className="text-lg font-medium text-muted-foreground">
            Next{data.waitingCount > data.next.length ? ` · ${data.waitingCount} waiting` : ""}
          </h2>
          <p className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-3xl font-semibold tabular-nums">
            {data.next.length === 0 ? <span className="text-xl font-normal text-muted-foreground">No one waiting</span> : data.next.map((number) => <span key={number}>{number}</span>)}
          </p>
        </div>
      </section>
    </main>
  );
}
