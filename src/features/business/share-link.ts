import { toastManager } from "@/components/ui/toast";

/** Hands a page of this site to the phone's share menu, or copies the link where there is none. */
export async function shareLink({ title, text, path }: { title: string; text?: string; path: string }) {
  const url = new URL(path, window.location.origin).toString();
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (cause: unknown) {
      // Closing the share menu is not a failure. Anything else falls back to copying.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toastManager.add({ title: "Link copied", description: `Paste it anywhere to share ${title}.`, type: "success" });
  } catch {
    toastManager.add({ title: "The link could not be copied", description: url, type: "error" });
  }
}
