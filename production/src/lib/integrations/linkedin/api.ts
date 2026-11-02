import { LINKEDIN_POSTS_URL, LINKEDIN_TOKEN_URL, linkedInApiVersion, type LinkedInCreds } from "./config";

const TIMEOUT_MS = 15_000;

export class LinkedInApiError extends Error {}

async function json(res: Response): Promise<Record<string, unknown>> {
  try { return await res.json() as Record<string, unknown>; } catch { return {}; }
}

export async function exchangeLinkedInCode(code: string, redirectUri: string, creds: LinkedInCreds): Promise<{ accessToken: string; expiresAt: string | null }> {
  let res: Response;
  try {
    res = await fetch(LINKEDIN_TOKEN_URL, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: creds.clientId, client_secret: creds.clientSecret }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new LinkedInApiError("Could not reach LinkedIn. Check the connection and try again."); }
  const body = await json(res);
  const token = typeof body.access_token === "string" ? body.access_token : "";
  if (!res.ok || !token) throw new LinkedInApiError("LinkedIn did not accept the connection. Check that Company Page posting access is approved, then try again.");
  const seconds = Number(body.expires_in);
  return { accessToken: token, expiresAt: Number.isFinite(seconds) && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null };
}

/** Publish a text-only public Company Page post. The returned ID is safe to show, never the token. */
export async function publishLinkedInPost(token: string, organizationUrn: string, text: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(LINKEDIN_POSTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": linkedInApiVersion(),
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: organizationUrn, commentary: text, visibility: "PUBLIC", lifecycleState: "PUBLISHED",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch { throw new LinkedInApiError("Could not reach LinkedIn. Try posting again."); }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) throw new LinkedInApiError("LinkedIn access expired. Connect LinkedIn again.");
    if (res.status === 403) throw new LinkedInApiError("LinkedIn did not allow this post. The connected person must be a Company Page admin and the app needs Company Page posting access.");
    console.error("[linkedin] post failed", res.status, body.slice(0, 300));
    throw new LinkedInApiError("LinkedIn could not publish this post. Try again or reconnect LinkedIn.");
  }
  return res.headers.get("x-restli-id");
}
