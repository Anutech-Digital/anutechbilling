/**
 * R-2510 (G-SOCIAL): one run of the scheduled-post publisher. Pure over its ports so the rule
 * "only an approved post whose time has come, at most once" is tested without Meta or a database.
 * The cron route (api/cron/social-publish) wires the ports to the admin client and the Graph API.
 */
import { isDue } from "./social-schedule";

export interface DueRow {
  id: string; tenant_id: string; platform: "facebook" | "instagram"; format: "post" | "story";
  caption: string; media_url: string | null; status: string; scheduled_at: string | null;
  /** R-2729: the Page it goes out on (null on rows made before many Pages). */
  page_id?: string | null;
  /** R-2687: "scheduled" = planned by the AI. Optional for older callers. */
  origin?: string;
  /** R-2692: who approved it. An approved row with no approver on record is never published. */
  reviewed_by: string | null;
}

export interface PublishPorts {
  /** Approved rows whose scheduled_at <= now, oldest first (the query may over-fetch; isDue re-checks).
   *  R-2692: `tenants` = only these companies (undefined = all), so due posts of companies whose
   *  switch is off can never fill the per-run limit and hold back the others. */
  listDue(now: Date, limit: number, tenants?: string[]): Promise<DueRow[]>;
  /** approved → publishing for exactly this row; false when someone else already took it. */
  claim(id: string): Promise<boolean>;
  /** R-2729: the Page the row belongs to (null = the company's main Page). */
  connection(tenantId: string, pageId?: string | null): Promise<{ pageId: string | null; pageToken: string | null }>;
  publish(row: DueRow, connection: { pageId: string | null; pageToken: string | null }): Promise<string>;
  /** publishing → published (externalId) or failed (error). */
  complete(id: string, externalId: string | null, error: string | null): Promise<void>;
  tenantAllowed?(tenantId: string): boolean;
  /** R-2687: true while the company pressed "Stop all AI" — its AI-planned posts wait, people's posts still go. */
  aiPaused?(tenantId: string): Promise<boolean>;
  /** R-2687: one line in the activity list per published / failed post. */
  log?(row: DueRow, result: "ok" | "failed", detail: string): Promise<void>;
  /** R-2692: the companies this pass may work on; undefined = no limit. */
  allowedTenants?(): string[] | undefined;
}

export const PER_RUN_LIMIT = 25;

export async function runScheduledPublish(ports: PublishPorts, now: Date = new Date()) {
  const rows = (await ports.listDue(now, PER_RUN_LIMIT, ports.allowedTenants?.()))
    .filter((r) => isDue(r, now) && !!r.reviewed_by);
  let published = 0, failed = 0, skipped = 0;
  const connections = new Map<string, Promise<{ pageId: string | null; pageToken: string | null }>>();
  for (const row of rows) {
    if (ports.tenantAllowed && !ports.tenantAllowed(row.tenant_id)) { skipped++; continue; }
    if (row.origin === "scheduled" && ports.aiPaused && (await ports.aiPaused(row.tenant_id))) { skipped++; continue; }
    if (!(await ports.claim(row.id))) { skipped++; continue; }
    try {
      const key = `${row.tenant_id}:${row.page_id ?? ""}`;
      if (!connections.has(key)) connections.set(key, ports.connection(row.tenant_id, row.page_id ?? null));
      const externalId = await ports.publish(row, await connections.get(key)!);
      await ports.complete(row.id, externalId, null);
      published++;
      await ports.log?.(row, "ok", "Posted").catch(() => undefined);
    } catch (e) {
      const message = (e instanceof Error ? e.message : "Meta publishing failed.").slice(0, 300);
      await ports.complete(row.id, null, message);
      failed++;
      await ports.log?.(row, "failed", `Could not post: ${message}`).catch(() => undefined);
    }
  }
  return { due: rows.length, published, failed, skipped };
}
