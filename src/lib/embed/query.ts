/**
 * The website connection's two address parameters (feature 52): `kalendrNonce` and `kalendrParentOrigin`, set by the loader.
 * Shared by the booking pages (on the server) and the booking flow (in the browser), so both read them the same way.
 */
/**
 * True when this deployment itself is served over plain http on this machine (local development, or the browser tests'
 * production build). A website on a local http address may then frame booking, because there is no https page to
 * downgrade from. Every real deployment is https, so it never applies there.
 */
export function isLoopbackDeployment(): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.NEXT_PUBLIC_APP_URL ?? "");
}

export function readEmbedBridge(
  searchParams: Record<string, string | string[] | undefined>,
): { nonce: string; parentOrigin: string } | null {
  const nonce = searchParams.kalendrNonce;
  const requestedParentOrigin = searchParams.kalendrParentOrigin;
  if (
    searchParams.embed !== "1" ||
    typeof nonce !== "string" ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    typeof requestedParentOrigin !== "string"
  ) {
    return null;
  }

  try {
    const parentUrl = new URL(requestedParentOrigin);
    const isLocalDevelopment =
      (process.env.NODE_ENV !== "production" || isLoopbackDeployment()) &&
      parentUrl.protocol === "http:" &&
      (parentUrl.hostname === "localhost" || parentUrl.hostname === "127.0.0.1");
    if (
      parentUrl.origin !== requestedParentOrigin ||
      (parentUrl.protocol !== "https:" && !isLocalDevelopment)
    ) {
      return null;
    }
    return { nonce, parentOrigin: parentUrl.origin };
  } catch {
    return null;
  }
}
