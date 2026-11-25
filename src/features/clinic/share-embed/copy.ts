import { toastManager } from "@/components/ui/toast";

/** Copies text and says so; when the browser refuses, the toast tells the person to select it by hand. */
export async function copyText(value: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toastManager.add({ title: `${what} copied`, type: "success" });
  } catch {
    toastManager.add({ title: `${what} could not be copied`, description: "Select it and copy it yourself.", type: "error" });
  }
}

/** Copies HTML so it pastes with its links into an email, with the plain text as the fallback. */
export async function copyHtml(html: string, text: string, what: string): Promise<void> {
  try {
    if (typeof ClipboardItem === "undefined") throw new Error("unsupported");
    await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    toastManager.add({ title: `${what} copied`, type: "success" });
  } catch {
    await copyText(html, what);
  }
}
