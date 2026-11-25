import { z } from "zod";

/**
 * The extension's only storage: the sign-in and, while connecting, the code being shown. Kept in `chrome.storage.local`,
 * which only this extension can read. A password is never stored, because there is none: the extension holds a token that
 * Kalendr can revoke, or an API key the person pasted.
 */

export const sessionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("oauth"), accessToken: z.string(), accessExpiresAt: z.number(), refreshToken: z.string() }),
  z.object({ kind: z.literal("key"), apiKey: z.string() }),
]);
export type Session = z.infer<typeof sessionSchema>;

export const pendingSchema = z.object({
  deviceCode: z.string(), userCode: z.string(), verificationUri: z.string(), expiresAt: z.number(), interval: z.number(),
});
export type Pending = z.infer<typeof pendingSchema>;

export interface Store {
  read<T>(key: "session" | "pending", schema: z.ZodType<T>): Promise<T | null>;
  write(key: "session" | "pending", value: unknown): Promise<void>;
  clear(key: "session" | "pending"): Promise<void>;
}

export function chromeStore(area: chrome.storage.StorageArea = chrome.storage.local): Store {
  return {
    async read(key, schema) {
      const found = await area.get(key);
      const parsed = schema.safeParse(found[key]);
      return parsed.success ? parsed.data : null;
    },
    async write(key, value) {
      await area.set({ [key]: value });
    },
    async clear(key) {
      await area.remove(key);
    },
  };
}

export function memoryStore(): Store & { dump(): Record<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    async read(key, schema) {
      const parsed = schema.safeParse(values.get(key));
      return parsed.success ? parsed.data : null;
    },
    async write(key, value) { values.set(key, structuredClone(value)); },
    async clear(key) { values.delete(key); },
    dump: () => Object.fromEntries(values),
  };
}
