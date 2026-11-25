import { useEffect, useRef, useState } from "react";

import type { ConnectStart } from "../lib/client";
import { tidyKey } from "../lib/format";
import { useBridge } from "./bridge";

/**
 * Connecting. The person presses Connect, sees an eight-letter code, opens Kalendr, types it and says yes. The popup checks
 * every few seconds while it is open; if it is closed and reopened, the same code is picked up again until it runs out.
 */
export function Connect({ initial, onConnected }: { initial: ConnectStart | null; onConnected: () => void }) {
  const bridge = useBridge();
  const [code, setCode] = useState<ConnectStart | null>(initial);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [useKey, setUseKey] = useState(false);
  const [key, setKey] = useState("");
  const slow = useRef(false);

  async function start() {
    setBusy(true);
    setMessage("");
    const reply = await bridge({ type: "connect.start" });
    setBusy(false);
    if (reply.ok) setCode(reply.data);
    else setMessage(reply.error.message);
  }

  useEffect(() => {
    if (!code) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const reply = await bridge({ type: "connect.poll" });
      if (stopped) return;
      if (!reply.ok) { setMessage(reply.error.message); slow.current = true; }
      else if (reply.data.state === "connected") { onConnected(); return; }
      else if (reply.data.state === "denied") { setCode(null); setMessage("You chose not to connect. Press Connect to try again."); return; }
      else if (reply.data.state === "expired") { setCode(null); setMessage("That code ran out. Press Connect for a new one."); return; }
      timer = setTimeout(() => void tick(), Math.max(code.interval, 3) * 1_000 + (slow.current ? 5_000 : 0));
    };
    timer = setTimeout(() => void tick(), 2_000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [code, bridge, onConnected]);

  async function connectWithKey(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const reply = await bridge({ type: "connect.key", key: tidyKey(key) });
    setBusy(false);
    if (reply.ok) onConnected();
    else setMessage(reply.error.message);
  }

  if (code) {
    return (
      <main className="screen">
        <h1>Connect to Kalendr</h1>
        <ol className="steps">
          <li>Open Kalendr and sign in if it asks. <a href={code.verificationUri} target="_blank" rel="noreferrer">Open Kalendr</a></li>
          <li>Check this code is shown, then press Allow.</li>
        </ol>
        <p className="code" aria-label={`Your code is ${code.userCode.split("").join(" ")}`}>{code.userCode}</p>
        <p className="muted" role="status">Waiting for you to approve…</p>
        {message ? <p role="alert" className="error">{message}</p> : null}
        <button type="button" className="secondary" onClick={() => { void bridge({ type: "connect.cancel" }); setCode(null); }}>Cancel</button>
      </main>
    );
  }

  return (
    <main className="screen">
      <h1>Kalendr</h1>
      <p>Copy your booking links and see today&apos;s bookings from the toolbar.</p>
      {message ? <p role="alert" className="error">{message}</p> : null}
      <button type="button" className="primary" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Connect"}</button>
      <p className="muted">It asks Kalendr for a code. You approve it in your own Kalendr, so this extension never sees your password.</p>
      {useKey ? (
        <form onSubmit={(event) => void connectWithKey(event)} className="key-form">
          <label htmlFor="key">API key</label>
          <input id="key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(event) => setKey(event.target.value)} placeholder="kal_live_…" />
          <p className="muted">Make one in Kalendr under Settings, Developers, with Read services, See today&apos;s bookings and Make single-use links.</p>
          <button type="submit" className="secondary" disabled={busy || key.trim() === ""}>Use this key</button>
        </form>
      ) : (
        <button type="button" className="link" onClick={() => setUseKey(true)}>Use an API key instead</button>
      )}
    </main>
  );
}
