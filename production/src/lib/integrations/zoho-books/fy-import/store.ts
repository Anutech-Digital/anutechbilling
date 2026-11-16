/**
 * R-2499 — GENERIC FY import framework, part 2: the scan and the batches in the database, for ONE
 * company and ONE kind (Zoho list), through the server's admin client. The admin client bypasses
 * RLS, so EVERY read and write below is filtered by `tenantId` and `kind` (CLAUDE.md §17c); the
 * tenant comes from the signed-in user's own row (resolveZohoCaller), never from the request.
 * Tables: zoho_fy_scan_runs, zoho_fy_scan, zoho_fy_import_batches (migration 20261105160100).
 */
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { FyReadKind } from "../fy-fetch";
import { classifyListed, factsVersionOf, receiptFactsIncomplete, type ScanFacts, type ScanStore, type ScanRun, type ListedRow } from "./scan";

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
      const r = await (runs().select("next_page, list_done, list_started_at, only_account_id").eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy).limit(1) as
        Res<Array<{ next_page: number; list_done: boolean; list_started_at: string | null; only_account_id: string | null }>>);
      const row = must(r, "the Zoho read")[0];
      return row ? { nextPage: row.next_page, listDone: row.list_done, listStartedAt: row.list_started_at ?? null, onlyAccount: row.only_account_id ?? null } : null;
    },
    async saveRun(fy, run: ScanRun) {
      const row = { next_page: run.nextPage, list_done: run.listDone, updated_at: new Date().toISOString() };
      /* No run stored yet (readRun gave null): create it. */
      if (run.listStartedAt === undefined) {
        const r = await (runs().upsert({ tenant_id: tenantId, kind, fy, ...row }, { onConflict: "tenant_id,kind,fy" }) as Res);
        if (r.error) throw new Error("Could not save the Zoho read.");
        return;
      }
      /* R-2653: only the SAME read moves the run on — a Read again (refresh) or a fresh start since this
         pass read the run wins; the old pass's save then changes nothing (0 rows). */
      const q = runs().update(row).eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy);
      const r = await ((run.listStartedAt === null ? q.is("list_started_at", null) : q.eq("list_started_at", run.listStartedAt)) as Res);
      if (r.error) throw new Error("Could not save the Zoho read.");
    },
    async addListed(fy, rows: ListedRow[], run) {
      if (!rows.length) return;
      const onlyAccount = run?.onlyAccount ?? null;
      /* R-2694: for customer payments also the two payload fields the foreign-receipt import needs — a
         stored detail without them is read again (only those rows; no facts-version bump for all). */
      const receipts = kind === "customerpayments";
      /* review: the in-process data gateway (DATA_GATEWAY=1, src/server/postgrest/parse.ts) refuses JSON
         paths in a select — the whole payload is read (one listed page, receipts only). */
      const cols = "zoho_id, zoho_status, fy, zoho_modified, detailed_at, deposit_account_id, facts_version"
        + (receipts ? ", payload" : "");
      const known = must(await (scan().select(cols).eq("tenant_id", tenantId).eq("kind", kind)
        .in("zoho_id", rows.map((x) => x.zohoId)) as Res<Array<{
          zoho_id: string; zoho_status: string; fy: string; zoho_modified: string | null; detailed_at: string | null;
          deposit_account_id: string | null; facts_version: number | null;
          payload?: { currency?: unknown; foreignLines?: unknown } | null;
        }>>), "the Zoho read");
      const fxOf = (p: { currency?: unknown; foreignLines?: unknown } | null | undefined) => ({
        currency: typeof p?.currency === "string" ? p.currency : null,
        foreignLines: Array.isArray(p?.foreignLines) ? "y" : null,
      });
      const prev = new Map(known.map((k) => [k.zoho_id, {
        status: k.zoho_status, fy: k.fy, modified: k.zoho_modified, detailedAt: k.detailed_at,
        /* saveDetail sets payload + detailed_at together; a fresh row nulls both. */
        hasDetail: k.detailed_at !== null,
        accountId: k.deposit_account_id, factsVersion: k.facts_version,
        factsIncomplete: receipts && k.detailed_at !== null && receiptFactsIncomplete(fxOf(k.payload)),
      }]));
      /* R-2653: never stamped before this read's start (another server's clock may be behind). */
      const startMs = Date.parse(run?.listStartedAt ?? "");
      const now = new Date(Number.isFinite(startMs) ? Math.max(Date.now(), startMs) : Date.now()).toISOString();
      const version = factsVersionOf(kind);
      const fresh: Record<string, unknown>[] = [];
      const kept: Record<string, unknown>[] = [];
      const seen: string[] = [];
      for (const x of rows) {
        const verdict = classifyListed(prev.get(x.zohoId), x, fy, onlyAccount, version);
        if (verdict === "skip") continue;
        if (verdict === "seen") { seen.push(x.zohoId); continue; }
        const base = {
          tenant_id: tenantId, kind, fy, zoho_id: x.zohoId, number: x.number.slice(0, 60), doc_date: x.date || null, zoho_status: x.status, listed_at: now,
          zoho_modified: x.modified || prev.get(x.zohoId)?.modified || null, deposit_account_id: x.accountId || null,
        };
        /* New, or changed since it was read (status, FY, facts version, last_modified_time): read the detail again. */
        if (verdict === "fresh") fresh.push({ ...base, payload: null, detailed_at: null });
        else kept.push(base);
      }
      /* Two shapes → two upserts, so a kept payload is never nulled. */
      for (const group of [fresh, kept]) {
        if (!group.length) continue;
        const r = await (scan().upsert(group, { onConflict: "tenant_id,kind,zoho_id" }) as Res);
        if (r.error) throw new Error("Could not save the Zoho read.");
      }
      /* R-2653: outside this read's deposit account — only "still in Zoho's list" (not requeued); facts,
         status and modified time stay as they were, so a read of all accounts still checks it. */
      if (seen.length) {
        const r = await (scan().update({ listed_at: now }).eq("tenant_id", tenantId).eq("kind", kind).in("zoho_id", seen) as Res);
        if (r.error) throw new Error("Could not save the Zoho read.");
      }
    },
    async requeueUnlisted(fy, since) {
      /* Their detail is read again: a 404 drops the ones deleted in Zoho, the rest are kept (never a blind delete). */
      const r = await (scan().update({ payload: null, detailed_at: null }).eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy)
        .lt("listed_at", since).select("zoho_id") as Res<Array<{ zoho_id: string }>>);
      return must(r, "the Zoho read").length;
    },
    async refresh(fy, opts) {
      /* R-2653: keep every stored detail; list again from page 1 (only new / changed documents get a
         detail call). The rows stay — the ones not listed again are re-checked when the list finishes. */
      const r = await (runs().upsert(
        { tenant_id: tenantId, kind, fy, next_page: 1, list_done: false, list_started_at: opts.nowIso, only_account_id: opts.onlyAccount, updated_at: opts.nowIso },
        { onConflict: "tenant_id,kind,fy" }) as Res);
      if (r.error) throw new Error("Could not start the Zoho read again.");
    },
    async pendingDetails(fy, limit) {
      const r = await (scan().select("zoho_id").eq("tenant_id", tenantId).eq("kind", kind).eq("fy", fy).is("payload", null)
        .order("doc_date", { ascending: true }).order("zoho_id", { ascending: true }).limit(limit) as Res<Array<{ zoho_id: string }>>);
      return must(r, "the Zoho read").map((x) => x.zoho_id);
    },
    async saveDetail(fy, zohoId, facts: F) {
      const r = await (scan().update({
        payload: facts, detailed_at: new Date().toISOString(), zoho_status: facts.status, number: facts.number.slice(0, 60), doc_date: facts.date || null,
        /* R-2653: which normaliser made these facts — a newer one reads the detail again on Read again. */
        facts_version: factsVersionOf(kind),
      })
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
