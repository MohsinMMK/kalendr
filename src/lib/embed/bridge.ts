import { EMBED_PROTOCOL_VERSION, EMBED_WINDOW_EVENT, parseEmbedEvent, type EmbedEvent } from "./protocol";

/**
 * The booking page's side of the website connection (feature 52). It speaks only to the one origin the page was opened
 * from, only after the website's loader answers a handshake carrying the page's own nonce, and only in the message
 * shapes of `protocol.ts`. It reports sizes, closes and booking events; nothing about the customer.
 */
export interface EmbedBridgeOptions {
  nonce: string;
  parentOrigin: string;
}

export function startEmbedBridge({ nonce, parentOrigin }: EmbedBridgeOptions): (() => void) | undefined {
  if (window.parent === window) return undefined;

  let referrerOrigin: string;
  try {
    referrerOrigin = new URL(document.referrer).origin;
  } catch {
    return undefined;
  }
  if (referrerOrigin !== parentOrigin) return undefined;

  let handshakeComplete = false;
  let animationFrameId: number | undefined;
  // Events raised before the handshake finish are kept and sent right after it, so `opened` is never lost.
  const waiting: EmbedEvent[] = [];

  function post(type: string, payload: Record<string, unknown> = {}): void {
    if (!handshakeComplete) return;
    window.parent.postMessage({ type, version: EMBED_PROTOCOL_VERSION, nonce, ...payload }, parentOrigin);
  }

  function send(event: EmbedEvent): void {
    post("kalendr:event", { event: event.event, data: event.data });
    // The first version of the loader only knew this one message.
    if (event.event === "booked" && event.data.appointmentId) post("kalendr:completed", { appointmentReference: event.data.appointmentId });
  }

  function postHeight(): void {
    if (animationFrameId !== undefined) return;
    animationFrameId = window.requestAnimationFrame(() => {
      animationFrameId = undefined;
      post("kalendr:resize", { height: Math.ceil(document.documentElement.getBoundingClientRect().height) });
    });
  }

  function onHostMessage(message: MessageEvent<unknown>): void {
    if (message.origin !== parentOrigin || message.source !== window.parent || !message.data || typeof message.data !== "object") return;
    const data = message.data as Record<string, unknown>;
    if (data.type !== "kalendr:host-ready" || data.version !== EMBED_PROTOCOL_VERSION || data.nonce !== nonce) return;
    if (handshakeComplete) return;
    handshakeComplete = true;
    post("kalendr:ready");
    postHeight();
    send({ event: "opened", data: {} });
    for (const event of waiting.splice(0)) send(event);
  }

  function onEmbedEvent(raised: Event): void {
    const detail = (raised as CustomEvent<unknown>).detail as { event?: unknown; data?: unknown } | undefined;
    const checked = parseEmbedEvent(detail?.event, detail?.data);
    if (!checked) return;
    if (handshakeComplete) send(checked);
    else waiting.push(checked);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    post("kalendr:close");
  }

  const resizeObserver = new ResizeObserver(postHeight);
  resizeObserver.observe(document.documentElement);
  window.addEventListener("message", onHostMessage);
  window.addEventListener(EMBED_WINDOW_EVENT, onEmbedEvent);
  document.addEventListener("keydown", onKeyDown);
  window.parent.postMessage({ type: "kalendr:bridge-ready", version: EMBED_PROTOCOL_VERSION, nonce }, parentOrigin);

  return () => {
    if (animationFrameId !== undefined) window.cancelAnimationFrame(animationFrameId);
    resizeObserver.disconnect();
    window.removeEventListener("message", onHostMessage);
    window.removeEventListener(EMBED_WINDOW_EVENT, onEmbedEvent);
    document.removeEventListener("keydown", onKeyDown);
  };
}

/** Asks the website to send the visitor on. The website's loader checks the address before it follows it. */
export function requestHostRedirect(options: EmbedBridgeOptions, url: string): void {
  if (window.parent === window) return;
  window.parent.postMessage({ type: "kalendr:redirect", version: EMBED_PROTOCOL_VERSION, nonce: options.nonce, url }, options.parentOrigin);
}
