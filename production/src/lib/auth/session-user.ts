/**
 * R-1896 — the middleware's one read of the signed-in member's users row.
 *
 * It now also reads `access_ends_on` (employee exit: the login works through the last working
 * day, off from the next). If code reaches a database where that column is not there yet
 * (code deployed before the migration), the read falls back to the old column list instead of
 * failing — a failed read would leave every member with no role. The database layer
 * (current_tenant_id) is the hard stop either way.
 */
export const SESSION_USER_COLUMNS = "role, can_view_deals, is_active, access_ends_on";
export const SESSION_USER_COLUMNS_LEGACY = "role, can_view_deals, is_active";

export interface SessionUserRow {
  role?: string | null;
  can_view_deals?: boolean | null;
  is_active?: boolean | null;
  access_ends_on?: string | null;
}

type Res = { data: unknown; error: { code?: string; message?: string } | null };

/** Postgres 42703 / PostgREST PGRST204, or the message, for a column that does not exist. */
export function isMissingColumnError(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  return /column .*access_ends_on.* does not exist|could not find the 'access_ends_on' column/i.test(err.message ?? "");
}

/** Runs `read(columns)`; on a missing-column error retries once with the legacy list. */
export async function readSessionUser(
  read: (columns: string) => PromiseLike<Res>,
): Promise<{ data: SessionUserRow | null; error: Res["error"] }> {
  const first = await read(SESSION_USER_COLUMNS);
  if (first.error && isMissingColumnError(first.error)) {
    const second = await read(SESSION_USER_COLUMNS_LEGACY);
    return { data: (second.data as SessionUserRow | null) ?? null, error: second.error };
  }
  return { data: (first.data as SessionUserRow | null) ?? null, error: first.error };
}
