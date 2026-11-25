import { oneResult, v1Route } from "@/server/api-v1";
import { extensionMe } from "@/server/extension-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who the extension is connected to. Any key or connection that can read services may ask. */
export const GET = v1Route("ext.me", "services:read", async ({ context }) => oneResult(extensionMe(context)));
