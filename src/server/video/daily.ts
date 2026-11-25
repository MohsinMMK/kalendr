/**
 * Daily (https://docs.daily.co/reference/rest-api). The API key stays on the server. A room is private, so
 * nobody can join it without a meeting token, and the token is short-lived and made for one person.
 * Recording is off: no recording property is ever set. Nothing here logs a name, a token or a URL.
 */
import { VideoPermanentError, VideoTransientError, type VideoProvider } from "./provider";

const API = "https://api.daily.co/v1";
const TIMEOUT_MS = 8_000;

export interface DailyOptions {
  apiKey: string;
  /** The "name" in name.daily.co. */
  domain: string;
  /** For tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  apiUrl?: string;
}

const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

export function createDailyProvider({ apiKey, domain, fetchFn = fetch, apiUrl = API }: DailyOptions): VideoProvider {
  async function call(method: "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(`${apiUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new VideoTransientError("network");
    }
    if (response.status === 404 && method === "DELETE") return null;
    if (response.status === 429 || response.status >= 500) throw new VideoTransientError(`http_${response.status}`);
    if (!response.ok) {
      // Daily words "already exists" in the error body; keep that apart from other bad requests.
      const detail = await response.text().catch(() => "");
      throw new VideoPermanentError(response.status === 400 && /already exists/i.test(detail) ? "room_exists" : `http_${response.status}`);
    }
    return response.json().catch(() => ({}));
  }

  return {
    name: "daily",
    async createRoom({ name, expiresAt }) {
      try {
        await call("POST", "/rooms", { name, privacy: "private", properties: { exp: seconds(expiresAt), enable_prejoin_ui: false, enable_chat: true } });
      } catch (error) {
        // A retry after a crash finds the room already made: Daily says so with a 400 "already exists".
        if (!(error instanceof VideoPermanentError) || error.code !== "room_exists") throw error;
      }
      return { name, url: `https://${domain}.daily.co/${name}` };
    },
    async createToken({ roomName, isOwner, displayName, notBefore, expiresAt }) {
      const result = await call("POST", "/meeting-tokens", {
        properties: {
          room_name: roomName,
          is_owner: isOwner,
          user_name: displayName.slice(0, 80),
          nbf: seconds(notBefore),
          exp: seconds(expiresAt),
          enable_screenshare: isOwner,
          start_video_off: false,
        },
      });
      const token = typeof result === "object" && result !== null && "token" in result ? (result as { token: unknown }).token : null;
      if (typeof token !== "string" || token.length === 0) throw new VideoPermanentError("no_token");
      return { token };
    },
    async deleteRoom(roomName) {
      await call("DELETE", `/rooms/${encodeURIComponent(roomName)}`);
    },
  };
}
