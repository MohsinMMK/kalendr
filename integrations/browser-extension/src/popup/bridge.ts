import { createContext, useContext } from "react";

import type { Reply, Request } from "../lib/messages";

/** How the popup reaches the background worker. A test gives the popup a fake one; the real one is `chromeBridge`. */
export type Bridge = <T extends Request["type"]>(request: Extract<Request, { type: T }>) => Promise<Reply<T>>;

const silent = { ok: false, error: { kind: "unexpected", message: "The extension did not answer. Close it and try again." } } as const;

export async function chromeBridge<T extends Request["type"]>(request: Extract<Request, { type: T }>): Promise<Reply<T>> {
  try {
    // The worker checks every request and builds every reply; a missing one means it was asleep and failed to wake.
    const reply = (await chrome.runtime.sendMessage(request)) as Reply<T> | undefined;
    return reply ?? silent;
  } catch {
    return silent;
  }
}

export const BridgeContext = createContext<Bridge>(chromeBridge);
export const useBridge = (): Bridge => useContext(BridgeContext);
