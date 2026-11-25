/**
 * The built-in test checkout (`/pay/test/[orderId]`) mimics a provider's page so payments can be tried with no
 * real money. It does not exist in production. Browser tests run the production build on this machine, so they may
 * switch it on with KALENDR_E2E_TEST_CHECKOUT=true, and only when the app's address is localhost.
 */
export function testCheckoutEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== "production") return true;
  return env.KALENDR_E2E_TEST_CHECKOUT === "true" && /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(env.NEXT_PUBLIC_APP_URL ?? "");
}

/**
 * Where the test checkout sends the browser back to: only a page under /manage/ on this site.
 * Anything else (another site, another path, a scheme-relative address) is refused with null.
 */
export function safeReturnPath(value: string | undefined | null): string | null {
  if (!value || value.length > 600 || !value.startsWith("/manage/") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) return null;
  try {
    const url = new URL(value, "http://kalendr.invalid");
    if (url.origin !== "http://kalendr.invalid" || !url.pathname.startsWith("/manage/") || url.pathname.includes("//")) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}
