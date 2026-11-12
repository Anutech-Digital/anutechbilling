/**
 * R-2510 (G-SOCIAL): one run of the scheduled-post publisher. Pure over its ports so the rule
 * "only an approved post whose time has come, at most once" is tested without Meta or a database.
 * The cron route (api/cron/social-publish) wires the ports to the admin client and the Graph API.
 */
import { isDue } from "./social-schedule";

export interface DueRow {
  id: string; tenant_id: string; platform: "facebook" | "instagram"; format: "post" | "story";
  caption: string; media_url: string | null; status: string; scheduled_at: string | null;
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
  connection(tenantId: string): Promise<{ pageId: string | null; pageToken: string | null }>;
  publish(row: DueRow, connection: { pageId: string | null; pageToken: string | null }): Promise<string>;
  /** publishing → published (externalId) or failed (error). */
  complete(id: string, externalId: string | null, error: string | null): Promise<void>;
  tenantAllowed?(tenantId: string): boolean;
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
    if (!(await ports.claim(row.id))) { skipped++; continue; }
    try {
      if (!connections.has(row.tenant_id)) connections.set(row.tenant_id, ports.connection(row.tenant_id));
      const externalId = await ports.publish(row, await connections.get(row.tenant_id)!);
      await ports.complete(row.id, externalId, null);
      published++;
    } catch (e) {
      await ports.complete(row.id, null, (e instanceof Error ? e.message : "Meta publishing failed.").slice(0, 300));
      failed++;
    }
  }
  return { due: rows.length, published, failed, skipped };
}
