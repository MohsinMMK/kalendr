import { conversionCalls, trackingScriptHosts, type TrackingSettings } from "./tracking";
import { EMBED_WINDOW_EVENT, parseEmbedEvent } from "./protocol";

/**
 * Adds each provider's official snippet to a public booking page and tells it about the booking steps (feature 52). Runs only
 * after the visitor accepted analytics cookies. Each provider is told ids and times, never a name, email or phone.
 */
interface PixelWindow {
  dataLayer?: unknown[][] | Record<string, unknown>[];
  gtag?: (...args: unknown[]) => void;
  fbq?: Fbq;
  _fbq?: unknown;
  plausible?: Plausible;
}

interface Fbq {
  (...args: unknown[]): void;
  queue: unknown[];
  loaded: boolean;
  version: string;
  callMethod?: (...args: unknown[]) => void;
}

interface Plausible {
  (name: string, options?: { props: Record<string, string> }): void;
  q: unknown[];
}

function pixelWindow(): PixelWindow {
  return window as unknown as PixelWindow;
}

function addScript(src: string, attributes: Record<string, string> = {}): void {
  const script = document.createElement("script");
  script.async = true;
  script.src = src;
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  document.head.appendChild(script);
}

const keptParameters = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"];

/** This page's address with only the campaign tags left in the query. */
function safePageAddress(): string {
  const here = new URL(window.location.href);
  const kept = new URLSearchParams();
  for (const name of keptParameters) {
    const value = here.searchParams.get(name);
    if (value) kept.set(name, value);
  }
  const query = kept.toString();
  return `${here.origin}${here.pathname}${query ? `?${query}` : ""}`;
}

function loadGoogleAnalytics(id: string): void {
  const w = pixelWindow();
  const layer = (w.dataLayer ??= []) as unknown[];
  w.gtag ??= function gtag(...args: unknown[]) {
    layer.push(args);
  };
  w.gtag("js", new Date());
  // The page address sent to Google keeps the campaign tags and drops everything else (such as a prefilled name or email in the link).
  w.gtag("config", id, { anonymize_ip: true, page_location: safePageAddress() });
  addScript(`${trackingScriptHosts.googleTag}/gtag/js?id=${encodeURIComponent(id)}`);
}

function loadTagManager(id: string): void {
  const w = pixelWindow();
  const layer = (w.dataLayer ??= []) as unknown[];
  layer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  addScript(`${trackingScriptHosts.googleTag}/gtm.js?id=${encodeURIComponent(id)}`);
}

function loadMetaPixel(id: string): void {
  const w = pixelWindow();
  if (!w.fbq) {
    // The official snippet's own stub: calls wait in a queue until fbevents.js loads and takes over.
    const stub: Fbq = Object.assign((...args: unknown[]) => {
      if (stub.callMethod) stub.callMethod(...args);
      else stub.queue.push(args);
    }, { queue: [] as unknown[], loaded: true, version: "2.0" });
    w.fbq = stub;
    w._fbq = stub;
    addScript(`${trackingScriptHosts.metaPixel}/en_US/fbevents.js`);
  }
  w.fbq("init", id);
  w.fbq("track", "PageView");
}

function loadPlausible(domain: string): void {
  const w = pixelWindow();
  if (!w.plausible) {
    const stub: Plausible = Object.assign((...args: unknown[]) => {
      stub.q.push(args);
    }, { q: [] as unknown[] });
    w.plausible = stub;
  }
  addScript(`${trackingScriptHosts.plausible}/js/script.js`, { "data-domain": domain, defer: "" });
}

/** Loads every provider the business set up and starts passing booking steps to them. Returns a function that stops listening. */
export function startPixels(settings: TrackingSettings): () => void {
  if (settings.googleAnalyticsId) loadGoogleAnalytics(settings.googleAnalyticsId);
  if (settings.tagManagerId) loadTagManager(settings.tagManagerId);
  if (settings.metaPixelId) loadMetaPixel(settings.metaPixelId);
  if (settings.plausibleDomain) loadPlausible(settings.plausibleDomain);

  function onEvent(raised: Event): void {
    const detail = (raised as CustomEvent<unknown>).detail as { event?: unknown; data?: unknown } | undefined;
    const checked = parseEmbedEvent(detail?.event, detail?.data);
    if (!checked) return;
    const w = pixelWindow();
    for (const call of conversionCalls(checked)) {
      if (call.provider === "ga" && settings.googleAnalyticsId) w.gtag?.("event", call.name, call.params ?? {});
      else if (call.provider === "gtm" && settings.tagManagerId) (w.dataLayer as unknown[] | undefined)?.push({ event: call.name, ...(call.params ?? {}) });
      else if (call.provider === "meta" && settings.metaPixelId) w.fbq?.("track", call.name, call.params ?? {});
      else if (call.provider === "plausible" && settings.plausibleDomain) w.plausible?.(call.name, { props: call.params ?? {} });
    }
  }
  window.addEventListener(EMBED_WINDOW_EVENT, onEvent);
  return () => window.removeEventListener(EMBED_WINDOW_EVENT, onEvent);
}
