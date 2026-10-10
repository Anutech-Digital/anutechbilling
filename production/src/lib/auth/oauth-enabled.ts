/**
 * Is an OAuth provider (Google) switched on in this Supabase project? (R-098, 1 Oct 2026)
 *
 * `signInWithOAuth` sends the browser straight to Supabase's /authorize. When the
 * provider is off — every local `supabase start`, possibly staging — that page is raw
 * JSON: {"msg":"Unsupported provider: provider is not enabled"}, and the user is stuck
 * on it. GoTrue's public /auth/v1/settings says which providers are on, so the login
 * page asks first and shows a plain message instead.
 *
 * Returns true / false, or null when it cannot tell (network error, odd reply) — the
 * caller then goes ahead as before, so a flaky check never blocks a working login.
 */
export async function isOAuthProviderEnabled(
  supabaseUrl: string,
  provider: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean | null> {
  /* With Auth.js the providers that are switched on are listed by /api/auth/providers. */
  if (process.env.NEXT_PUBLIC_AUTH_PROVIDER === "authjs") {
    try {
      const res = await fetchFn("/api/auth/providers");
      if (!res.ok) return null;
      const json = (await res.json()) as Record<string, unknown> | null;
      return Boolean(json && provider in json);
    } catch {
      return null;
    }
  }
  try {
    const res = await fetchFn(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/settings`);
    if (!res.ok) return null;
    const json = (await res.json()) as { external?: Record<string, unknown> };
    const v = json?.external?.[provider];
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}
