import { request as httpsRequest } from "node:https";

import { BlockedAddressError, resolvePublicTarget, systemResolver, type HostResolver } from "../webhooks/url-guard";
import type { AppRequest } from "./types";

/**
 * The one place an app's request leaves the building (feature 55). Like the webhook transport it resolves the name,
 * refuses anything that is not a public address, pins the connection to the address it checked, never follows a
 * redirect and stops at ten seconds. Unlike a webhook, an app's reply matters (Slack answers 200 with `ok: false`),
 * so a small, capped body comes back. The caller reads it and throws it away; nothing here logs it.
 */

export const APP_TIMEOUT_MS = 10_000;
const REPLY_CAP_BYTES = 16 * 1024;

export type AppTransportResult =
  | { kind: "response"; statusCode: number; body: string }
  | { kind: "error"; errorCode: "timeout" | "connection_failed" | "blocked_address" | "tls_error" };

export interface AppTransport {
  send(request: AppRequest, options: { allowedHosts: readonly string[]; timeoutMs?: number }): Promise<AppTransportResult>;
}

function isTlsError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.startsWith("CERT_") || code.includes("SELF_SIGNED")
    || code.startsWith("UNABLE_TO_VERIFY") || code === "HOSTNAME_MISMATCH";
}

export function createAppTransport(resolver: HostResolver = systemResolver): AppTransport {
  return {
    async send(request, options) {
      let url: URL;
      try { url = new URL(request.url); } catch { return { kind: "error", errorCode: "blocked_address" }; }
      // The app named its hosts up front; anything else is a bug or an attack, and is refused before any lookup.
      if (url.protocol !== "https:" || !options.allowedHosts.includes(url.hostname) || url.username || url.password) {
        return { kind: "error", errorCode: "blocked_address" };
      }
      let target;
      try {
        target = await resolvePublicTarget(url.hostname, resolver);
      } catch (error: unknown) {
        return { kind: "error", errorCode: error instanceof BlockedAddressError ? "blocked_address" : "connection_failed" };
      }
      const body = request.body ?? "";
      return new Promise<AppTransportResult>((resolve) => {
        let settled = false;
        const finish = (result: AppTransportResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const req = httpsRequest({
          host: url.hostname, port: url.port === "" ? 443 : Number(url.port), path: `${url.pathname}${url.search}`, method: request.method,
          headers: { ...request.headers, "User-Agent": "Kalendr-Apps/1", ...(request.method === "POST" ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) },
          agent: false,
          lookup: (_name, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
            else callback(null, target.address, target.family);
          },
        }, (response) => {
          const statusCode = response.statusCode ?? 0;
          const chunks: Buffer[] = [];
          let seen = 0;
          response.on("data", (chunk: Buffer) => {
            seen += chunk.length;
            if (seen <= REPLY_CAP_BYTES) chunks.push(chunk);
            else { finish({ kind: "response", statusCode, body: Buffer.concat(chunks).toString("utf8") }); req.destroy(); }
          });
          response.on("end", () => finish({ kind: "response", statusCode, body: Buffer.concat(chunks).toString("utf8") }));
          response.on("error", () => finish({ kind: "response", statusCode, body: "" }));
        });
        const timer = setTimeout(() => { finish({ kind: "error", errorCode: "timeout" }); req.destroy(); }, options.timeoutMs ?? APP_TIMEOUT_MS);
        req.on("error", (error: unknown) => finish({ kind: "error", errorCode: isTlsError(error) ? "tls_error" : "connection_failed" }));
        if (request.method === "POST") req.end(body); else req.end();
      });
    },
  };
}
