/**
 * Guards for integration tests that need a throwaway local PostgreSQL: the isolated PostgreSQL 18 check (5545), a
 * database of your own (5609) or the shared local server's own copy (5601, database kalendr_f7). Never anything else.
 */
const ports = ["5545", "5609", "5601", "5611", "5583", "5631", "5653", "5657", "5661", "5671"];
const databases = ["/kalendr_local", "/kalendr_f7", "/kalendr_e2e"];

export function isIsolatedDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ports.includes(parsed.port) && (databases.includes(parsed.pathname) || /^\/kalendr_e2e_[a-z0-9]{1,12}$/.test(parsed.pathname));
}

/** True when every URL is an isolated database and the app is not in preview mode. */
export function isolatedDatabaseReady(...urls: (string | undefined)[]): boolean {
  return urls.length > 0 && urls.every(isIsolatedDatabaseUrl) && process.env.KALENDR_PREVIEW_MODE === "false";
}
