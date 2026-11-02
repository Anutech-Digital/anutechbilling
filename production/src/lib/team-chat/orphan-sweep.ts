/**
 * R-2337 (G-TEAMCHAT, 1 Nov 2026): find and delete team chat files that belong to no message.
 *
 * R-2332 made storage the truth for chat files: a file removed from the composer, or a file of a
 * deleted message, is deleted by the BROWSER. When that delete fails the object stays in storage
 * (only its uploader and the owner can still see it). SQL cannot delete storage bytes
 * (storage.protect_delete), so the nightly cron /api/cron/chat-files-cleanup calls this with the
 * service-role client and deletes them through the Storage API.
 *
 * Scope — ONLY bucket "documents", ONLY {tenant}/chat/{channel}/{file} (the shape R-2297/R-2332
 * write). A file is an orphan when ALL hold:
 *   · it is older than 24 h (a file still in someone's composer is younger),
 *   · no chat_attachments row has its path (it is on no message),
 *   · no chat_upload_tickets row has its path (no upload in progress).
 * If either lookup fails, nothing of that tenant is deleted (fail safe). At most
 * MAX_DELETES_PER_RUN deletions per run, removed in batches of REMOVE_BATCH; the rest waits for
 * the next night. Dry run: everything is counted, nothing is deleted.
 */

export const CHAT_BUCKET = "documents";
export const ORPHAN_MIN_AGE_MS = 24 * 3600 * 1000;
export const MAX_DELETES_PER_RUN = 500;
export const REMOVE_BATCH = 100;
const LIST_PAGE = 1000;
const LOOKUP_CHUNK = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The slice of supabase-js this needs (the service-role admin client satisfies it). */
export interface SweepStorageBucket {
  list(prefix: string, opts: { limit: number; offset: number; sortBy?: { column: string; order: string } }): PromiseLike<{
    data: { name: string; id: string | null; created_at?: string | null }[] | null;
    error: { message: string } | null;
  }>;
  remove(paths: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export interface SweepClient {
  storage: { from(bucket: string): SweepStorageBucket };
  from(table: string): unknown;
}

type InQuery = {
  select(cols: string): { in(col: string, values: string[]): PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }> };
};

export interface TenantCounts { scanned: number; orphans: number; deleted: number }

export interface SweepResult {
  dry: boolean;
  tenants: number;
  scanned: number;
  kept_fresh: number;
  kept_on_message: number;
  kept_open_ticket: number;
  orphans: number;
  deleted: number;
  /** true when the per-run cap stopped deletion; the rest goes next run. */
  capped: boolean;
  per_tenant: Record<string, TenantCounts>;
  errors: string[];
}

export interface SweepOptions {
  now: number;
  dry: boolean;
  maxDeletes?: number;
  /** The cron gate's company filter (cronTenantAllowed). */
  allowTenant?: (tenantId: string) => boolean;
  log?: (line: string) => void;
}

/** Every entry of one storage folder, page by page. */
async function listAll(bucket: SweepStorageBucket, prefix: string) {
  const out: { name: string; id: string | null; created_at?: string | null }[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`list ${prefix}: ${error.message}`);
    const page = data ?? [];
    out.push(...page);
    if (page.length < LIST_PAGE) return out;
  }
}

/** Paths among `paths` that appear in `table.col`. Throws on a failed read. */
async function present(client: SweepClient, table: string, col: string, paths: string[]): Promise<Set<string>> {
  const hit = new Set<string>();
  for (let i = 0; i < paths.length; i += LOOKUP_CHUNK) {
    const chunk = paths.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await (client.from(table) as InQuery).select(col).in(col, chunk);
    if (error) throw new Error(`${table}: ${error.message}`);
    for (const r of data ?? []) if (typeof r[col] === "string") hit.add(r[col] as string);
  }
  return hit;
}

export async function sweepChatOrphans(client: SweepClient, tenantIds: string[], o: SweepOptions): Promise<SweepResult> {
  const maxDeletes = o.maxDeletes ?? MAX_DELETES_PER_RUN;
  const cutoff = o.now - ORPHAN_MIN_AGE_MS;
  const bucket = client.storage.from(CHAT_BUCKET);
  const r: SweepResult = {
    dry: o.dry, tenants: 0, scanned: 0, kept_fresh: 0, kept_on_message: 0, kept_open_ticket: 0,
    orphans: 0, deleted: 0, capped: false, per_tenant: {}, errors: [],
  };

  for (const tenant of tenantIds) {
    if (!UUID.test(tenant)) continue;
    if (o.allowTenant && !o.allowTenant(tenant)) continue;
    r.tenants += 1;
    const counts: TenantCounts = { scanned: 0, orphans: 0, deleted: 0 };
    r.per_tenant[tenant] = counts;
    try {
      const root = `${tenant}/chat`;
      const channels = (await listAll(bucket, root)).filter((e) => e.id === null && UUID.test(e.name));
      const old: string[] = [];
      for (const ch of channels) {
        for (const f of await listAll(bucket, `${root}/${ch.name}`)) {
          if (f.id === null || !f.name || f.name.includes("/") || f.name.includes("..")) continue;
          counts.scanned += 1;
          const at = f.created_at ? Date.parse(f.created_at) : NaN;
          if (!Number.isFinite(at) || at > cutoff) { r.kept_fresh += 1; continue; }
          old.push(`${root}/${ch.name}/${f.name}`);
        }
      }
      r.scanned += counts.scanned;
      if (old.length === 0) { report(o, tenant, counts); continue; }

      const onMessage = await present(client, "chat_attachments", "file_path", old);
      const ticketed = await present(client, "chat_upload_tickets", "path", old);
      const orphans: string[] = [];
      for (const p of old) {
        if (onMessage.has(p)) r.kept_on_message += 1;
        else if (ticketed.has(p)) r.kept_open_ticket += 1;
        else orphans.push(p);
      }
      counts.orphans = orphans.length;
      r.orphans += orphans.length;

      if (!o.dry) {
        const budget = Math.max(0, maxDeletes - r.deleted);
        if (orphans.length > budget) r.capped = true;
        const todo = orphans.slice(0, budget);
        for (let i = 0; i < todo.length; i += REMOVE_BATCH) {
          const batch = todo.slice(i, i + REMOVE_BATCH);
          const { data, error } = await bucket.remove(batch);
          if (error) { r.errors.push(`${tenant}: remove: ${error.message}`); continue; }
          /* Storage answers with the objects it removed; one already gone (the browser's own
             delete got there after all) is not counted. */
          const n = Array.isArray(data) ? data.length : batch.length;
          counts.deleted += n;
          r.deleted += n;
        }
      }
    } catch (e) {
      r.errors.push(`${tenant}: ${(e as Error).message}`);
    }
    report(o, tenant, counts);
  }
  return r;
}

function report(o: SweepOptions, tenant: string, c: TenantCounts) {
  if (c.scanned === 0) return;
  (o.log ?? console.info)(
    `[cron/chat-files-cleanup] ${tenant}: scanned ${c.scanned}, orphans ${c.orphans}, ${o.dry ? "would delete" : "deleted"} ${o.dry ? c.orphans : c.deleted}`,
  );
}
