"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Reads a public queue link on a timer. Pauses while the tab is hidden and catches up when it
 * comes back. A 404 means the link was turned off, so polling stops.
 */
export function usePoll<T>(url: string, initial: T, everyMs: number) {
  const [data, setData] = useState<T>(initial);
  const [gone, setGone] = useState(false);
  const [offline, setOffline] = useState(false);
  const urlRef = useRef(url);

  useEffect(() => {
    urlRef.current = url;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    async function tick() {
      if (stopped) return;
      if (document.visibilityState === "visible") {
        controller = new AbortController();
        try {
          const response = await fetch(urlRef.current, { cache: "no-store", signal: controller.signal });
          if (response.status === 404) {
            setGone(true);
            return;
          }
          if (response.ok) {
            const body = (await response.json()) as { data: T };
            setData(body.data);
            setOffline(false);
          } else setOffline(true);
        } catch {
          if (!controller.signal.aborted) setOffline(true);
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), everyMs);
    }

    function onVisible() {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void tick();
    }

    timer = setTimeout(() => void tick(), everyMs);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, everyMs]);

  return { data, setData, gone, offline };
}
