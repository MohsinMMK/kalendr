import { describe, expect, it } from "vitest";

import { authorizeQuery, builtinClientById, createClientInput, isAllowedRedirect, parseScopeList, tokenRequest } from "./oauth";

describe("OAuth shapes", () => {
  it("recognises our extension's redirect address and nothing close to it", () => {
    const client = builtinClientById("kalendr-extension")!;
    expect(client.redirectPattern.test(`https://${"a".repeat(32)}.chromiumapp.org/`)).toBe(true);
    expect(client.redirectPattern.test(`https://${"a".repeat(32)}.chromiumapp.org/cb`)).toBe(true);
    expect(client.redirectPattern.test(`https://${"a".repeat(31)}.chromiumapp.org/`)).toBe(false);
    expect(client.redirectPattern.test(`https://${"a".repeat(32)}.chromiumapp.org.evil.com/`)).toBe(false);
    expect(client.redirectPattern.test(`http://${"a".repeat(32)}.chromiumapp.org/`)).toBe(false);
    expect(client.redirectPattern.test(`https://evil.com/${"a".repeat(32)}.chromiumapp.org/`)).toBe(false);
    expect(builtinClientById("other")).toBeNull();
  });

  it("holds the extension to narrow scopes", () => {
    expect(builtinClientById("kalendr-extension")!.scopes).toEqual(["services:read", "bookings:today", "links:write"]);
  });

  it("allows https anywhere and http only on this machine, never with a fragment or a password", () => {
    expect(isAllowedRedirect("https://app.example.com/cb")).toBe(true);
    expect(isAllowedRedirect("http://localhost:3000/cb")).toBe(true);
    expect(isAllowedRedirect("http://127.0.0.1/cb")).toBe(true);
    expect(isAllowedRedirect("http://app.example.com/cb")).toBe(false);
    expect(isAllowedRedirect("https://app.example.com/cb#x")).toBe(false);
    expect(isAllowedRedirect("https://user:pw@app.example.com/cb")).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)")).toBe(false);
    expect(isAllowedRedirect("not a url")).toBe(false);
  });

  it("parses scope lists, refusing unknown words", () => {
    expect(parseScopeList(undefined)).toEqual([]);
    expect(parseScopeList("services:read  links:write services:read")).toEqual(["services:read", "links:write"]);
    expect(parseScopeList("services:read admin")).toBeNull();
  });

  it("insists on PKCE with S256", () => {
    const base = { response_type: "code", client_id: "c", redirect_uri: "https://a.example.com/cb", code_challenge: "A".repeat(43), code_challenge_method: "S256" };
    expect(authorizeQuery.safeParse(base).success).toBe(true);
    expect(authorizeQuery.safeParse({ ...base, code_challenge_method: "plain" }).success).toBe(false);
    expect(authorizeQuery.safeParse({ ...base, code_challenge: "short" }).success).toBe(false);
    expect(authorizeQuery.safeParse({ ...base, response_type: "token" }).success).toBe(false);
  });

  it("checks token requests by grant type", () => {
    expect(tokenRequest.safeParse({ grant_type: "authorization_code", code: "kac_" + "x".repeat(43), redirect_uri: "https://a/cb", client_id: "c", code_verifier: "v".repeat(43) }).success).toBe(true);
    expect(tokenRequest.safeParse({ grant_type: "authorization_code", code: "kac_" + "x".repeat(43), redirect_uri: "https://a/cb", client_id: "c", code_verifier: "short" }).success).toBe(false);
    expect(tokenRequest.safeParse({ grant_type: "refresh_token", refresh_token: "krt_" + "x".repeat(43), client_id: "c" }).success).toBe(true);
    expect(tokenRequest.safeParse({ grant_type: "password", username: "a" }).success).toBe(false);
  });

  it("validates a registered app", () => {
    const ok = { name: "CRM", redirectUris: ["https://crm.example.com/cb"], scopes: ["services:read"] };
    expect(createClientInput.safeParse(ok).success).toBe(true);
    expect(createClientInput.safeParse({ ...ok, redirectUris: [] }).success).toBe(false);
    expect(createClientInput.safeParse({ ...ok, redirectUris: ["http://evil.example.com/cb"] }).success).toBe(false);
    expect(createClientInput.safeParse({ ...ok, scopes: ["root"] }).success).toBe(false);
    expect(createClientInput.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
});

describe("returning from sign-in", () => {
  it("goes back only to the two approval pages", async () => {
    const { approvalReturnPath } = await import("./oauth");
    expect(approvalReturnPath("/oauth/device?code=BCDF-GHJK")).toBe("/oauth/device?code=BCDF-GHJK");
    expect(approvalReturnPath("/oauth/authorize?client_id=x&redirect_uri=https%3A%2F%2Fa.example.com%2Fcb")).not.toBeNull();
    expect(approvalReturnPath("/oauth/device")).toBe("/oauth/device");
    for (const bad of [null, "https://evil.example.com", "//evil.example.com", "/dashboard", "/oauth/other", "/oauth/device?x=<script>", "/oauth/device/../../x", "/oauth/device#x"]) {
      expect(approvalReturnPath(bad), String(bad)).toBeNull();
    }
  });
});
