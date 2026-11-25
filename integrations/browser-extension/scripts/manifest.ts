/**
 * The extension's manifest (Manifest V3, Chrome and Edge). It asks for as little as it can: `storage` to keep the sign-in,
 * and permission to call one address, Kalendr's. No tabs, no page access, no content scripts, no cookies, no identity.
 * A test (src/manifest.test.ts) holds the permissions to exactly this.
 */
export interface ManifestInput { origin: string; version: string }

export function buildManifest({ origin, version }: ManifestInput) {
  return {
    manifest_version: 3,
    name: "Kalendr",
    short_name: "Kalendr",
    version,
    description: "Copy your Kalendr booking links, share open times in an email and see today's bookings from the toolbar.",
    minimum_chrome_version: "116",
    action: { default_title: "Kalendr", default_popup: "popup.html", default_icon: { "16": "icons/icon-16.png", "32": "icons/icon-32.png" } },
    icons: { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
    background: { service_worker: "background.js", type: "module" },
    permissions: ["storage"],
    host_permissions: [`${new URL(origin).origin}/*`],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'; base-uri 'none'" },
  };
}
