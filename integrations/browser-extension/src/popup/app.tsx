import { useEffect, useState } from "react";

import type { ConnectStart } from "../lib/client";
import { useBridge } from "./bridge";
import { Connect } from "./connect";
import { Home } from "./home";

type View = { name: "loading" } | { name: "connect"; pending: ConnectStart | null } | { name: "home" } | { name: "broken"; message: string };

export function App() {
  const bridge = useBridge();
  const [view, setView] = useState<View>({ name: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let stopped = false;
    void bridge({ type: "status" }).then((reply) => {
      if (stopped) return;
      if (!reply.ok) setView({ name: "broken", message: reply.error.message });
      else setView(reply.data.connected ? { name: "home" } : { name: "connect", pending: reply.data.pending });
    });
    return () => { stopped = true; };
  }, [bridge, attempt]);

  if (view.name === "loading") return <main className="screen"><div role="status" aria-label="Loading" className="skeletons"><span /><span /></div></main>;
  if (view.name === "broken") {
    return <main className="screen"><p role="alert" className="error">{view.message}</p><button type="button" className="secondary" onClick={() => { setView({ name: "loading" }); setAttempt((value) => value + 1); }}>Try again</button></main>;
  }
  if (view.name === "connect") return <Connect initial={view.pending} onConnected={() => setView({ name: "home" })} />;
  return <Home onDisconnected={() => setView({ name: "connect", pending: null })} />;
}
