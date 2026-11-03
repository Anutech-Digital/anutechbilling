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
import { usePayerMemory, useSetBankLinePayer } from "@/lib/queries/customer-payers";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import type { PayForResult } from "@/lib/banking/credit-pay-for";
import { useNewSaleFromBankCredit, usePayItemFromBankCredit } from "@/lib/queries/bank-credit-pay-for";
import { istToday } from "@/lib/dates/ist";
import { useGstRegistration } from "@/lib/compliance/gst-registration-query";
import { billOfSupplyStatus } from "@/lib/quotes/bill-of-supply";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { subscriptionOpenHref } from "@/app/(app)/subscriptions/open-link";
import {
  BULK_PAGE, planAll, type BulkMatchRow, type PlanContext, type PlanRow,
} from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import { expectedPageCost, paceWaitMs, ZOHO_BUSY_WAIT_MS, type PaceEntry } from "@/lib/integrations/zoho-books/zoho-pace";
import { bookRows, newSaleFxArgs, payOpeningInvoice, type BookDeps, type BookedRow, type BookRun, type NewCustomerPayload, type SubForFix } from "./zoho-bulk-book";
import { ZohoBulkTable } from "./zoho-bulk-table";

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
  const createCustomer = useCreateCustomer();
  const setLinePayer = useSetBankLinePayer();
  const newSale = useNewSaleFromBankCredit();
  const payItem = usePayItemFromBankCredit();
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
    if (!customers || !subscriptions || !catalog) return null;
    return {
      customers, subscriptions, catalog: catalog.filter((i) => i.is_active),
      payers: memory.payers, ownNames: memory.ownNames, noGst: Boolean(billOfSupplyStatus(gst.data?.saved ?? null)),
      today: istToday(),
    };
  }, [customers, subscriptions, catalog, memory.payers, memory.ownNames, gst.data]);

  const plan: PlanRow[] = React.useMemo(() => {
    if (!ctx) return [];
    /* R-2419: the whole run at once — one new subscription per customer + domain + product. */
    return planAll(matches, ctx);
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

  /* ── 2. Book the ticked rows ───────────────────────────────────────────────────────── */
  const deps: BookDeps = React.useMemo(() => ({
    isReconciled: async (txnId) => {
      const { data, error } = await createClient().from("bank_transactions").select("matched_to_type").eq("id", txnId).maybeSingle();
      if (error) throw new Error(`Could not check the bank line before booking: ${error.message}`);
      if (!data) throw new Error("This bank line is no longer in the account (a statement re-import may have replaced it). Reload the page.");
      return (data as { matched_to_type: string | null }).matched_to_type !== null;
    },
    createCustomer: async (p: NewCustomerPayload) => {
      const created = await createCustomer.mutateAsync(p as Parameters<typeof createCustomer.mutateAsync>[0]);
      if (!created?.id) throw new Error(`${p.name} was not created — the database gave no id. Nothing was booked for this line.`);
      return created.id;
    },
    setPayer: (a) => setLinePayer.mutateAsync(a),
    newSale: (i) => newSale.mutateAsync(i),
    payItem: (i) => payItem.mutateAsync(i),
    /* R-2425: an export receipt — one atomic call books the sale and stamps its currency + rate. */
    newSaleFx: async (i, fx) => {
      const { data, error } = await (createClient() as unknown as { rpc: (f: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> })
        .rpc("reconcile_bank_credit_new_sale_fx", newSaleFxArgs(i, fx));
      if (error) throw error;   // the PostgREST error itself — describeError maps its code
      if (!data) throw new Error("The sale was not confirmed — refresh the page to see whether it was saved.");
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["bank_credit_open_items"] });
      invalidateReceivables(qc);
      return data as PayForResult;
    },
    payOpening: (i) => payOpeningInvoice(i, accountId, (fn, args) => (createClient() as unknown as { rpc: (f: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }> }).rpc(fn, args)),
    saleSubscriptions: async (quoteId) => {
      const { data, error } = await createClient().from("subscriptions")
        .select("id, plan, seats, domain, start_date, renewal_date").eq("quote_id", quoteId);
      if (error) throw new Error(error.message);
      return (data ?? []) as SubForFix[];
    },
    setSubDates: async (subId, start, renewal) => {
      const { error } = await createClient().from("subscriptions").update({ start_date: start, renewal_date: renewal }).eq("id", subId);
      if (error) throw new Error(error.message);
    },
  }), [createCustomer, setLinePayer, newSale, payItem, accountId, qc]);

  const book = async () => {
    setPhase("booking"); setFailure(null); setLastRun(null);
    const queue = plan.filter((r) => ticked.has(r.txnId) && !booked.has(r.txnId));
    setBookProgress({ at: 0, of: queue.length });
    const run = await bookRows(plan, ticked, new Set(booked.keys()), deps, (r, i, total) => {
      setBooked((b) => new Map(b).set(r.txnId, r));
      setBookProgress({ at: i + 1, of: total });
      persist({ booked: [...new Set([...(loadProgress(accountId)?.booked ?? []), r.txnId])] });
    });
    setLastRun(run);
    setPhase("idle");
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

        <div className="flex items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <span className="text-xs text-ink-2">
            {phase === "booking" && bookProgress
              ? `Booking ${Math.min(bookProgress.at + 1, bookProgress.of)} of ${bookProgress.of}…`
              : `${toBook.length} ticked · ${rupee(bookTotal)}`}
          </span>
          <span className="flex gap-2">
            {(results.length > 0 || plan.length > 0) && <Button variant="default" icon="download" onClick={exportCsv}>Download CSV</Button>}
            <Button
              variant="primary"
              disabled={toBook.length === 0 || reading || phase === "booking" || ctx === null}
              loading={phase === "booking"}
              onClick={() => void book()}
            >
              {`Book selected (${toBook.length})`}
            </Button>
          </span>
        </div>
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
