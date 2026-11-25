import { z } from "zod";

import { apiKeyModes, apiScopes, apiWriteScopes } from "@/lib/api-scopes";

/** Browser-safe: the settings screen and the staff routes share these shapes. */

export const maxActiveApiKeys = 25;
const TWO_YEARS_MS = 2 * 366 * 86_400_000;

export const createApiKeyInput = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(80, "Use 80 characters or fewer."),
  mode: z.enum(apiKeyModes),
  scopes: z.array(z.enum(apiScopes)).min(1, "Choose at least one thing the key may do.").max(apiScopes.length),
  expiresAt: z.iso.datetime({ offset: true, error: "Choose a valid expiry date." }).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "test" && value.scopes.some((scope) => apiWriteScopes.includes(scope))) {
    context.addIssue({ code: "custom", path: ["scopes"], message: "A test key can only read. Remove the booking and customer write options, or make a live key." });
  }
  if (value.expiresAt !== undefined) {
    const at = Date.parse(value.expiresAt);
    if (at <= Date.now()) context.addIssue({ code: "custom", path: ["expiresAt"], message: "The expiry date must be in the future." });
    else if (at > Date.now() + TWO_YEARS_MS) context.addIssue({ code: "custom", path: ["expiresAt"], message: "A key can last at most 2 years." });
  }
});
export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>;

export const apiKeyIdSchema = z.uuid();

export const apiKeyView = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(apiScopes)),
  mode: z.enum(apiKeyModes),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApiKeyView = z.infer<typeof apiKeyView>;

export interface CreatedApiKey {
  key: ApiKeyView;
  /** The whole key. Shown once; only its hash is stored. */
  secret: string;
}
