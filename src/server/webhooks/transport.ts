import { request as httpsRequest } from "node:https";

import { BlockedAddressError, resolvePublicTarget, systemResolver, type HostResolver } from "./url-guard";

/**
 * The one place a webhook leaves the building (feature 34). The worker hands it a rendered request; it resolves the
 * name, refuses non-public answers, connects to the address it checked (so the name can not change under it), never
 * follows a redirect, stops at ten seconds, reads at most a few kilobytes of the reply and throws that away.
 *
 * It returns fixed codes, never the receiver's text. Tests give the worker a fake `WebhookTransport` instead, and
 * give this one a fake resolver; nothing here can be told to skip a check.
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;
const REPLY_CAP_BYTES = 4096;

export type WebhookErrorCode = "timeout" | "connection_failed" | "blocked_address" | "redirect_blocked" | "http_status" | "tls_error";

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/** A reply of any status, or a failure before one arrived. */
export type WebhookTransportResult =
  | { kind: "response"; statusCode: number }
  | { kind: "error"; errorCode: Exclude<WebhookErrorCode, "http_status" | "redirect_blocked"> };

export interface WebhookTransport {
  send(request: WebhookRequest): Promise<WebhookTransportResult>;
}

/** Turns a reply into success or a fixed failure code: 2xx is success, 3xx is never followed. */
export function classifyStatus(statusCode: number): { ok: true } | { ok: false; errorCode: "redirect_blocked" | "http_status" } {
  if (statusCode >= 200 && statusCode < 300) return { ok: true };
  return { ok: false, errorCode: statusCode >= 300 && statusCode < 400 ? "redirect_blocked" : "http_status" };
}

function isTlsError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.startsWith("CERT_") || code.includes("SELF_SIGNED")
    || code.startsWith("UNABLE_TO_VERIFY") || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "HOSTNAME_MISMATCH";
}

export function createHttpsTransport(resolver: HostResolver = systemResolver): WebhookTransport {
  return {
    async send(request): Promise<WebhookTransportResult> {
      const url = new URL(request.url);
      let target;
      try {
        target = await resolvePublicTarget(url.hostname, resolver);
      } catch (error: unknown) {
        return { kind: "error", errorCode: error instanceof BlockedAddressError ? "blocked_address" : "connection_failed" };
      }
      return new Promise<WebhookTransportResult>((resolve) => {
        let settled = false;
        const finish = (result: WebhookTransportResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const req = httpsRequest({
          host: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: { ...request.headers, "Content-Length": String(Buffer.byteLength(request.body)) },
          agent: false,
          // Pin the connection to the address that passed the check.
          lookup: (_name, options, callback) => {
            if (options.all) callback(null, [{ address: target.address, family: target.family }]);
            else callback(null, target.address, target.family);
          },
        }, (response) => {
          let seen = 0;
          const statusCode = response.statusCode ?? 0;
          response.on("data", (chunk: Buffer) => {
            seen += chunk.length;
            if (seen > REPLY_CAP_BYTES) {
              finish({ kind: "response", statusCode });
              req.destroy();
            }
          });
          response.on("end", () => finish({ kind: "response", statusCode }));
          response.on("error", () => finish({ kind: "response", statusCode }));
        });
        // One clock for the whole exchange, not per socket phase.
        const timer = setTimeout(() => {
          finish({ kind: "error", errorCode: "timeout" });
          req.destroy();
        }, request.timeoutMs);
        req.on("error", (error: unknown) => finish({ kind: "error", errorCode: isTlsError(error) ? "tls_error" : "connection_failed" }));
        req.end(request.body);
      });
    },
  };
}
