import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

import { SignedXml } from "xml-crypto";

/**
 * A stand-in identity provider for tests (feature 53): it makes a throwaway signing key, reads the AuthnRequest Kalendr sends and
 * answers with a signed SAML response. No test talks to a real Okta, Azure AD or Google Workspace.
 */
export interface TestIdp {
  entityId: string;
  certificate: string;
  privateKey: string;
}

export function createTestIdp(entityId = "https://idp.test.example/metadata"): TestIdp {
  const dir = mkdtempSync(join(tmpdir(), "kalendr-idp-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=test-idp"], { stdio: "ignore" });
    return { entityId, certificate: readFileSync(join(dir, "cert.pem"), "utf8"), privateKey: readFileSync(join(dir, "key.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The id of the AuthnRequest in a redirect URL, which the response must answer. */
export function requestIdFrom(redirectUrl: string): string {
  const encoded = new URL(redirectUrl).searchParams.get("SAMLRequest");
  if (!encoded) throw new Error("The redirect has no SAMLRequest.");
  const xml = inflateRawSync(Buffer.from(encoded, "base64")).toString("utf8");
  const id = /ID="([^"]+)"/.exec(xml)?.[1];
  if (!id) throw new Error("The request has no id.");
  return id;
}

export interface ResponseOptions {
  idp: TestIdp;
  /** The service provider's entity id (the audience) and reply address. */
  audience: string;
  acsUrl: string;
  inResponseTo: string;
  email: string;
  name?: string;
  /** Faults to inject, one per negative test. */
  sign?: boolean;
  signWith?: TestIdp;
  audienceOverride?: string;
  expired?: boolean;
  issuerOverride?: string;
}

const iso = (date: Date) => date.toISOString();

/** A base64 SAMLResponse, signed on the assertion unless a test asks otherwise. */
export function buildSamlResponse(options: ResponseOptions): string {
  const now = new Date();
  const issuer = options.issuerOverride ?? options.idp.entityId;
  const notOnOrAfter = options.expired ? new Date(now.getTime() - 3_600_000) : new Date(now.getTime() + 300_000);
  const notBefore = options.expired ? new Date(now.getTime() - 7_200_000) : new Date(now.getTime() - 60_000);
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_assertion${now.getTime()}${Math.floor(Math.random() * 1e6)}" Version="2.0" IssueInstant="${iso(now)}">`
    + `<saml:Issuer>${issuer}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${options.email}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${iso(notOnOrAfter)}" Recipient="${options.acsUrl}" InResponseTo="${options.inResponseTo}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(notBefore)}" NotOnOrAfter="${iso(notOnOrAfter)}"><saml:AudienceRestriction><saml:Audience>${options.audienceOverride ?? options.audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="_session1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${options.email}</saml:AttributeValue></saml:Attribute>`
    + (options.name ? `<saml:Attribute Name="displayName"><saml:AttributeValue>${options.name}</saml:AttributeValue></saml:Attribute>` : "")
    + `</saml:AttributeStatement></saml:Assertion>`;

  let signed = assertion;
  if (options.sign !== false) {
    const signer = options.signWith ?? options.idp;
    const sig = new SignedXml({ privateKey: signer.privateKey, publicCert: signer.certificate, signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256", canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#" });
    sig.addReference({ xpath: "/*[local-name(.)='Assertion']", transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"], digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256" });
    sig.computeSignature(assertion, { location: { reference: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
    signed = sig.getSignedXml();
  }
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response${now.getTime()}${Math.floor(Math.random() * 1e6)}" Version="2.0" IssueInstant="${iso(now)}" Destination="${options.acsUrl}" InResponseTo="${options.inResponseTo}">`
    + `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signed}</samlp:Response>`;
  return Buffer.from(response).toString("base64");
}
