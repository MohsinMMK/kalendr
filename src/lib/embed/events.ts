import { EMBED_WINDOW_EVENT, parseEmbedEvent, type EmbedEventData, type EmbedEventName } from "./protocol";

/**
 * Raises an embed event from inside the booking page. The bridge passes it to the host website (when embedded) and the
 * conversion pixels listen too (when the visitor allowed them). Safe to call anywhere: with nobody listening it does nothing.
 */
export function emitEmbedEvent(event: EmbedEventName, data: EmbedEventData = {}): void {
  if (typeof window === "undefined") return;
  const checked = parseEmbedEvent(event, data);
  if (!checked) return;
  window.dispatchEvent(new CustomEvent(EMBED_WINDOW_EVENT, { detail: checked }));
}
