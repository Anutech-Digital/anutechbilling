/** LinkedIn Community Management API configuration. */

export const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_POSTS_URL = "https://api.linkedin.com/rest/posts";
export const LINKEDIN_COMPANY_POST_SCOPE = "w_organization_social";
/** Advertising API is approved separately from Community Management. */
export const LINKEDIN_ADS_SCOPES = ["r_ads", "r_ads_reporting"] as const;
export const LINKEDIN_CALLBACK_PATH = "/api/integrations/linkedin/callback";
export const LINKEDIN_ADS_CALLBACK_PATH = "/api/integrations/linkedin-ads/callback";
export const LINKEDIN_STATE_COOKIE = "linkedin_oauth_nonce";
export const LINKEDIN_STATE_TTL_MS = 10 * 60 * 1000;

export interface LinkedInCreds { clientId: string; clientSecret: string }

/** OAuth credentials belong to this deployment, never to the browser. */
export function linkedInCreds(): LinkedInCreds | null {
  const clientId = process.env.LINKEDIN_CLIENT_ID?.trim();
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function linkedInRedirectUri(origin: string): string {
  return process.env.LINKEDIN_REDIRECT_URI?.trim() || `${origin.replace(/\/+$/, "")}${LINKEDIN_CALLBACK_PATH}`;
}

export function linkedInAdsRedirectUri(origin: string): string {
  return process.env.LINKEDIN_ADS_REDIRECT_URI?.trim() || `${origin.replace(/\/+$/, "")}${LINKEDIN_ADS_CALLBACK_PATH}`;
}

export function linkedInAuthUrl(clientId: string, redirectUri: string, state: string, scopes: readonly string[] = [LINKEDIN_COMPANY_POST_SCOPE]): string {
  const q = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, state,
    scope: scopes.join(" "),
  });
  return `${LINKEDIN_AUTH_URL}?${q}`;
}

/** Can be overridden when LinkedIn publishes a newer Marketing API version. */
export function linkedInApiVersion(): string {
  return process.env.LINKEDIN_API_VERSION?.trim() || "202610";
}
