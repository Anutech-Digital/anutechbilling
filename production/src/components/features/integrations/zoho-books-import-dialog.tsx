"use client";
/**
 * R-1753 — Settings → Integrations → Zoho Books → "Import from Zoho".
 *
 * One way through, one primary button per state:
 *   nothing read yet → Dry run (reads Zoho read-only; nothing is imported)
 *   reading          → progress; continues by itself, resumes after a closed window
 *   read             → counts + problems → Import
 *   imported         → what came in + batch id → Undo import (refused once a payment exists)
 * Subscriptions are read from the last 24 months of invoices by default (12 / 36 offered) —
 * said on screen, because older live multi-year terms are not seen.
 * R-1760: Import (and Undo) go part by part — "Importing… 300 of 1,245 customers" — and keep
 * calling until done; after an error the reason shows with "Continue import", which resumes.
 */
import * as React from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAskText, useConfirm } from "@/components/providers/confirm-provider";
import { formatDate, rupee } from "@/lib/utils";
import {
  importPercent, importProgressText, type ImportProgress, type ImportStage,
} from "@/lib/integrations/zoho-books/import-parts";

const URL_IMPORT = "/api/integrations/zoho-books/import";

export interface RunView {
  id: string;
  phase: "contacts" | "invoices" | "details" | "ready";
  since: string;
  months: number;
  contacts_read: number;
  invoices_read: number;
  details_total: number;
  details_done: number;
  last_error: string | null;
  imported_at: string | null;
  undone_at: string | null;
  result: Record<string, unknown> | null;
  /* R-1760: the import in parts (absent on older answers) */
  import_stage?: ImportStage | null;
  import_offset?: number;
  import_totals?: ImportProgress["totals"] | null;
  undo_started_at?: string | null;
}
interface ProblemGroup { code: string; label: string; blocks: boolean; count: number; examples: string[] }
interface Summary {
  counts: {
    contacts: number; customersNew: number; customersExisting: number;
    subscriptionsToImport: number; subscriptionsAlready: number; subscriptionsEnded: number; oneTimeInvoices: number;
    invoicesToImport: number; invoicesAlready: number;
  };
  totals: { mrr: number; openBalance: number };
  problems: ProblemGroup[];
}

const fmt = (n: number) => n.toLocaleString("en-IN");
const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(URL_IMPORT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data: Record<string, unknown> = {};
  try { data = (await res.json()) as Record<string, unknown>; } catch { /* empty */ }
  return { ok: res.ok, data };
}

/** What the reading step is doing, in words. */
export function phaseText(r: RunView): string {
  if (r.phase === "contacts") return `Reading customers from Zoho… ${fmt(r.contacts_read)} so far`;
  if (r.phase === "invoices") return `Reading invoices from Zoho… ${fmt(r.invoices_read)} so far`;
  if (r.phase === "details") {
    const left = Math.max(0, r.details_total - r.details_done);
    const mins = Math.ceil(left / 85);
    return `Reading invoice lines ${fmt(r.details_done)} of ${fmt(r.details_total)}${left > 0 ? ` · about ${mins} min left` : ""}`;
  }
  return "Read from Zoho";
}

export function ZohoBooksImportDialog({ open, onOpenChange, orgName }: {
  open: boolean; onOpenChange: (v: boolean) => void; orgName: string;
}) {
  const confirm = useConfirm();
  const askText = useAskText();
  const [run, setRun] = React.useState<RunView | null>(null);
  const [lastImport, setLastImport] = React.useState<RunView | null>(null);
  const [months, setMonths] = React.useState(24);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [busy, setBusy] = React.useState<null | "start" | "dry" | "import" | "undo">(null);
  const [reading, setReading] = React.useState(false);
  const [waitUntil, setWaitUntil] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [progress, setProgress] = React.useState<ImportProgress | null>(null);
  const openRef = React.useRef(open);
  openRef.current = open;

  const load = React.useCallback(async () => {
    const res = await fetch(URL_IMPORT);
    let body: Record<string, unknown> = {};
    try { body = (await res.json()) as Record<string, unknown>; } catch { /* empty */ }
    if (!res.ok) { setError(String(body.error ?? "Could not read the Zoho import status.")); setLoaded(true); return; }
    setRun((body.open as RunView | null) ?? null);
    setLastImport((body.last_import as RunView | null) ?? null);
    setLoaded(true);
  }, []);

  React.useEffect(() => {
    if (!open) { setReading(false); setSummary(null); setError(null); setLoaded(false); setProgress(null); return; }
    void load();
  }, [open, load]);

  const loadSummary = React.useCallback(async () => {
    setBusy("dry");
    try {
      const { ok, data } = await post({ action: "dry_run" });
      if (!ok) { setError(String(data.error ?? "Could not work out the dry run.")); return; }
      setSummary(data.summary as Summary);
    } finally { setBusy(null); }
  }, []);

  /* Reading loop: one step at a time while the window is open and the run is not read yet. */
  React.useEffect(() => {
    if (!open || !reading || !run || run.phase === "ready") return;
    let cancelled = false;
    (async () => {
      if (waitUntil && Date.now() < waitUntil) {
        await new Promise((r) => setTimeout(r, Math.max(0, waitUntil - Date.now())));
        if (cancelled) return;
        setWaitUntil(null);
      }
      const { ok, data } = await post({ action: "step" });
      if (cancelled || !openRef.current) return;
      if (!ok) { setError(String(data.error ?? "Reading from Zoho stopped.")); setReading(false); return; }
      setError(null);
      const next = data.open as RunView | null;
      if (data.rate_limited) setWaitUntil(Date.now() + 60_000);
      setRun(next);
    })();
    return () => { cancelled = true; };
  }, [open, reading, run, waitUntil]);

  /* When reading finishes, show the dry run. */
  React.useEffect(() => {
    if (open && run?.phase === "ready" && !run.import_stage && !summary && busy !== "dry") {
      setReading(false);
      void loadSummary();
    }
  }, [open, run, summary, busy, loadSummary]);

  async function startDryRun() {
    if (run) {
      const again = await confirm({
        title: "Read Zoho again from the start?",
        body: "What was read so far is thrown away and the dry run starts over. Nothing is imported.",
        confirmLabel: run.phase === "ready" ? "Read again" : "Start again",
      });
      if (!again) return;
    }
    setBusy("start");
    setSummary(null);
    setError(null);
    try {
      const { ok, data } = await post({ action: "start", months });
      if (!ok) { setError(String(data.error ?? "Could not start the dry run.")); return; }
      setRun(data.open as RunView);
      setReading(true);
    } finally { setBusy(null); }
  }

  async function doImport() {
    if (!summary) return;
    const c = summary.counts;
    const ok = await confirm({
      title: "Import from Zoho Books?",
      body: `${fmt(c.customersNew)} new customers, ${fmt(c.subscriptionsToImport)} live subscriptions and ${fmt(c.invoicesToImport)} open invoices come into this company, part by part — keep this window open until it finishes.\nExisting customers are not changed. Open invoices do not count as GST or revenue. You can undo the import until a payment is recorded on it.`,
      confirmLabel: "Import",
    });
    if (!ok) return;
    await runImport();
  }

  /* R-1760: one part per call, until done. Also "Continue import" after an error. */
  async function runImport() {
    setBusy("import");
    setError(null);
    try {
      for (let guard = 0; guard < 2000; guard++) {
        const { ok: fine, data } = await post({ action: "import" });
        if (!fine) {
          setError(String(data.error ?? "The import stopped. Press Continue import."));
          await load();
          return;
        }
        const p = data.progress as ImportProgress;
        setProgress(p);
        if (p.done) {
          const r = (p.result ?? {}) as Record<string, unknown>;
          toast.success("Imported from Zoho Books", {
            description: `${fmt(n(r.customers_created))} customers · ${fmt(n(r.subscriptions_created))} subscriptions · ${fmt(n(r.invoices_imported))} open invoices`,
          });
          setSummary(null);
          setProgress(null);
          await load();
          return;
        }
      }
    } finally { setBusy(null); }
  }

  /* R-1760: Undo removes what fits in one call; call again until done. */
  async function runUndo(runId: string, reason: string): Promise<boolean> {
    for (let guard = 0; guard < 200; guard++) {
      const { ok, data } = await post({ action: "undo", run_id: runId, reason });
      if (!ok) { toast.error(String(data.error ?? "Could not undo the import."), { description: "Press Undo import again to finish." }); return false; }
      const r = (data.result ?? {}) as Record<string, unknown>;
      if (r.done !== false) return true;
    }
    return false;
  }

  async function undoHalfDone() {
    if (!run) return;
    const reason = await askText({
      title: "Undo what was imported so far?",
      body: "Removes the customers, contacts, subscriptions and open invoices this import created so far. Customers that were already here are not touched. Then you can run a new dry run.",
      label: "Why (goes in the activity log)",
      confirmLabel: "Undo import",
      danger: true,
    });
    if (!reason) return;
    setBusy("undo");
    try {
      if (await runUndo(run.id, reason)) {
        toast.success("Import undone");
        setError(null);
        setProgress(null);
      }
      await load();
    } finally { setBusy(null); }
  }

  async function undo() {
    if (!lastImport) return;
    const reason = await askText({
      title: "Undo this import?",
      body: "Removes the customers, contacts, subscriptions and open invoices this import created. Refused once a payment, quote or bill uses any of them. Customers that were already here are not touched.",
      label: "Why (goes in the activity log)",
      confirmLabel: "Undo import",
      danger: true,
    });
    if (!reason) return;
    setBusy("undo");
    try {
      if (await runUndo(lastImport.id, reason)) toast.success("Import undone");
      await load();
    } finally { setBusy(null); }
  }

  const readingNow = Boolean(run && run.phase !== "ready");
  /* R-1760: an import begun on this run (this window, or an earlier one that stopped). */
  const halfDone = Boolean(run?.import_stage && run.import_stage !== "done");
  const importNow: ImportProgress | null = progress
    ?? (halfDone && run ? {
      run_id: run.id, stage: run.import_stage ?? "customers", offset: run.import_offset ?? 0,
      totals: run.import_totals ?? { customers: 0, subscriptions: 0, invoices: 0 }, done: false, result: null,
    } : null);
  const undoing = Boolean(run?.undo_started_at);
  const result = lastImport && !lastImport.undone_at ? lastImport.result : null;
  const pct = run?.phase === "details" && run.details_total > 0
    ? Math.round((run.details_done / run.details_total) * 100)
    : run?.phase === "ready" ? 100 : null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (busy !== "import") onOpenChange(v); }}>
      <DialogContent className="md:!max-w-2xl overflow-x-hidden" data-testid="zoho-import-dialog">
        <DialogHeader className="min-w-0">
          <DialogTitle className="inline-flex items-center gap-2"><Icon name="book" size={18} className="text-amber" />Import from Zoho Books</DialogTitle>
          <DialogDescription className="break-words">
            From <b>{orgName}</b>: customers, live subscriptions and open invoices. Read-only — nothing in Zoho is changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 min-w-0">
          {result && (
            <div className="rounded-lg border border-hairline bg-paper-2/40 p-3 text-sm" data-testid="zoho-last-import">
              <p className="font-medium text-ink">
                Last import {lastImport?.imported_at ? formatDate(lastImport.imported_at) : ""}: {fmt(n(result.customers_created))} customers,{" "}
                {fmt(n(result.subscriptions_created))} subscriptions, {fmt(n(result.invoices_imported))} open invoices
              </p>
              <p className="mt-0.5 text-xs text-ink-3">
                Batch <span className="font-mono">{lastImport!.id.slice(0, 8)}</span> · {fmt(n(result.customers_existing))} customers were already here and were not changed
              </p>
              <Button className="mt-2" variant="ghost" size="sm" onClick={undo} loading={busy === "undo"} disabled={busy !== null || readingNow}>
                Undo import
              </Button>
            </div>
          )}

          {!loaded && <p className="text-sm text-ink-3">Checking…</p>}

          {loaded && !run && (
            <div className="space-y-3 text-sm text-ink-2">
              <p>The dry run reads your Zoho Books and shows what would come in, with any problems. Nothing is imported until you press Import.</p>
              <ul className="list-disc pl-5 space-y-1 text-xs text-ink-3">
                <li>Customers: Zoho customer contacts. One whose GSTIN or exact name is already here is matched, never changed.</li>
                <li>Subscriptions: from invoice lines with “Domain Name” and “Subscription Period”; the latest line per domain and plan, live when its period has not ended.</li>
                <li>Open invoices: Zoho invoices with a balance due, as opening balances (not GST, not revenue).</li>
              </ul>
              <div>
                <label htmlFor="zoho-months" className="mb-1 block text-xs font-medium text-ink-3">Read subscriptions from invoices of the last</label>
                <select id="zoho-months" value={months} onChange={(e) => setMonths(Number(e.target.value))}
                  className="rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink">
                  <option value={12}>12 months</option>
                  <option value={24}>24 months</option>
                  <option value={36}>36 months</option>
                </select>
              </div>
              <p className="text-xs text-ink-3">Zoho allows about 100 requests a minute, so a large account takes a while (about 1 minute per 85 invoices). You can close this window — the dry run continues where it stopped.</p>
            </div>
          )}

          {run && (
            <div className="space-y-2">
              <p className="text-sm text-ink" aria-live="polite">{phaseText(run)}</p>
              {pct !== null && (
                <div className="h-2 w-full overflow-hidden rounded bg-paper-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Dry run progress">
                  <div className="h-full bg-amber transition-all" style={{ width: `${pct}%` }} />
                </div>
              )}
              <p className="text-xs text-ink-3">
                Subscriptions are read from invoices dated on or after {formatDate(run.since)} (last {run.months} months). Older terms still running are not seen.
              </p>
              {waitUntil && <p className="text-xs text-amber-ink">Zoho asked us to slow down — continuing in a minute.</p>}
            </div>
          )}

          {importNow && (
            <div className="space-y-2" data-testid="zoho-import-progress">
              <p className="text-sm font-medium text-ink" aria-live="polite">
                {undoing ? "Undo of this import stopped part way." : importProgressText(importNow)}
              </p>
              {!undoing && (
                <div className="h-2 w-full overflow-hidden rounded bg-paper-2" role="progressbar" aria-valuenow={importPercent(importNow)} aria-valuemin={0} aria-valuemax={100} aria-label="Import progress">
                  <div className="h-full bg-amber transition-all" style={{ width: `${importPercent(importNow)}%` }} />
                </div>
              )}
              <p className="text-xs text-ink-3">
                {busy === "import"
                  ? "Imported in parts. Keep this window open until it finishes."
                  : undoing
                    ? "Press Undo import to finish removing what this import created."
                    : "Stopped part way. What was imported so far is kept — Continue import picks up where it stopped."}
              </p>
            </div>
          )}

          {error && <p className="text-sm text-rose" role="alert">{error}</p>}

          {summary && run?.phase === "ready" && !importNow && (
            <div className="space-y-3" data-testid="zoho-dry-run">
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-hairline p-3">
                  <dt className="text-xs text-ink-3">New customers</dt>
                  <dd className="text-lg font-semibold tabular-nums text-ink">{fmt(summary.counts.customersNew)}</dd>
                  <dd className="text-2xs text-ink-3">{fmt(summary.counts.customersExisting)} already here</dd>
                </div>
                <div className="rounded-lg border border-hairline p-3">
                  <dt className="text-xs text-ink-3">Live subscriptions</dt>
                  <dd className="text-lg font-semibold tabular-nums text-ink">{fmt(summary.counts.subscriptionsToImport)}</dd>
                  <dd className="text-2xs text-ink-3">MRR {rupee(summary.totals.mrr)} · {fmt(summary.counts.subscriptionsAlready)} already here</dd>
                </div>
                <div className="rounded-lg border border-hairline p-3">
                  <dt className="text-xs text-ink-3">Open invoices</dt>
                  <dd className="text-lg font-semibold tabular-nums text-ink">{fmt(summary.counts.invoicesToImport)}</dd>
                  <dd className="text-2xs text-ink-3">{rupee(summary.totals.openBalance)} due · {fmt(summary.counts.invoicesAlready)} already here</dd>
                </div>
              </dl>
              {summary.problems.length === 0
                ? <p className="text-xs text-ink-3">No problems found.</p>
                : (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-ink-2">Problems</p>
                    {summary.problems.map((g) => (
                      <details key={g.code} className="rounded-md border border-hairline px-3 py-2 text-xs">
                        <summary className="cursor-pointer text-ink">
                          <span className={g.blocks ? "text-rose" : "text-amber-ink"}>{fmt(g.count)}</span> · {g.label}
                        </summary>
                        <ul className="mt-1 space-y-0.5 text-ink-3 break-words">
                          {g.examples.map((m, i) => <li key={i}>{m}</li>)}
                          {g.count > g.examples.length && <li>…and {fmt(g.count - g.examples.length)} more</li>}
                        </ul>
                      </details>
                    ))}
                  </div>
                )}
            </div>
          )}
        </div>

        <DialogFooter>
          {run && !importNow && (
            <Button variant="ghost" onClick={startDryRun} disabled={busy !== null}>
              {run.phase === "ready" ? "Read again" : "Start again"}
            </Button>
          )}
          {importNow && busy === "import" && (
            <Button variant="primary" loading disabled>Importing…</Button>
          )}
          {importNow && busy !== "import" && !undoing && (
            <>
              <Button variant="ghost" onClick={undoHalfDone} loading={busy === "undo"} disabled={busy !== null}>Undo import</Button>
              <Button variant="primary" onClick={() => void runImport()} disabled={busy !== null}>Continue import</Button>
            </>
          )}
          {importNow && busy !== "import" && undoing && (
            <Button variant="primary" onClick={undoHalfDone} loading={busy === "undo"} disabled={busy !== null}>Undo import</Button>
          )}
          {!run && (
            <Button variant="primary" onClick={startDryRun} loading={busy === "start"} disabled={!loaded || busy !== null}>Dry run</Button>
          )}
          {run && run.phase !== "ready" && !reading && (
            <Button variant="primary" onClick={() => { setError(null); setReading(true); }}>Continue</Button>
          )}
          {run && run.phase !== "ready" && reading && (
            <Button variant="primary" loading disabled>Reading Zoho…</Button>
          )}
          {run?.phase === "ready" && !importNow && (
            <Button variant="primary" onClick={doImport} loading={busy === "import" || busy === "dry"}
              disabled={!summary || busy !== null || (summary.counts.customersNew + summary.counts.subscriptionsToImport + summary.counts.invoicesToImport) === 0}>
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
