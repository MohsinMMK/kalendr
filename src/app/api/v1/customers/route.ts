import { listResult, oneResult, pageQuerySchema, v1Route } from "@/server/api-v1";
import { customerListQuery, newCustomerBody } from "@/server/api-v1-contracts";
import { listCustomers } from "@/server/api-v1-reads";
import { createCustomer } from "@/server/api-v1-writes";
import { getIdempotencyKey, parseJsonBody, parseQuery } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("v1.customers.list", "customers:read", async ({ request, context }) => {
  const { limit, cursor } = parseQuery(request, pageQuerySchema);
  const filters = parseQuery(request, customerListQuery);
  const page = await listCustomers(context.tenantId, filters, limit, cursor);
  return listResult(page.items, page.nextCursor);
});

export const POST = v1Route("v1.customers.create", "customers:write", async ({ request, context }) => {
  const idempotencyKey = getIdempotencyKey(request);
  const body = await parseJsonBody(request, newCustomerBody);
  return oneResult(await createCustomer(context, body, idempotencyKey), 201);
});
