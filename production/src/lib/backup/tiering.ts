/**
 * R-2140 (GP-21b, goal G-PERSONAL): nightly backup tiering for PERSONAL workspaces.
 *
 * Free personal workspaces will be many, small and mostly idle. A full nightly snapshot of each
 * (~134 tables + export + off-site upload, 7 copies in the database) would make the 600 s Cloud
 * Run budget and backup.snapshots grow with FREE sign-ups. So:
 *
 *   business  → always the full backup_tenant() snapshot, 7 kept (unchanged behaviour).
 *   personal  → PERSONAL_BACKUP_POLICY:
 *     'only-if-changed' (code default) — backup_tenant_tiered() writes a snapshot only when the
 *                       data differs from the tenant's newest snapshot; keeps
 *                       PERSONAL_SNAPSHOT_RETENTION.
 *     'keep-one'        — a snapshot every night, only the newest 1 kept.
 *     'skip'            — no nightly snapshot at all (rely on Cloud SQL PITR + the off-site copy
 *                         of the whole database).
 *
 * OWNER DECISION (needsDecision on R-2140): which policy for free personal tenants. Change the
 * constant below — nothing else. The database refuses to tier a business tenant whatever is
 * passed (migration 20261030114917_gp21b_backup_tiering.sql).
 *
 * Pure: no I/O.
 */
import { parseWorkspaceKind } from "@/lib/workspace/kind";

export type PersonalBackupPolicy = "only-if-changed" | "keep-one" | "skip";

export const PERSONAL_BACKUP_POLICY: PersonalBackupPolicy = "only-if-changed";

/** Restore points kept for a personal tenant. Must stay below SNAPSHOT_RETENTION (7, business). */
export const PERSONAL_SNAPSHOT_RETENTION = 2;

/** What the tiered DB function is asked to do. */
export interface TieredPlan {
  onlyIfChanged: boolean;
  keep: number;
}

export type BackupPlan =
  | { mode: "full" }
  | ({ mode: "tiered" } & TieredPlan)
  | { mode: "none" };

export function backupPlanFor(
  workspaceKind: unknown,
  policy: PersonalBackupPolicy = PERSONAL_BACKUP_POLICY,
): BackupPlan {
  if (parseWorkspaceKind(workspaceKind) !== "personal") return { mode: "full" };
  switch (policy) {
    case "skip":
      return { mode: "none" };
    case "keep-one":
      return { mode: "tiered", onlyIfChanged: false, keep: 1 };
    default:
      return { mode: "tiered", onlyIfChanged: true, keep: PERSONAL_SNAPSHOT_RETENTION };
  }
}
