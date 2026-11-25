// Prints the current authenticator code for a local test login (.local-db/<file>.json with totpSecret).
// Usage: node scripts/dev-totp.mjs [kalendr-test-owner]
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
const name = process.argv[2] ?? "kalendr-test-owner";
const { totpSecret } = JSON.parse(readFileSync(new URL(`../.local-db/${name}.json`, import.meta.url), "utf8"));
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = "";
for (const c of totpSecret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
const h = createHmac("sha1", key).update(counter).digest();
const o = h[h.length - 1] & 15;
const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
const left = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(code, `(${left}s left)`);
