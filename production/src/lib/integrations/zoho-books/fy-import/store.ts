/**
 * R-2499 — GENERIC FY import framework, part 2: the scan and the batches in the database, for ONE
 * company and ONE kind (Zoho list), through the server's admin client. The admin client bypasses
 * RLS, so EVERY read and write below is filtered by `tenantId` and `kind` (CLAUDE.md §17c); the
 * tenant comes from the signed-in user's own row (resolveZohoCaller), never from the request.
 * Tables: zoho_fy_scan_runs, zoho_fy_scan, zoho_fy_import_batches (migration 20261105160100).
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { FyReadKind } from "../fy-fetch";
import type { ScanFacts, ScanStore, ScanRun, ListedRow } from "./scan";

type Res<T = unknown> = PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>;
/** The slice of the Supabase query builder used here (the new tables are not in the generated types yet). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Q = any;
export interface FyImportDb { from(table: string): Q }

export function must<T>(r: { data: T | null; error: { message?: string } | null }, what: string): T {
  if (r.error) throw new Error(`Could not read ${what}.`);
  return (r.data ?? ([] as unknown)) as T;
}

export function supabaseScanStore<F extends ScanFacts>(db: FyImportDb, tenantId: string, kind: FyReadKind): ScanStore<F> {
  const scan = () => db.from("zoho_fy_scan");
  const runs = () => db.from("zoho_fy_scan_runs");
  return {
    async readRun(fy) {
      const r = await (runs().select("next_page, list_done").eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy).limit(1) as Res<Array<{ next_page: number; list_done: boolean }>>);
      const row = must(r, "the Zoho read")[0];
      return row ? { nextPage: row.next_page, listDone: row.list_done } : null;
    },
    async saveRun(fy, run: ScanRun) {
      const r = await (runs().upsert(
        { tenant_id: tenantId, kind, fy, next_page: run.nextPage, list_done: run.listDone, updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,kind,fy" }) as Res);
      if (r.error) throw new Error("Could not save the Zoho read.");
    },
    async addListed(fy, rows: ListedRow[]) {
      if (!rows.length) return;
      const known = must(await (scan().select("zoho_id, zoho_status, fy").eq("tenant_id", tenantId).eq("kind", kind)
        .in("zoho_id", rows.map((x) => x.zohoId)) as Res<Array<{ zoho_id: string; zoho_status: string; fy: string }>>), "the Zoho read");
      const prev = new Map(known.map((k) => [k.zoho_id, k]));
      const now = new Date().toISOString();
      const fresh: Record<string, unknown>[] = [];
      const kept: Record<string, unknown>[] = [];
      for (const x of rows) {
        const p = prev.get(x.zohoId);
        const base = { tenant_id: tenantId, kind, fy, zoho_id: x.zohoId, number: x.number.slice(0, 60), doc_date: x.date || null, zoho_status: x.status, listed_at: now };
        /* New, or its status changed in Zoho since it was read (draft → sent, sent → void): read the detail again. */
        if (!p || p.zoho_status !== x.status || p.fy !== fy) fresh.push({ ...base, payload: null, detailed_at: null });
        else kept.push(base);
      }
      /* Two shapes → two upserts, so a kept payload is never nulled. */
      for (const group of [fresh, kept]) {
        if (!group.length) continue;
        const r = await (scan().upsert(group, { onConflict: "tenant_id,kind,zoho_id" }) as Res);
        if (r.error) throw new Error("Could not save the Zoho read.");
      }
    },
    async pendingDetails(fy, limit) {
      const r = await (scan().select("zoho_id").eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy).is("payload", null)
        .order("doc_date", { ascending: true }).order("zoho_id", { ascending: true }).limit(limit) as Res<Array<{ zoho_id: string }>>);
      return must(r, "the Zoho read").map((x) => x.zoho_id);
    },
    async saveDetail(fy, zohoId, facts: F) {
      const r = await (scan().update({ payload: facts, detailed_at: new Date().toISOString(), zoho_status: facts.status, number: facts.number.slice(0, 60), doc_date: facts.date || null })
        .eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy).eq("zoho_id", zohoId) as Res);
      if (r.error) throw new Error("Could not save the Zoho read.");
    },
    async drop(fy, zohoId) {
      const r = await (scan().delete().eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy).eq("zoho_id", zohoId) as Res);
      if (r.error) throw new Error("Could not save the Zoho read.");
    },
    async counts(fy) {
      const head = (detailed: boolean) => {
        let q = scan().select("zoho_id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy);
        q = detailed ? q.not("payload", "is", null) : q;
        return q as PromiseLike<{ count: number | null; error: unknown }>;
      };
      const [a, b] = await Promise.all([head(false), head(true)]);
      if (a.error || b.error) throw new Error("Could not count the Zoho read.");
      return { listed: a.count ?? 0, detailed: b.count ?? 0 };
    },
    async reset(fy) {
      const a = await (runs().delete().eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy) as Res);
      const b = await (scan().delete().eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy) as Res);
      if (a.error || b.error) throw new Error("Could not clear the Zoho read.");
    },
  };
}

/** Every detailed document of the FY with its facts, in the scan's stable order (date, Zoho id). */
export async function readScannedFacts<F>(db: FyImportDb, tenantId: string, kind: FyReadKind, fy: string): Promise<F[]> {
  const rows = await fetchAllRows<{ payload: F }>((from, to) => db.from("zoho_fy_scan")
    .select("payload").eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy).not("payload", "is", null)
    .order("doc_date", { ascending: true }).order("zoho_id", { ascending: true }).range(from, to));
  return rows.map((r) => r.payload);
}

export interface ImportBatch {
  id: string; createdAt: string; importedCount: number; skippedCount: number; alreadyCount: number;
  taxableTotal: number; taxTotal: number; amountTotal: number; removedAt: string | null;
}

/** This company's import batches of one kind for the FY, newest first. */
export async function readImportBatches(db: FyImportDb, tenantId: string, kind: FyReadKind, fy: string): Promise<ImportBatch[]> {
  const r = await (db.from("zoho_fy_import_batches")
    .select("id, created_at, imported_count, skipped_count, already_count, taxable_total, tax_total, amount_total, removed_at")
    .eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy).order("created_at", { ascending: false }).limit(50) as Res<Array<Record<string, unknown>>>);
  return must(r, "the imports").map((b) => ({
    id: String(b.id), createdAt: String(b.created_at), importedCount: Number(b.imported_count), skippedCount: Number(b.skipped_count),
    alreadyCount: Number(b.already_count), taxableTotal: Number(b.taxable_total), taxTotal: Number(b.tax_total),
    amountTotal: Number(b.amount_total), removedAt: (b.removed_at as string | null) ?? null,
  }));
}
