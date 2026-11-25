import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What every log line and error report carries: the request id, the tenant and the
 * route name. Values are identifiers only, never personal data.
 */
export interface RequestContext {
  requestId?: string;
  tenantId?: string;
  route?: string;
  jobId?: string;
  /** Next.js's error digest, shown to the visitor as "Reference" on the error screen. */
  errorDigest?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `operation` with `context` merged over whatever context is already active. */
export function withRequestContext<T>(context: RequestContext, operation: () => T): T {
  return storage.run({ ...storage.getStore(), ...definedOnly(context) }, operation);
}

export function currentRequestContext(): RequestContext {
  return storage.getStore() ?? {};
}

// The tenant an error was thrown inside. withTenant records it here on the way out,
// so routeErrorResponse can report it without each of the routes passing it along.
const errorTenants = new WeakMap<object, string>();

export function rememberErrorTenant(error: unknown, tenantId: string): void {
  if (error && typeof error === "object" && !errorTenants.has(error)) errorTenants.set(error, tenantId);
}

export function errorTenant(error: unknown): string | undefined {
  return error && typeof error === "object" ? errorTenants.get(error) : undefined;
}

function definedOnly(context: RequestContext): RequestContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)) as RequestContext;
}
