/** The words that mean "stop messaging me" in the languages our customers write in. Whole message only, so "please don't stop" is not a STOP. */
const STOP_WORDS = new Set([
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "optout", "opt-out",
  "बंद", "रोकें", "रुकें", "स्टॉप",
]);

export function isStopMessage(text: string): boolean {
  const normal = text.trim().toLowerCase().replace(/[.!\s]+$/g, "");
  return STOP_WORDS.has(normal);
}
