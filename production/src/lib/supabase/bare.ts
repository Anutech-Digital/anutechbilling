/**
 * Drop-in for `createClient` from @supabase/supabase-js, for the server files that build their
 * own client with a key (19 of them, mostly src/lib/ai/*, measured 5 Oct 2026).
 *
 * With the VM switches on, a client built straight from supabase-js would send its requests
 * over HTTP — and the public gateway route refuses the service-role key on purpose. This keeps
 * those requests in-process instead (same identity rules: the key decides who the caller is),
 * and with AUTH_PROVIDER=authjs answers `auth.signInWithPassword` — used by change-password and
 * reset-data only to re-check the current password — from Auth.js's account store, without
 * creating a session. With every switch off it is exactly supabase-js's createClient.
 */
import "server-only";
import { createClient } from "@supabase/supabase-js";
import { gatewayEnabled, gatewayFetch } from "@/server/postgrest/fetch";
import { storageGatewayEnabled } from "@/server/storage/backend";
import { authProvider } from "@/server/auth/authjs";
import { checkPassword } from "@/server/auth/accounts";

const passwordCheckOnly = {
  async signInWithPassword(creds: { email: string; password: string }) {
    const r = await checkPassword(creds.email, creds.password);
    if (r.ok) return { data: { user: r.user, session: null }, error: null };
    const message = r.reason === "email_not_confirmed" ? "Email not confirmed" : r.reason === "banned" ? "User is banned" : "Invalid login credentials";
    return { data: { user: null, session: null }, error: { name: "AuthApiError", message, status: 400, code: r.reason } };
  },
};

export const createBareClient = ((url: string, key: string, options?: Parameters<typeof createClient>[2]) => {
  const inProcess = gatewayEnabled() || storageGatewayEnabled();
  const client = createClient(url, key, {
    ...options,
    ...(authProvider() === "authjs" ? { accessToken: async () => key } : {}),
    global: {
      ...options?.global,
      ...(inProcess ? { fetch: gatewayFetch(url, { allowService: true }) } : {}),
    },
  });
  return authProvider() === "authjs" ? Object.assign(client, { auth: passwordCheckOnly }) : client;
}) as unknown as typeof createClient;
