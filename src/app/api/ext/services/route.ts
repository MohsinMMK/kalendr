import { oneResult, v1Route } from "@/server/api-v1";
import { extensionServices } from "@/server/extension-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("ext.services", "services:read", async ({ context }) => oneResult(await extensionServices(context)));
