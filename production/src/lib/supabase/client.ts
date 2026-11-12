/**
 * Supabase BROWSER client — for client components.
 *
 * Uses cookies for session storage so it shares auth state with the server client.
 *
 * @example In a "use client" component:
 *   const supabase = createClient();
 *   const { data } = await supabase.from("leads").select("*");
 */
import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./database.types";
import { createSupabaseFetch } from "./fetch-wrapper";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        fetch: createSupabaseFetch(),
      },
    },
  );
}

/** Inferred type of our browser client (for explicit annotations) */
export type TypedSupabaseBrowser = ReturnType<typeof createClient>;

/** True if Supabase env vars look configured (not placeholder values). */
export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return Boolean(
    url &&
    key &&
    !url.includes("your-project") &&
    key.length > 20
  );
}
