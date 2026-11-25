import { createClient } from "./lib/client";
import { ORIGIN } from "./lib/config";
import { handle, requestSchema, toFailure } from "./lib/messages";
import { chromeStore } from "./lib/store";

/**
 * The background worker: the only place that talks to Kalendr or holds a token. The popup sends it a request and shows the
 * answer. It reads no page, injects nothing, and listens only to messages from this extension's own pages.
 */

const client = createClient({ origin: ORIGIN, store: chromeStore(), fetch: (...args) => fetch(...args), now: () => Date.now() });

chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  // Only this extension's own popup may ask. A web page cannot reach this listener, and this makes that explicit.
  if (sender.id !== chrome.runtime.id) return false;
  const request = requestSchema.safeParse(message);
  if (!request.success) {
    respond({ ok: false, error: toFailure(null) });
    return false;
  }
  void handle(request.data, client).then(respond);
  // Keeps the channel open for the asynchronous answer.
  return true;
});
