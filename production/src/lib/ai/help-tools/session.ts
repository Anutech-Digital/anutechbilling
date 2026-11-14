/**
 * HelpSession — the signed-in person's own login, and nothing else (R-2774 / H-01).
 *
 * The runner accepts ONLY a HelpSession made here. openHelpSession() builds the cookie client
 * itself (createClient — the person's session, Postgres RLS); a session object made anywhere
 * else is not in SESSIONS and is refused, so no caller can hand the runner the service-role
 * client or a client built from a key. As a second lock, a client whose key is a service-role
 * key (JWT role "service_role", or an sb_secret_ key) is refused here too.
 *
 * Only this file under lib/ai/help-tools may import @/lib/supabase/server, and only
 * `createClient` (src/lib/security/help-tools-guard.test.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

type Client = SupabaseClient<Database>;

/** Opaque handle: no fields, cannot be forged — only objects made by openHelpSession count. */
export interface HelpSession { readonly __helpSession: unique symbol }

const SESSIONS = new WeakMap<object, Client>();

/** The role claim of a Supabase JWT key, or "secret" for the new sb_secret_ keys. */
export function keyRole(key: unknown): string | null {
  if (typeof key !== "string" || !key) return null;
  if (key.startsWith("sb_secret_")) return "secret";
  const part = key.split(".")[1];
  if (!part) return null;
  try {
    const json = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { role?: unknown };
    return typeof json.role === "string" ? json.role : null;
  } catch {
    return null;
  }
}

export class HelpSessionRefused extends Error {
  constructor(why: string) { super(`help session refused: ${why}`); this.name = "HelpSessionRefused"; }
}

const ADMIN_ROLES = new Set(["service_role", "secret", "supabase_admin"]);

/** A fixed Authorization header on the client (supabase-js keeps it on .headers / .rest.headers). */
function fixedBearers(client: unknown): unknown[] {
  const c = client as { headers?: Record<string, unknown>; rest?: { headers?: Record<string, unknown> } } | null;
  const out: unknown[] = [];
  for (const h of [c?.headers, c?.rest?.headers]) {
    if (!h || typeof h !== "object") continue;
    for (const k of ["Authorization", "authorization"]) {
      const v = h[k];
      if (typeof v === "string") out.push(v.replace(/^Bearer\s+/i, ""));
    }
  }
  return out;
}

/**
 * Throws when the client carries a key or a fixed bearer that skips RLS. Defence in depth: the
 * real lock is that openHelpSession builds the client itself with createClient (guard test).
 * A per-request accessToken callback cannot be read here — createClient's is the person's own.
 */
export function assertNotServiceRole(client: unknown): void {
  const key = (client as { supabaseKey?: unknown } | null)?.supabaseKey;
  for (const k of [key, ...fixedBearers(client)]) {
    const role = keyRole(k);
    if (role && ADMIN_ROLES.has(role)) throw new HelpSessionRefused("service-role key");
  }
}

/** The signed-in person's session for Help AI tools. Call inside a request (cookies). */
export function openHelpSession(): HelpSession {
  const client = createClient() as unknown as Client;
  assertNotServiceRole(client);
  const session = Object.freeze(Object.create(null)) as HelpSession;
  SESSIONS.set(session, client);
  return session;
}

/** The client behind a session made by openHelpSession; throws for anything else. */
export function sessionClient(session: HelpSession): Client {
  const client = typeof session === "object" && session !== null ? SESSIONS.get(session) : undefined;
  if (!client) throw new HelpSessionRefused("not a session from openHelpSession()");
  assertNotServiceRole(client);
  return client;
}
