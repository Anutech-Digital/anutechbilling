/**
 * R-2402 — "Reconcile from Zoho" (bulk) on a bank account page. Owner / accountant only.
 *
 * Pardeep (3 Nov): HDFC 4523 had ~199 open money-in lines; one by one it is 5–8 minutes a line.
 * Here: (1) every unmatched money-in line is looked up in Zoho Books — 8 lines a request, paced
 * under Zoho's limit (zoho-pace.ts), with a progress bar; it can be paused and continued (the
 * progress is kept in this browser tab); (2) a table shows the plan per line (zoho-bulk-table.tsx;
 * rules in lib/integrations/zoho-books/bulk-reconcile-plan.ts) — rows with a problem start unticked
 * and say why; (3) "Book selected" books the ticked rows one at a time through the Reconcile
 * sheet's own path (zoho-bulk-book.ts), stops on the first error, never books a line twice;
 * (4) the result links each quote, invoice and subscription, with a CSV of what was booked and what
 * still needs a person.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";

import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { createClient } from "@/lib/supabase/client";
import { useCustomers, useCreateCustomer } from "@/lib/queries/customers";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { useItems } from "@/lib/queries/items";
import { usePayerMemory } from "@/lib/queries/customer-payers";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import { istToday } from "@/lib/dates/ist";
import { useGstRegistration } from "@/lib/compliance/gst-registration-query";
import { billOfSupplyStatus } from "@/lib/quotes/bill-of-supply";
import { useTenantLuts } from "@/lib/queries/tenant-luts";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { subscriptionOpenHref } from "@/app/(app)/subscriptions/open-link";
import {
  BULK_PAGE, newCustomerKey, rowsToBook, type BulkMatchRow, type PlanContext, type PlanRow,
} from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import { bookOnServer, isCleanPair, previewCounts, type RefusedRow } from "@/lib/integrations/zoho-books/bulk-book-run";
import { planAllWithZohoSales } from "@/lib/integrations/zoho-books/bulk-zoho-sales";
import { expectedPageCost, paceWaitMs, ZOHO_BUSY_WAIT_MS, type PaceEntry } from "@/lib/integrations/zoho-books/zoho-pace";
import { newCustomerPayload, type BookedRow, type BookRun } from "./zoho-bulk-book";
import { ZohoBulkTable } from "./zoho-bulk-table";
import { ZohoBulkRunBar, ZohoRefusedList, type BookMode } from "./zoho-bulk-run-bar";

export const ZOHO_BULK_URL = "/api/integrations/zoho-books/bulk-match";

type Next = { label: string; href?: string };
type Failure = { error: string; why: string; next: Next };

/** What is kept in this browser tab so a closed sheet (or Zoho busy) continues where it stopped. */
interface Progress { ids: string[]; cursor: number; matches: BulkMatchRow[]; booked: string[] }
/* R-2419: v2 — a run read before the double-booking checks (no facts) is not picked up again. */
const storeKey = (accountId: string) => `ros_zoho_bulk_v2:${accountId}`;
function loadProgress(accountId: string): Progress | null {
  try {
    const raw = window.sessionStorage.getItem(storeKey(accountId));
    const p = raw ? (JSON.parse(raw) as Progress) : null;
    return p && Array.isArray(p.ids) && Array.isArray(p.matches) ? { ...p, booked: Array.isArray(p.booked) ? p.booked : [] } : null;
  } catch { return null; }
}
function saveProgress(accountId: string, p: Progress | null) {
  try {
    if (p) window.sessionStorage.setItem(storeKey(accountId), JSON.stringify(p));
    else window.sessionStorage.removeItem(storeKey(accountId));
  } catch { /* private window — the run still works, it just cannot be continued after a reload */ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(body: unknown): Promise<{ ok: true; [k: string]: unknown } | ({ ok: false } & Failure)> {
  try {
    const res = await fetch(ZOHO_BULK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as ({ ok: boolean } & Partial<Failure> & Record<string, unknown>) | null;
    if (!json) return { ok: false, error: "The server did not answer.", why: `HTTP ${res.status}.`, next: { label: "Press Continue to try again" } };
    if (!json.ok) return { ok: false, error: json.error ?? "Could not read from Zoho Books.", why: json.why ?? "", next: json.next ?? { label: "Press Continue to try again" } };
    return json as { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the server.", why: "The internet connection dropped.", next: { label: "Press Continue to try again" } };
  }
}

interface Props { accountId: string; accountName: string; open: boolean; onOpenChange: (o: boolean) => void }

export function ZohoBulkReconcile({ accountId, accountName, open, onOpenChange }: Props) {
  const { data: customers } = useCustomers({ enabled: open });
  const { data: subscriptions } = useSubscriptions();
  const { data: catalog } = useItems();
  const memory = usePayerMemory();
  const gst = useGstRegistration();
  /* R-2440 / R-2444: the company's LUTs per FY (Settings → Company → LUT) — an export receipt is booked
     at 0% only under the LUT of its own FY. Not loaded yet → no plan (never "covered by default");
     loaded with none for that FY → the export row is unticked with the step. */
  const luts = useTenantLuts(open);
  const lutRows = luts.data;
  const lutError = luts.isError;
  const createCustomer = useCreateCustomer();
  const qc = useQueryClient();

  const [ids, setIds] = React.useState<string[] | null>(null);
  const [cursor, setCursor] = React.useState(0);
  const [matches, setMatches] = React.useState<BulkMatchRow[]>([]);
  const [booked, setBooked] = React.useState<Map<string, BookedRow>>(new Map());
  const [overrides, setOverrides] = React.useState<Map<string, boolean>>(new Map());
  const [phase, setPhase] = React.useState<"idle" | "reading" | "waiting" | "paused" | "booking">("idle");
  const [waitSec, setWaitSec] = React.useState(0);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const [lastRun, setLastRun] = React.useState<BookRun | null>(null);
  const [bookProgress, setBookProgress] = React.useState<{ at: number; of: number } | null>(null);
  /* R-2535: the server run — its id, the lines it booked (still booked), the lines it refused. */
  const [runId, setRunId] = React.useState<string | null>(null);
  const [runLines, setRunLines] = React.useState<Set<string>>(new Set());
  const [refused, setRefused] = React.useState<RefusedRow[]>([]);
  const [undoing, setUndoing] = React.useState(false);
  const [undoNote, setUndoNote] = React.useState<string | null>(null);
  const stopRef = React.useRef(false);
  const history = React.useRef<PaceEntry[]>([]);

  /* Pick up a run this tab already started for this account. */
  React.useEffect(() => {
    if (!open) return;
    const p = loadProgress(accountId);
    if (p) {
      setIds(p.ids); setCursor(p.cursor); setMatches(p.matches);
      setBooked((b) => { const n = new Map(b); for (const id of p.booked) if (!n.has(id)) n.set(id, { txnId: id, txnDate: "", credit: 0, outcome: "skipped", customerName: "", customerCreated: false, quoteId: null, invoiceId: null, subscriptions: [], todo: [], text: "Booked earlier in this run." }); return n; });
      setPhase("paused");
    }
  }, [open, accountId]);

  const ctx: PlanContext | null = React.useMemo(() => {
    /* A failed LUT read → planned as "no LUT" (fail closed: export rows unticked, never "covered by
       default"); reopening the sheet reads again. */
    if (!customers || !subscriptions || !catalog || (!lutRows && !lutError)) return null;
    return {
      customers, subscriptions, catalog: catalog.filter((i) => i.is_active),
      payers: memory.payers, ownNames: memory.ownNames, noGst: Boolean(billOfSupplyStatus(gst.data?.saved ?? null)),
      today: istToday(),
      lut: lutRows ?? [],
    };
  }, [customers, subscriptions, catalog, memory.payers, memory.ownNames, gst.data, lutRows, lutError]);

  const plan: PlanRow[] = React.useMemo(() => {
    if (!ctx) return [];
    /* R-2419: the whole run at once — one new subscription per customer + domain + product. */
    return planAllWithZohoSales(matches, ctx);   // R-2518: one sale per Zoho invoice
  }, [matches, ctx]);

  const ticked = React.useMemo(() => {
    const s = new Set<string>();
    for (const r of plan) {
      const o = overrides.get(r.txnId);
      if (r.book && (o ?? r.ticked)) s.add(r.txnId);
    }
    return s;
  }, [plan, overrides]);

  const persist = React.useCallback((p: Partial<Progress>) => {
    const cur = loadProgress(accountId) ?? { ids: ids ?? [], cursor, matches, booked: [...booked.keys()] };
    saveProgress(accountId, { ...cur, ...p });
  }, [accountId, ids, cursor, matches, booked]);

  /* ── 1. Look every line up in Zoho, paced ─────────────────────────────────────────── */
  const read = async (fresh: boolean) => {
    stopRef.current = false;
    setFailure(null);
    setPhase("reading");
    let list = fresh ? null : ids;
    let at = fresh ? 0 : cursor;
    let found = fresh ? [] : matches;
    if (!list) {
      const r = await post({ accountId });
      if (!r.ok) { setFailure(r); setPhase("paused"); return; }
      list = (r.ids as string[]) ?? [];
      at = 0; found = [];
      setIds(list); setCursor(0); setMatches([]); setOverrides(new Map()); setBooked(new Map()); setLastRun(null);
      saveProgress(accountId, { ids: list, cursor: 0, matches: [], booked: [] });
    }
    while (at < list.length) {
      if (stopRef.current) { setPhase("paused"); return; }
      const wait = paceWaitMs(history.current, Date.now(), expectedPageCost(history.current));
      if (wait > 0) {
        setPhase("waiting"); setWaitSec(Math.ceil(wait / 1000));
        await sleep(wait);
        setPhase("reading");
        if (stopRef.current) { setPhase("paused"); return; }
      }
      const page = list.slice(at, at + BULK_PAGE);
      const r = await post({ accountId, txnIds: page });
      if (!r.ok) { setFailure(r); setPhase("paused"); return; }
      const rows = (r.rows as BulkMatchRow[]) ?? [];
      const skipped = (r.skipped as string[]) ?? [];
      history.current.push({ at: Date.now(), calls: Number(r.zohoCalls) || 0 });
      found = [...found, ...rows];
      const doneIds = new Set([...rows.map((x) => x.line.id), ...skipped]);
      /* Zoho busy part way: keep what was read, carry on with the rest of this page after a minute. */
      let advance = page.length;
      if (r.stopped) {
        advance = 0;
        while (advance < page.length && doneIds.has(page[advance])) advance++;
      }
      at += advance;
      setMatches(found); setCursor(at);
      saveProgress(accountId, { ids: list, cursor: at, matches: found, booked: [...booked.keys()] });
      if (r.stopped) {
        history.current.push({ at: Date.now(), calls: 1000 });
        setPhase("waiting"); setWaitSec(Math.ceil(ZOHO_BUSY_WAIT_MS / 1000));
        await sleep(ZOHO_BUSY_WAIT_MS);
        history.current = history.current.filter((h) => h.calls < 1000);
        setPhase("reading");
      }
    }
    setPhase("idle");
  };

  /* ── 2. Book (R-2535: on the server, in runs — the page refreshes ONCE at the end) ───── */
  const clean = React.useMemo(() => new Set(plan.filter(isCleanPair).map((r) => r.txnId)), [plan]);
  const book = async (mode: BookMode) => {
    setPhase("booking"); setFailure(null); setLastRun(null); setRefused([]); setUndoNote(null);
    const queue = rowsToBook(plan, mode === "clean" ? clean : ticked, new Set(booked.keys()));
    setBookProgress({ at: 0, of: queue.length });
    /* Zoho's customers the app does not have: made first, through the customer form's own path (its
       contact person) — once per company in this run. The server then books against them. */
    const made = new Map<string, string>();
    const createdFor = new Set<string>();
    const rows: PlanRow[] = [];
    for (const r of queue) {
      const c = r.customer;
      if (!c || c.kind === "existing") { rows.push(r); continue; }
      const key = newCustomerKey(c);
      try {
        let id = made.get(key);
        if (!id) {
          const created = await createCustomer.mutateAsync(newCustomerPayload(c) as Parameters<typeof createCustomer.mutateAsync>[0]);
          if (!created?.id) throw new Error(`${c.name} was not created — the database gave no id. Nothing was booked for this line.`);
          id = created.id;
          made.set(key, id);
          createdFor.add(r.txnId);
        }
        rows.push({ ...r, customer: { kind: "existing", id, name: c.name, by: "name" } });
      } catch (e) {
        setLastRun({ done: [], error: { txnId: r.txnId, txnDate: r.txnDate, credit: r.credit, reason: e instanceof Error ? e.message : String(e) } });
        setPhase("idle");
        return;
      }
    }
    const res = await bookOnServer(accountId, rows, null, fetch, (at, of) => setBookProgress({ at, of }));
    const done = res.done.map((d) => (createdFor.has(d.txnId) ? { ...d, customerCreated: true } : d));
    setBooked((b) => { const n = new Map(b); for (const d of done) n.set(d.txnId, d); return n; });
    persist({ booked: [...new Set([...(loadProgress(accountId)?.booked ?? []), ...done.map((d) => d.txnId)])] });
    if (res.runId) setRunId(res.runId);
    setRunLines((s) => new Set([...s, ...done.filter((d) => d.outcome === "booked").map((d) => d.txnId)]));
    setRefused(res.refused);
    setLastRun({ done, error: res.error });
    refreshOnce();
    setPhase("idle");
  };

  /* One refresh for the whole run (R-2524's reads are cheap; never one per row). */
  const refreshOnce = () => {
    qc.invalidateQueries({ queryKey: ["bank_transactions"] });
    qc.invalidateQueries({ queryKey: ["bank_credit_open_items"] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["customers"] });
    invalidateReceivables(qc);
  };

  /* ── 3. Undo this run (undo_bank_recon_run: each new sale reversed through the sheet's own un-reconcile) ── */
  const undo = async () => {
    if (!runId) return;
    setUndoing(true); setUndoNote(null);
    const { data, error } = await (createClient() as unknown as { rpc: (f: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> })
      .rpc("undo_bank_recon_run", { p_run_id: runId });
    setUndoing(false);
    if (error) { setUndoNote(`Nothing was undone: ${error.message}`); return; }
    const out = (data ?? {}) as { undone?: number; left?: Array<{ txn_id: string; reason: string }> };
    const left = new Set((out.left ?? []).map((l) => l.txn_id));
    const gone = [...runLines].filter((id) => !left.has(id));
    setBooked((b) => { const n = new Map(b); for (const id of gone) n.delete(id); return n; });
    persist({ booked: (loadProgress(accountId)?.booked ?? []).filter((id) => !gone.includes(id)) });
    setRunLines(new Set(left));
    setUndoNote(`Undone: ${out.undone ?? 0} ${out.undone === 1 ? "line" : "lines"} back to unmatched.${left.size ? ` ${left.size} left as they are — ${(out.left ?? []).map((l) => l.reason).filter((v, i, a) => a.indexOf(v) === i).join(" ")}` : ""}`);
    refreshOnce();
  };

  const exportCsv = () => {
    const rows = [...booked.values()].filter((b) => b.txnDate).map((b) => [
      b.txnDate, b.credit, b.customerName, b.outcome, b.quoteId ?? "", b.invoiceId ?? "",
      b.subscriptions.map((s) => s.plan ?? s.id).join("; "), b.todo.join(" | "),
    ]);
    const waiting = plan.filter((r) => !booked.has(r.txnId)).map((r) => [
      r.txnDate, r.credit, r.customer?.name ?? "", "not booked", "", "", "", [...r.problems, ...r.notes].join(" | "),
    ]);
    downloadCSV(`reconcile-from-zoho-${accountName.replace(/[^A-Za-z0-9]+/g, "-")}.csv`,
      ["Date", "Amount", "Customer", "Result", "Quote", "Invoice", "Subscriptions", "Needs a person"], [...rows, ...waiting]);
  };

  const total = ids?.length ?? 0;
  const pct = total ? Math.round((cursor / total) * 100) : 0;
  const reading = phase === "reading" || phase === "waiting";
  const notInZoho = Math.max(0, matches.length - plan.length);
  const toBook = plan.filter((r) => ticked.has(r.txnId) && !booked.has(r.txnId));
  const bookTotal = toBook.reduce((s, r) => s + r.credit, 0);
  const preview = previewCounts(plan, new Set(booked.keys()));
  const results = [...booked.values()].filter((b) => b.txnDate);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) stopRef.current = true; onOpenChange(o); }}>
      <SheetContent side="right" className="w-full sm:max-w-[1200px] p-0 flex flex-col overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>Reconcile from Zoho — {accountName}</SheetTitle>
          <SheetDescription>
            Each open money-in line is looked up in Zoho Books. Check the plan, untick anything you want to do by hand, then press Book selected.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {/* Progress */}
          {ids === null ? (
            <div className="rounded-md border border-hairline bg-paper p-4 space-y-2">
              <p className="text-sm text-ink">Look up every unmatched money-in line of this account in Zoho Books. Nothing is booked until you press Book selected.</p>
              <Button variant="primary" onClick={() => void read(true)} loading={reading}>Start</Button>
            </div>
          ) : (
            <div className="space-y-1.5" aria-live="polite">
              <div className="flex items-center justify-between gap-3 text-xs text-ink-2">
                <span>
                  Checked {cursor} of {total} lines · {plan.length} found in Zoho · {notInZoho} not in Zoho (left out)
                  {phase === "waiting" && ` · waiting ${waitSec}s to stay under Zoho's limit`}
                </span>
                <span className="flex gap-2">
                  {reading && <Button size="sm" variant="default" onClick={() => { stopRef.current = true; }}>Pause</Button>}
                  {!reading && phase !== "booking" && cursor < total && <Button size="sm" variant="default" onClick={() => void read(false)}>Continue ({total - cursor} left)</Button>}
                  {!reading && phase !== "booking" && <Button size="sm" variant="default" onClick={() => void read(true)}>Start again</Button>}
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-hairline" role="progressbar" aria-label="Lines checked in Zoho" aria-valuemin={0} aria-valuemax={total} aria-valuenow={cursor}>
                <div className="h-2 rounded-full bg-amber transition-all" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}

          {failure && (
            <div role="alert" className="rounded-md border border-rose/30 bg-rose-soft/40 px-3 py-2 text-xs">
              <p className="font-medium text-ink">{failure.error}</p>
              {failure.why && <p className="text-ink-2">{failure.why}</p>}
              {failure.next.href
                ? <Link className="text-indigo-ink underline" href={failure.next.href as never}>{failure.next.label}</Link>
                : <p className="text-ink-2">{failure.next.label}</p>}
            </div>
          )}

          {lastRun?.error && (
            <div role="alert" className="rounded-md border border-rose/30 bg-rose-soft/40 px-3 py-2 text-xs">
              <p className="font-medium text-ink">Stopped at the {rupee(lastRun.error.credit)} line of {formatDate(lastRun.error.txnDate)} — nothing was booked for it.</p>
              <p className="text-ink-2">{lastRun.error.reason}</p>
              <p className="text-ink-2">Fix it (or untick the row), then press Book selected again — rows already booked are skipped.</p>
            </div>
          )}

          {ctx === null && ids !== null && <p className="text-xs text-ink-3">Loading customers, subscriptions and products…</p>}

          {plan.length > 0 && (
            <ZohoBulkTable
              rows={plan}
              ticked={ticked}
              booked={booked}
              disabled={phase === "booking"}
              onToggle={(id, on) => setOverrides((o) => new Map(o).set(id, on))}
              onToggleAll={(on) => setOverrides(() => new Map(plan.filter((r) => r.book).map((r) => [r.txnId, on])))}
            />
          )}

          <ZohoRefusedList rows={refused} />
          {undoNote && <p role="status" className="rounded-md border border-hairline bg-paper-2 px-3 py-2 text-xs text-ink">{undoNote}</p>}

          {results.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-semibold text-ink">Booked in this run</p>
              <ul className="space-y-1 text-xs">
                {results.map((b) => (
                  <li key={b.txnId} className="flex flex-wrap gap-x-2">
                    <span className="text-ink">{formatDate(b.txnDate)} · {rupee(b.credit)} · {b.customerName}{b.customerCreated ? " (new customer)" : ""}</span>
                    {b.quoteId && <Link className="text-indigo-ink underline" href={`/quotes/${encodeURIComponent(b.quoteId)}` as never}>{b.quoteId}</Link>}
                    {b.invoiceId && <Link className="text-indigo-ink underline" href={invoiceHref(b.invoiceId) as never}>{b.invoiceId}</Link>}
                    {b.subscriptions.map((s) => (
                      <Link key={s.id} className="text-indigo-ink underline" href={subscriptionOpenHref({ id: s.id }) as never}>{s.plan ?? "Subscription"}</Link>
                    ))}
                    {b.todo.length > 0 && <span className="text-amber-ink">{b.todo.length} to check</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <ZohoBulkRunBar
          preview={preview}
          selected={{ count: toBook.length, total: bookTotal }}
          progress={bookProgress}
          disabled={reading || phase === "booking" || ctx === null}
          booking={phase === "booking"}
          onBook={(m) => void book(m)}
          onDownload={results.length > 0 || plan.length > 0 ? exportCsv : null}
          runId={runId}
          bookedInRun={runLines.size}
          undoing={undoing}
          onUndo={() => void undo()}
        />
      </SheetContent>
    </Sheet>
  );
}

/** R-2402: the bank page's button — opens the sheet (mounted only while open). */
export function ZohoBulkReconcileButton({ accountId, accountName, count }: { accountId: string; accountName: string; count: number }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button
        icon="link"
        variant="default"
        onClick={() => setOpen(true)}
        title="Look up every open money-in line in Zoho Books, review the plan per line, then book the ones you tick"
      >
        {`Reconcile from Zoho (${count})`}
      </Button>
      {open && <ZohoBulkReconcile accountId={accountId} accountName={accountName} open={open} onOpenChange={setOpen} />}
    </>
  );
}
