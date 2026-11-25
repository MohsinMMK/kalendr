import { oneResult, v1Route } from "@/server/api-v1";
import { getCustomer, pathId } from "@/server/api-v1-reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = v1Route("v1.customers.get", "customers:read", async ({ context, params }) => {
  const id = pathId(params.id, { code: "customer_not_found", message: "Customer not found." });
  return oneResult(await getCustomer(context.tenantId, id));
});
