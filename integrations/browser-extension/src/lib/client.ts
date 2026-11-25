import { z } from "zod";

import {
  deviceStartSchema, emailTimesSchema, errorSchema, linkSchema, meSchema, servicesSchema, todaySchema, tokenSchema,
  type EmailTimes, type Service, type Today,
} from "./schemas";
import { pendingSchema, sessionSchema, type Pending, type Session, type Store } from "./store";

/**
 * Everything the extension says to Kalendr, in one place. It runs in the background worker, not the popup, for one
 * reason: Kalendr swaps the refresh token for a new one each time it is used, and a popup that closes mid-swap would lose
 * the new one. The worker finishes the swap and saves it even when the popup is gone.
 */

export const CLIENT_ID = "kalendr-extension";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Refresh a little early so a request never leaves with a token that expires on the way. */
const EARLY_MS = 30_000;

export class SignedOutError extends Error {
  constructor(readonly reason: "never" | "revoked" | "expired") {
    super(reason === "never" ? "Connect the extension to Kalendr first." : "Kalendr signed this extension out. Connect it again.");
    this.name = "SignedOutError";
  }
}

export class ApiFailure extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ApiFailure";
  }
}

export interface ClientDeps {
  origin: string;
  store: Store;
  fetch: typeof fetch;
  now: () => number;
}

export type ConnectPoll = { state: "waiting" } | { state: "connected" } | { state: "denied" } | { state: "expired" };

export interface ConnectStart { userCode: string; verificationUri: string; expiresAt: number; interval: number }

async function readError(response: Response, fallback: string): Promise<{ message: string; code: string }> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorSchema.safeParse(body);
  if (!parsed.success) return { message: fallback, code: "unknown" };
  const error = parsed.data.error;
  if (typeof error === "string") return { message: parsed.data.error_description ?? fallback, code: error };
  return { message: error.message ?? fallback, code: error.code ?? "unknown" };
}

export function createClient(deps: ClientDeps) {
  const origin = deps.origin.replace(/\/$/, "");
  let refreshing: Promise<Session> | null = null;

  async function send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await deps.fetch(`${origin}${path}`, { ...init, redirect: "error", credentials: "omit", cache: "no-store" });
    } catch {
      throw new ApiFailure("Kalendr could not be reached. Check your connection.", 0, "network");
    }
  }

  async function tokenCall(fields: Record<string, string>): Promise<Response> {
    return send("/api/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  }

  /** One swap at a time: two requests that both find the token stale wait for the same new one. */
  function refresh(session: Extract<Session, { kind: "oauth" }>): Promise<Session> {
    refreshing ??= (async () => {
      try {
        const response = await tokenCall({ grant_type: "refresh_token", refresh_token: session.refreshToken, client_id: CLIENT_ID });
        if (!response.ok) {
          const failure = await readError(response, "Could not renew the connection.");
          // Refused means Kalendr ended it (disconnected, revoked, reused). Anything else (busy, offline) is worth another try later.
          if (response.status === 400 || response.status === 401) {
            await deps.store.clear("session");
            throw new SignedOutError("revoked");
          }
          throw new ApiFailure(failure.message, response.status, failure.code);
        }
        const token = tokenSchema.parse(await response.json());
        const next: Session = { kind: "oauth", accessToken: token.access_token, refreshToken: token.refresh_token, accessExpiresAt: deps.now() + token.expires_in * 1_000 };
        await deps.store.write("session", next);
        return next;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function current(): Promise<Session> {
    const session = await deps.store.read("session", sessionSchema);
    if (!session) throw new SignedOutError("never");
    if (session.kind === "oauth" && session.accessExpiresAt - EARLY_MS <= deps.now()) return refresh(session);
    return session;
  }

  const bearer = (session: Session) => `Bearer ${session.kind === "key" ? session.apiKey : session.accessToken}`;

  async function call<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
    const attempt = async (session: Session) => send(path, { ...init, headers: { ...init.headers, Authorization: bearer(session), Accept: "application/json" } });
    let session = await current();
    let response = await attempt(session);
    if (response.status === 401) {
      if (session.kind === "oauth") {
        // The token may have been revoked or simply aged out under us: try one swap, and give up if Kalendr refuses it.
        session = await refresh(session);
        response = await attempt(session);
      }
      if (response.status === 401) {
        await deps.store.clear("session");
        throw new SignedOutError("revoked");
      }
    }
    if (!response.ok) {
      const failure = await readError(response, "Kalendr could not do that.");
      throw new ApiFailure(failure.message, response.status, failure.code);
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ApiFailure("Kalendr sent an answer this version does not understand. Update the extension.", response.status, "unexpected_reply");
    return parsed.data;
  }

  return {
    async connected(): Promise<boolean> {
      return (await deps.store.read("session", sessionSchema)) !== null;
    },

    /** Step one of connecting: ask for a code to show the person. */
    async startConnect(): Promise<ConnectStart> {
      const response = await send("/api/oauth/device", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: CLIENT_ID }).toString() });
      if (!response.ok) {
        const failure = await readError(response, "Kalendr would not start a connection.");
        throw new ApiFailure(failure.message, response.status, failure.code);
      }
      const started = deviceStartSchema.parse(await response.json());
      const pending: Pending = { deviceCode: started.device_code, userCode: started.user_code, verificationUri: started.verification_uri_complete, expiresAt: deps.now() + started.expires_in * 1_000, interval: started.interval };
      await deps.store.write("pending", pending);
      return { userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt, interval: pending.interval };
    },

    /** The code being shown, if one is still good. */
    async pending(): Promise<ConnectStart | null> {
      const pending = await deps.store.read("pending", pendingSchema);
      if (!pending) return null;
      if (pending.expiresAt <= deps.now()) { await deps.store.clear("pending"); return null; }
      return { userCode: pending.userCode, verificationUri: pending.verificationUri, expiresAt: pending.expiresAt, interval: pending.interval };
    },

    /** Step two: has the person said yes yet? */
    async pollConnect(): Promise<ConnectPoll> {
      const pending = await deps.store.read("pending", pendingSchema);
      if (!pending || pending.expiresAt <= deps.now()) { await deps.store.clear("pending"); return { state: "expired" }; }
      const response = await tokenCall({ grant_type: DEVICE_GRANT, device_code: pending.deviceCode, client_id: CLIENT_ID });
      if (response.ok) {
        const token = tokenSchema.parse(await response.json());
        await deps.store.write("session", { kind: "oauth", accessToken: token.access_token, refreshToken: token.refresh_token, accessExpiresAt: deps.now() + token.expires_in * 1_000 } satisfies Session);
        await deps.store.clear("pending");
        return { state: "connected" };
      }
      const failure = await readError(response, "");
      if (failure.code === "authorization_pending" || failure.code === "slow_down") return { state: "waiting" };
      await deps.store.clear("pending");
      if (failure.code === "access_denied") return { state: "denied" };
      if (failure.code === "expired_token" || failure.code === "invalid_grant") return { state: "expired" };
      throw new ApiFailure(failure.message || "Kalendr would not finish the connection.", response.status, failure.code);
    },

    async cancelConnect(): Promise<void> {
      await deps.store.clear("pending");
    },

    /** The other way in: an API key the person made in Kalendr. It is checked before it is kept. */
    async connectWithKey(key: string): Promise<void> {
      const apiKey = key.trim();
      if (!/^kal_(live|test)_[A-Za-z0-9_-]{43}$/.test(apiKey)) throw new ApiFailure("That does not look like a Kalendr API key.", 0, "bad_key");
      const response = await send("/api/ext/me", { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
      if (response.status === 401) throw new ApiFailure("Kalendr does not recognise that key.", 401, "invalid_api_key");
      if (response.status === 403) throw new ApiFailure("That key can't read services. Give it the Read services permission.", 403, "insufficient_scope");
      if (!response.ok) throw new ApiFailure("Kalendr could not check that key.", response.status, "unknown");
      await deps.store.write("session", { kind: "key", apiKey } satisfies Session);
    },

    /** Signs out here, and tells Kalendr so the token stops working everywhere. */
    async disconnect(): Promise<void> {
      const session = await deps.store.read("session", sessionSchema);
      await deps.store.clear("session");
      await deps.store.clear("pending");
      if (session?.kind === "oauth") {
        // Best effort: if Kalendr cannot be reached the token is already gone from here, and still shows under Signed in to disconnect.
        await send("/api/oauth/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: session.refreshToken }).toString() }).catch(() => undefined);
      }
    },

    me: () => call("/api/ext/me", meSchema).then((reply) => reply.data),
    services: (): Promise<Service[]> => call("/api/ext/services", servicesSchema).then((reply) => reply.data),
    today: (): Promise<Today> => call("/api/ext/today", todaySchema).then((reply) => reply.data),
    emailTimes: (serviceId: string): Promise<EmailTimes> => call(`/api/ext/email-times?serviceId=${encodeURIComponent(serviceId)}`, emailTimesSchema).then((reply) => reply.data),
    createLink: (serviceId: string, label?: string) => call("/api/ext/single-use-links", linkSchema, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serviceId, ...(label ? { label } : {}) }),
    }).then((reply) => reply.data),
  };
}

export type KalendrClient = ReturnType<typeof createClient>;
