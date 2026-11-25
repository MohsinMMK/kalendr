/**
 * Copies from the popup, always from a click, which is when the browser allows it without any extra permission. Rich copy
 * puts HTML and text on the clipboard together, so pasting into Gmail keeps the links and pasting into a plain field keeps
 * the words.
 */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export async function copyRich(html: string, text: string): Promise<void> {
  if (typeof ClipboardItem === "undefined") return copyText(text);
  await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
}
