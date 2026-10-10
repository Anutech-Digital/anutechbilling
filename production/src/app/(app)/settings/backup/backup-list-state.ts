/**
 * R-823: what the Backup & Restore list area shows. Before this, a failed
 * list_tenant_backups call fell through to `data ?? []` and rendered "No backups
 * yet", which told the owner they had nothing when the list simply hadn't loaded.
 */

export type BackupListState =
  | { kind: "loading" }
  | { kind: "owner_only" }
  | { kind: "error" }
  | { kind: "empty" }
  | { kind: "list" };

/** SQLSTATE 42501 (insufficient_privilege) is the owner-only guard; PostgREST/gateway send it as 403. */
export function isOwnerOnlyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42501";
}

export function backupListState(q: { isLoading: boolean; isError: boolean; error: unknown; rowCount: number }): BackupListState {
  if (q.isLoading) return { kind: "loading" };
  if (q.isError) return isOwnerOnlyError(q.error) ? { kind: "owner_only" } : { kind: "error" };
  return q.rowCount === 0 ? { kind: "empty" } : { kind: "list" };
}
