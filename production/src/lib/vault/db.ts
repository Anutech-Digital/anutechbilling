/**
 * Typed access to the vault tables before their migration is applied.
 *
 * ─── WHY THIS SHIM EXISTS ────────────────────────────────────────────────────
 * `src/lib/supabase/types.ts` is GENERATED FROM THE LIVE DATABASE. Migration
 * 0234 has not been applied yet, so as far as TypeScript is concerned
 * `vault_passwords` and `vault_access_log` do not exist, and every query against
 * them is a compile error.
 *
 * That is a real ordering problem, not a nuisance: in this project the operator
 * applies migrations by hand, so code has to be written and reviewed BEFORE the
 * schema exists. The alternatives were worse — scattering `as unknown as` casts
 * through the route handlers (three already exist elsewhere in the codebase, and
 * each one is a place where a typo in a column name compiles fine), or holding
 * the feature until someone runs the SQL.
 *
 * So the row shapes are written out by hand here, once, matching 0234 exactly.
 * They are a claim about the schema that a reviewer can check against the
 * migration file side by side, which is more than a cast gives you.
 *
 * ─── DELETE THIS FILE WHEN 0234 IS APPLIED ───────────────────────────────────
 * Once the migration is live and `types.ts` is regenerated, these tables appear
 * in the generated types and this shim becomes a way for the code to disagree
 * with the database without anything failing. Remove it and import the generated
 * types instead.
 */
import type { createClient } from "@/lib/supabase/server";

export type VaultCategory =
  | "google_admin" | "m365_admin" | "dns_registrar" | "cpanel" | "distributor" | "other";

/** One row of `vault_passwords`, per migration 0234. */
export interface VaultPasswordRow {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  title: string;
  category: VaultCategory;
  url: string | null;
  username_ciphertext: string | null;
  password_ciphertext: string | null;
  notes_ciphertext: string | null;
  password_fingerprint: string | null;
  last_rotated_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type VaultAccessAction =
  "view" | "copy" | "create" | "update" | "delete" | "rotate" | "export";

/** One row of `vault_access_log`, per migration 0234. Append-only. */
export interface VaultAccessLogInsert {
  tenant_id: string;
  credential_id?: string | null;
  customer_id?: string | null;
  user_id?: string | null;
  action: VaultAccessAction;
  ip_address?: string | null;
  user_agent?: string | null;
}

type ServerClient = ReturnType<typeof createClient>;

/** Postgres "relation does not exist" — 0234 has not been applied. */
export const UNDEFINED_TABLE = "42P01";

interface Result<T> { data: T; error: { code?: string; message: string } | null }

/**
 * The narrow slice of the Supabase query builder these routes actually use.
 * Deliberately small: anything not listed here cannot be called through the
 * shim, so the untyped surface stays the size of what the vault needs rather
 * than the whole client.
 */
interface VaultQueries {
  from(table: "vault_passwords"): {
    select(columns: string): {
      order(column: string): Promise<Result<VaultPasswordRow[] | null>>;
      eq(column: string, value: string): {
        maybeSingle(): Promise<Result<VaultPasswordRow | null>>;
        eq(column: string, value: string): {
          maybeSingle(): Promise<Result<VaultPasswordRow | null>>;
        };
      };
    };
    insert(row: Partial<VaultPasswordRow>): {
      select(columns: string): { single(): Promise<Result<{ id: string } | null>> };
    };
  };
  from(table: "vault_access_log"): {
    insert(row: VaultAccessLogInsert): Promise<{ error: { message: string } | null }>;
  };
}

/**
 * View a Supabase client through the vault's hand-written table types.
 *
 * The cast is the whole point of the file — it happens once, here, next to the
 * row definitions it is asserting, instead of at every call site.
 */
export function vaultDb(sb: ServerClient): VaultQueries {
  return sb as unknown as VaultQueries;
}
