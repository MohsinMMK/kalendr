import { oneResult, v1Route } from "@/server/api-v1";
import { extensionToday } from "@/server/extension-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("ext.today", "bookings:today", async ({ context }) => oneResult(await extensionToday(context)));
