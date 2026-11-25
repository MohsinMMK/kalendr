// Zips the built extension for the Chrome Web Store and Edge Add-ons. It refuses to package a check build: the zip must be
// made from a build whose KALENDR_ORIGIN is the real production address, because that address is both the only host the
// extension may call and the only permission it asks for.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestFile = resolve(root, "dist/manifest.json");
if (!existsSync(manifestFile)) throw new Error("Build first: KALENDR_ORIGIN=https://your.kalendr.address pnpm build:extension");
const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
const hosts = manifest.host_permissions ?? [];
if (hosts.length !== 1 || !hosts[0].startsWith("https://") || /localhost|127\.0\.0\.1|\.example\b/.test(hosts[0])) {
  throw new Error(`The build allows ${hosts.join(", ") || "no host"}. Rebuild with KALENDR_ORIGIN set to your real https address before packaging.`);
}
const out = resolve(root, "../../dist");
mkdirSync(out, { recursive: true });
const zip = resolve(out, `kalendr-extension-${manifest.version}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-rq", zip, ".", "-x", "*.DS_Store"], { cwd: resolve(root, "dist") });
console.log(`Wrote ${zip}`);
