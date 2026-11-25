import { describe, expect, it } from "vitest";

import { isPublicAddress } from "./ip-ranges";
import { createHttpsTransport } from "./transport";
import { BlockedAddressError, resolvePublicTarget, validateWebhookUrl, type HostResolver } from "./url-guard";

const privateHosts = [
  "127.0.0.1", "127.1", "0x7f.1", "0177.0.0.1", "2130706433", "0.0.0.0", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
  "169.254.169.254", "100.64.0.1", "100.127.255.255", "224.0.0.1", "255.255.255.255", "240.0.0.1", "198.18.0.1", "192.0.2.1",
  "[::1]", "[::]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::ffff:10.0.0.1]", "[::ffff:169.254.169.254]", "[fe80::1]", "[fc00::1]", "[fd12:3456::1]",
  "[ff02::1]", "[64:ff9b::7f00:1]", "[2001:db8::1]", "[2002:7f00:1::]", "localhost", "LOCALHOST", "localhost.", "foo.localhost", "printer.local",
  "metadata.google.internal", "intranet", "db.corp", "router.lan",
];
const publicHosts = ["example.com", "hooks.example.co.in", "8.8.8.8", "[2606:4700:4700::1111]", "1.1.1.1", "[::ffff:8.8.8.8]", "172.32.0.1", "100.128.0.1"];

describe("validateWebhookUrl", () => {
  it.each(privateHosts)("refuses %s", (host) => {
    expect(validateWebhookUrl(`https://${host}/hook`).ok).toBe(false);
  });

  it.each(publicHosts)("accepts %s", (host) => {
    expect(validateWebhookUrl(`https://${host}/hook`)).toMatchObject({ ok: true });
  });

  it("refuses http and other schemes, including the exact address from the spec", () => {
    for (const url of ["http://127.0.0.1/hook", "http://example.com/hook", "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "//example.com/x", "example.com/hook"]) {
      expect(validateWebhookUrl(url).ok).toBe(false);
    }
  });

  it("refuses credentials, fragments, odd ports and over-long addresses", () => {
    expect(validateWebhookUrl("https://user:pw@example.com/").ok).toBe(false);
    expect(validateWebhookUrl("https://user@example.com/").ok).toBe(false);
    expect(validateWebhookUrl("https://example.com/#x").ok).toBe(false);
    expect(validateWebhookUrl("https://example.com:8080/").ok).toBe(false);
    expect(validateWebhookUrl("https://example.com:22/").ok).toBe(false);
    expect(validateWebhookUrl(`https://example.com/${"a".repeat(2000)}`).ok).toBe(false);
    expect(validateWebhookUrl("").ok).toBe(false);
    expect(validateWebhookUrl("   ").ok).toBe(false);
  });

  it("allows only ports 443 and 8443", () => {
    expect(validateWebhookUrl("https://example.com:443/x").ok).toBe(true);
    expect(validateWebhookUrl("https://example.com:8443/x").ok).toBe(true);
  });

  it("explains a refusal in a plain sentence and keeps the path and query", () => {
    const refused = validateWebhookUrl("http://127.0.0.1/x");
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok === false && refused.message).toMatch(/https/);
    expect(validateWebhookUrl("https://example.com/a/b?c=1")).toEqual({ ok: true, url: "https://example.com/a/b?c=1" });
  });
});

describe("isPublicAddress", () => {
  it("is false for text that is not an address", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("")).toBe(false);
    expect(isPublicAddress("999.1.1.1")).toBe(false);
  });
  it("treats IPv6 forms of public IPv4 as public and of private as private", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("::ffff:192.168.0.1")).toBe(false);
    expect(isPublicAddress("2606:4700::1")).toBe(true);
  });
});

describe("connect-time guard", () => {
  const answering = (...addresses: string[]): HostResolver => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

  it("returns the address it checked", async () => {
    expect(await resolvePublicTarget("hooks.example.com", answering("93.184.216.34"))).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("refuses a name that resolves to a private address", async () => {
    await expect(resolvePublicTarget("evil.example.com", answering("10.0.0.7"))).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("refuses when ANY answer is private, so a mixed answer can not slip through", async () => {
    await expect(resolvePublicTarget("evil.example.com", answering("93.184.216.34", "127.0.0.1"))).rejects.toBeInstanceOf(BlockedAddressError);
    await expect(resolvePublicTarget("evil.example.com", answering("2606:4700::1", "::1"))).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("the transport reports blocked_address and connection_failed as fixed codes without connecting", async () => {
    const send = (resolver: HostResolver) => createHttpsTransport(resolver).send({ url: "https://evil.example.com/x", headers: {}, body: "{}", timeoutMs: 500 });
    expect(await send(answering("169.254.169.254"))).toEqual({ kind: "error", errorCode: "blocked_address" });
    expect(await send(async () => [])).toEqual({ kind: "error", errorCode: "connection_failed" });
    expect(await send(async () => { throw new Error("ENOTFOUND"); })).toEqual({ kind: "error", errorCode: "connection_failed" });
    expect(await createHttpsTransport(answering("1.1.1.1")).send({ url: "https://[::1]/x", headers: {}, body: "{}", timeoutMs: 500 })).toEqual({ kind: "error", errorCode: "blocked_address" });
  });
});
