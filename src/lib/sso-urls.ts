/** The addresses the owner pastes into their identity provider (feature 53). One set per connection. */
export function serviceProviderUrls(origin: string, connectionId: string): { entityId: string; acsUrl: string; metadataUrl: string; redirectUri: string } {
  const base = origin.replace(/\/$/, "");
  return {
    entityId: `${base}/api/sso/saml/${connectionId}`,
    acsUrl: `${base}/api/sso/saml/${connectionId}/acs`,
    metadataUrl: `${base}/api/sso/saml/${connectionId}/metadata`,
    redirectUri: `${base}/api/sso/oidc/${connectionId}/callback`,
  };
}
