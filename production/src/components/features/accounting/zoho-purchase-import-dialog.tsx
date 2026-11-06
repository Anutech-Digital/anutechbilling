/**
 * R-2502 (G-FY2526) — Expenses → "FY 2025-26 purchases from Zoho": the year's Zoho bills, expenses
 * and vendor payments come into the app's own expenses, COGS bills and payments — GST input credit
 * (ITC) as in Zoho, ineligible ITC kept in the cost, reverse charge, TDS by section. Owner /
 * accountant only (the route and the SQL check too). Built on R-2499's FY framework.
 *
 *   1. Read from Zoho      — bills, expenses, vendor payments (server-side, paced, resumable).
 *   2. Map Zoho accounts   — each Zoho account → an app category, saved for the company;
 *                            an unmapped one comes in as "Unmapped — review".
 *   3. Preview             — per month: Zoho vs what will come in vs already in the app (ITC, TDS).
 *   4. Check (dry run)     — the database runs the real import and rolls it back.
 *   5. Import              — bills, then expenses, then payments; each part one batch, removable.
 *      Payments make no bank line: expense bills are marked paid; payments on COGS bills are listed
 *      to pay in Banking → Reconcile on their 4523 debit (R-2502b).
 * Zoho is only read.
 */
"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatDate, rupee } from "@/lib/utils";
import { FY_CALLS_PER_REQUEST } from "@/lib/integrations/zoho-books/config";
import { ZOHO_CALLS_PER_MIN } from "@/lib/integrations/zoho-books/zoho-pace";
import type { MonthTotals, PaidThroughAccount, PaymentToReconcile } from "@/lib/integrations/zoho-books/purchase-import/plan";
import type { ImportBatch } from "@/lib/integrations/zoho-books/fy-import/store";

const API = "/api/integrations/zoho-books/purchase-import";
const FY = "2025-26";
const READ_GAP_MS = Math.ceil((FY_CALLS_PER_REQUEST / ZOHO_CALLS_PER_MIN) * 60_000);
const KINDS = [
  { kind: "bills", label: "bills" },
  { kind: "expenses", label: "expenses" },
  { kind: "vendorpayments", label: "vendor payments" },
] as const;
type Kind = (typeof KINDS)[number]["kind"];
const selectCls = "w-full rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber";

interface Preview {
  purchases: {
    counts: { scanned: number; import: number; already: number; skip: number; voidOrDraft: number; newVendors: number };
    parts: { bills: number; expenses: number };
    zohoByMonth: MonthTotals[]; importByMonth: MonthTotals[]; appByMonth: MonthTotals[];
    /** R-2502c: purchases already in the app NOT from Zoho, per month — an overlap shows before importing. */
    otherByMonth: { month: string; count: number; amount: number }[];
    accounts: PaidThroughAccount[];
    skipReasons: { reason: string; count: number }[];
    tdsBySection: { section: string; amount: number; count: number }[];
    unmapped: { accountId: string; accountName: string; count: number; taxable: number }[];
    skipped: { kind: string; number: string; date: string; vendor: string; amount: number; reason: string | null }[];
  };
  payments: null | {
    counts: { scanned: number; import: number; already: number; skip: number; advanceAmount: number; amount: number; cogsAmount: number; partsAmount: number };
    parts: number;
    accounts: PaidThroughAccount[];
    skipReasons: { reason: string; count: number }[];
    toReconcile: PaymentToReconcile[];
  };
  categories: string[];
  bankAccounts: { id: string; name: string; last4: string | null; type: string | null }[];
  batches: (ImportBatch & { kind: Kind })[];
}
interface PartResult { imported: number; already: number; skipped: { number: string; reason: string }[] }

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fy: FY, ...body }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error ?? "Something went wrong. Try again.");
  return j as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const monthLabel = (m: string) => formatDate(`${m}-01`).replace(/^\d+\s/, "");
const n = (x: number) => x.toLocaleString("en-IN");

export function ZohoPurchaseImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState<null | string>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [read, setRead] = React.useState<Partial<Record<Kind, { listed: number; detailed: number; complete: boolean }>>>({});
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [map, setMap] = React.useState<Record<string, string>>({});
  /** R-2502c: Zoho paid-through account → app account (the owner's choice; sent with preview / import). */
  const [accounts, setAccounts] = React.useState<Record<string, string>>({});
  const accountsRef = React.useRef(accounts);
  accountsRef.current = accounts;
  const [check, setCheck] = React.useState<Partial<Record<Kind, PartResult>>>({});
  const [done, setDone] = React.useState<Partial<Record<Kind, PartResult>>>({});
  const stop = React.useRef(false);
  React.useEffect(() => () => { stop.current = true; }, []);

  const loadPreview = React.useCallback(async () => {
    setBusy("preview"); setError(null);
    try { setPreview(await call<Preview>({ action: "preview", accounts: accountsRef.current })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }, []);

  async function readZoho() {
    /* "Read again" after a finished read starts over (Zoho may have changed); a read that stopped
       half-way (error, closed dialog) carries on from where the server's scan stands. */
    const again = Boolean(preview) || KINDS.every(({ kind }) => read[kind]?.complete);
    setBusy("read"); setError(null); setPreview(null); setCheck({}); setDone({});
    try {
      for (const { kind } of KINDS) {
        if (stop.current) break;
        if (again) await call({ action: "restart", kind });
        for (;;) {
          const r = await call<{ listed: number; detailed: number; complete: boolean; busy: boolean }>({ action: "read", kind });
          setRead((p) => ({ ...p, [kind]: r }));
          if (r.complete || stop.current) break;
          await sleep(r.busy ? 60_000 : READ_GAP_MS);
        }
      }
    } catch (e) { setError((e as Error).message); setBusy(null); return; }
    setBusy(null);
    await loadPreview();
  }

  async function saveMap() {
    const rows = Object.entries(map).map(([zohoAccountId, category]) => ({
      zohoAccountId, category, zohoAccountName: preview?.purchases.unmapped.find((u) => u.accountId === zohoAccountId)?.accountName ?? "",
    }));
    if (!rows.length) return;
    setBusy("map"); setError(null);
    try { await call({ action: "saveMap", rows }); setMap({}); setCheck({}); }
    catch (e) { setError((e as Error).message); setBusy(null); return; }
    setBusy(null);
    await loadPreview();
  }

  const partsOf = (k: Kind) => (k === "vendorpayments" ? preview?.payments?.parts ?? 0 : preview?.purchases.parts[k] ?? 0);
  async function runParts(kind: Kind, dryRun: boolean): Promise<PartResult> {
    const sum: PartResult = { imported: 0, already: 0, skipped: [] };
    for (let part = 0; part < partsOf(kind) && !stop.current; part++) {
      const r = await call<{ result: { imported: number; already: number; skipped: { number: string; reason: string }[] } }>(
        { action: "import", kind, part, dryRun, accounts });
      sum.imported += r.result.imported; sum.already += r.result.already; sum.skipped.push(...r.result.skipped);
    }
    return sum;
  }
  async function dryRun(kind: Kind) {
    setBusy(`check-${kind}`); setError(null);
    try { const r = await runParts(kind, true); setCheck((p) => ({ ...p, [kind]: r })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }
  async function doImport(kind: Kind) {
    setBusy(`import-${kind}`); setError(null);
    try {
      const r = await runParts(kind, false);
      setDone((p) => ({ ...p, [kind]: r }));
      for (const key of [["expenses"], ["vendor-bills"], ["vendors"], ["balance-sheet"], ["gst"], ["pnl"]]) void qc.invalidateQueries({ queryKey: key });
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
    await loadPreview();
  }

  React.useEffect(() => { if (open && !preview && Object.keys(read).length === 0) void loadPreview().catch(() => {}); }, [open, preview, read, loadPreview]);

  const p = preview?.purchases;
  const pay = preview?.payments;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>FY {FY} purchases from Zoho</DialogTitle>
          <DialogDescription>
            Zoho&apos;s bills, expenses and vendor payments for 1 Apr 2025 – 31 Mar 2026 come in as your expenses and COGS bills,
            with GST input credit as in Zoho, reverse charge and TDS. Void and draft stay out. Zoho is only read.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm max-h-[70vh] overflow-y-auto">
          <div className="flex items-center gap-3 flex-wrap">
            <Button type="button" icon="download" loading={busy === "read"} disabled={!!busy && busy !== "read"} onClick={readZoho}>
              {preview ? "Read from Zoho again" : "Read from Zoho"}
            </Button>
            {KINDS.map(({ kind, label }) => read[kind] && (
              <span key={kind} className="text-xs text-ink-2" role="status">
                {read[kind]!.complete ? `${n(read[kind]!.listed)} ${label}` : `${label}: ${n(read[kind]!.detailed)} of ${n(read[kind]!.listed)}`}
              </span>
            ))}
          </div>

          {error && <p role="alert" className="text-xs text-rose-ink">{error}</p>}

          {p && (
            <>
              <p data-testid="fy-purchases-summary">
                <b>{n(p.counts.scanned)}</b> Zoho bills + expenses · <b>{n(p.counts.import)}</b> to import
                {p.counts.newVendors > 0 && <> · {p.counts.newVendors} new vendors from Zoho</>}
                {p.counts.already > 0 && <> · <Badge kind="muted" size="sm">{p.counts.already} already in the app</Badge></>}
                {p.counts.skip > 0 && <> · <Badge kind="warning" size="sm">{p.counts.skip} left out</Badge></>}
              </p>

              {p.unmapped.length > 0 && (
                <div className="rounded-md border border-amber/50 px-3 py-2">
                  <p className="text-xs font-semibold text-ink mb-1">Map Zoho accounts to your categories ({p.unmapped.length} not mapped — they come in as &quot;Unmapped — review&quot;)</p>
                  <table className="w-full text-xs">
                    <tbody>
                      {p.unmapped.slice(0, 100).map((u) => (
                        <tr key={u.accountId} className="border-b border-hairline last:border-0">
                          <td className="py-1 pr-2 text-ink">{u.accountName || u.accountId}</td>
                          <td className="py-1 pr-2 text-right text-ink-2 tabular-nums whitespace-nowrap">{u.count} · {rupee(u.taxable)}</td>
                          <td className="py-1 w-56">
                            <label htmlFor={`map-${u.accountId}`} className="sr-only">Category for {u.accountName}</label>
                            <select id={`map-${u.accountId}`} className={selectCls} value={map[u.accountId] ?? ""}
                              onChange={(e) => setMap((m) => ({ ...m, [u.accountId]: e.target.value }))}>
                              <option value="">Unmapped — review</option>
                              {preview!.categories.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Button type="button" size="sm" className="mt-2" loading={busy === "map"} disabled={!!busy || Object.keys(map).length === 0} onClick={saveMap}>
                    Save the map
                  </Button>
                </div>
              )}

              <AccountMap list={[...p.accounts, ...(pay?.accounts ?? [])]} bankAccounts={preview!.bankAccounts} chosen={accounts}
                busy={!!busy} onChange={(k, v) => { setAccounts((m) => ({ ...m, [k]: v })); setCheck({}); }} onApply={loadPreview} />
              <MonthTable p={p} />
              {p.tdsBySection.length > 0 && (
                <p className="text-xs text-ink-2">TDS in Zoho: {p.tdsBySection.map((t) => `${t.section} ${rupee(t.amount)} (${t.count})`).join(" · ")}</p>
              )}
              <Reasons title="Left out, and why" reasons={p.skipReasons}>
                {p.skipped.map((s, i) => (
                  <li key={`${s.kind}-${s.number}-${i}`}><span className="font-mono">{s.number || "—"}</span> · {formatDate(s.date)} · {s.vendor} · {rupee(s.amount)} — {s.reason}</li>
                ))}
              </Reasons>

              {(["bills", "expenses"] as const).map((k) => partsOf(k) > 0 && (
                <StepRow key={k} label={k === "bills" ? "Bills" : "Expenses"} kind={k} busy={busy} check={check[k]} done={done[k]}
                  onCheck={() => dryRun(k)} onImport={() => doImport(k)} />
              ))}

              {pay && (
                <div className="rounded-md border border-hairline px-3 py-2 space-y-2">
                  <p className="text-xs">
                    <b>Vendor payments:</b> {n(pay.counts.scanned)} in Zoho · <b>{n(pay.counts.import)}</b> to import ({rupee(pay.counts.amount)})
                    {pay.counts.advanceAmount > 0 && <> · advances not applied to a bill {rupee(pay.counts.advanceAmount)} (book by hand)</>}
                  </p>
                  {pay.toReconcile.length > 0 && (
                    <details className="text-xs" open>
                      <summary className="cursor-pointer text-ink-2">
                        {pay.toReconcile.length} payments are not booked here — pay each in Banking → Reconcile on its own bank debit, with the TDS shown
                        (COGS bills {rupee(pay.counts.cogsAmount)}; bills Zoho paid in parts {rupee(pay.counts.partsAmount)}), so the cash is counted once
                      </summary>
                      <ul className="max-h-40 overflow-y-auto mt-1 space-y-0.5 text-ink-2" data-testid="to-reconcile">
                        {pay.toReconcile.map((c, i) => (
                          <li key={`${c.number}-${c.bill}-${i}`}>
                            {formatDate(c.date)} · {c.vendor} · bill <span className="font-mono">{c.bill}</span> · {rupee(c.amount)}
                            {c.tds > 0 ? <> · TDS {rupee(c.tds)} {c.tdsSection}</> : null}
                            <span className="text-ink-3"> · {c.why === "cogs" ? "COGS bill" : "part payment"}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <Reasons title="Payments left out" reasons={pay.skipReasons} />
                  {pay.parts > 0 && (
                    <StepRow label="Payments" kind="vendorpayments" busy={busy} check={check.vendorpayments} done={done.vendorpayments}
                      onCheck={() => dryRun("vendorpayments")} onImport={() => doImport("vendorpayments")} />
                  )}
                </div>
              )}
              {preview!.batches.length > 0 && <Batches batches={preview!.batches} onChanged={loadPreview} />}
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={!!busy} onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepRow({ label, kind, busy, check, done, onCheck, onImport }: {
  label: string; kind: Kind; busy: string | null; check?: PartResult; done?: PartResult; onCheck: () => void; onImport: () => void;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold text-ink w-24">{label}</span>
        <Button type="button" size="sm" loading={busy === `check-${kind}`} disabled={!!busy} onClick={onCheck}>Check first (nothing saved)</Button>
        <Button type="button" size="sm" variant="primary" loading={busy === `import-${kind}`} disabled={!check || !!busy} onClick={onImport}
          title={check ? undefined : "Run the check first"}>
          Import {check ? n(check.imported) : ""} {label.toLowerCase()}
        </Button>
      </div>
      {check && <PartSummary title="Check (nothing saved)" r={check} />}
      {done && <PartSummary title="Imported" r={done} />}
    </div>
  );
}

function MonthTable({ p }: { p: Preview["purchases"] }) {
  const months = [...new Set([...p.zohoByMonth, ...p.importByMonth, ...p.appByMonth, ...p.otherByMonth].map((m) => m.month))].sort();
  const get = (list: MonthTotals[], m: string) => list.find((x) => x.month === m);
  const cell = (t: MonthTotals | undefined) => (t ? <>{rupee(t.taxable)}<span className="block text-3xs text-ink-3">ITC {rupee(t.itc)} · {t.count}</span></> : "—");
  return (
    <div className="border border-hairline rounded-md overflow-x-auto max-h-72 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="bg-paper-2 border-b border-hairline sticky top-0">
          <tr>
            <th scope="col" className="p-2 text-left font-semibold text-ink-3">Month</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3">Zoho (before GST)</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3">IGST · CGST · SGST · RCM · TDS</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3">Will come in</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3">Already in the app</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3" title="Purchases in the app that did not come from Zoho — if they are the same purchases, they would count twice">In the app, not from Zoho</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => {
            const z = get(p.zohoByMonth, m);
            return (
              <tr key={m} className="border-b border-hairline last:border-0 tabular-nums">
                <td className="p-2 text-ink whitespace-nowrap">{monthLabel(m)}</td>
                <td className="p-2 text-right">{cell(z)}</td>
                <td className="p-2 text-right text-ink-2 whitespace-nowrap">{z ? `${rupee(z.igst)} · ${rupee(z.cgst)} · ${rupee(z.sgst)} · ${rupee(z.rcmTax)} · ${rupee(z.tds)}` : "—"}</td>
                <td className="p-2 text-right">{cell(get(p.importByMonth, m))}</td>
                <td className="p-2 text-right">{cell(get(p.appByMonth, m))}</td>
                <td className="p-2 text-right">{(() => { const o = p.otherByMonth.find((x) => x.month === m); return o ? <>{rupee(o.amount)}<span className="block text-3xs text-ink-3">{o.count}</span></> : "—"; })()}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Reasons({ title, reasons, children }: { title: string; reasons: { reason: string; count: number }[]; children?: React.ReactNode }) {
  if (!reasons.length) return null;
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{title}</p>
      <ul className="text-xs text-ink-2 space-y-0.5">{reasons.slice(0, 8).map((r) => <li key={r.reason}><b>{r.count}</b> · {r.reason}</li>)}</ul>
      {children && (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-ink-3">Show them</summary>
          <ul className="max-h-48 overflow-y-auto mt-1 space-y-0.5">{children}</ul>
        </details>
      )}
    </div>
  );
}

function PartSummary({ title, r }: { title: string; r: PartResult }) {
  return (
    <div className="rounded-md border border-hairline px-3 py-2 text-xs" role="status">
      <p className="font-semibold text-ink">{title}: {n(r.imported)}{r.already ? ` · ${r.already} already in the app` : ""}{r.skipped.length ? ` · ${r.skipped.length} refused` : ""}</p>
      {r.skipped.length > 0 && (
        <ul className="mt-1 max-h-32 overflow-y-auto text-ink-2">
          {r.skipped.slice(0, 200).map((s, i) => <li key={`${s.number}-${i}`}><span className="font-mono">{s.number || "—"}</span> — {s.reason}</li>)}
        </ul>
      )}
    </div>
  );
}

const KIND_LABEL: Record<Kind, string> = { bills: "bills", expenses: "expenses", vendorpayments: "payments" };

function Batches({ batches, onChanged }: { batches: (ImportBatch & { kind: Kind })[]; onChanged: () => Promise<void> }) {
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Imports</p>
      <ul className="space-y-1.5">{batches.map((b) => <BatchRow key={b.id} b={b} onChanged={onChanged} />)}</ul>
    </div>
  );
}

function BatchRow({ b, onChanged }: { b: ImportBatch & { kind: Kind }; onChanged: () => Promise<void> }) {
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <li className="rounded-md border border-hairline px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-ink-2">{formatDate(b.createdAt)} · {b.importedCount} {KIND_LABEL[b.kind]} · {rupee(b.amountTotal)}{b.skippedCount ? ` · ${b.skippedCount} refused` : ""}</span>
        {b.removedAt ? <Badge kind="muted" size="sm">Removed {formatDate(b.removedAt)}</Badge>
          : b.importedCount > 0 && !asking ? <Button type="button" size="sm" variant="ghost" icon="trash" onClick={() => setAsking(true)}>Remove import</Button> : null}
      </div>
      {asking && !b.removedAt && (
        <form className="mt-2 flex items-center gap-2 flex-wrap" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true); setErr(null);
          try { await call({ action: "undo", batchId: b.id, reason }); setAsking(false); await onChanged(); }
          catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
        }}>
          <label htmlFor={`rm-${b.id}`} className="sr-only">Why are you removing this import?</label>
          <Input id={`rm-${b.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. test batch" className="h-8 w-56" />
          <Button type="submit" size="sm" variant="danger" loading={busy} disabled={reason.trim().length < 3}>Remove {b.importedCount} {KIND_LABEL[b.kind]}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>Keep</Button>
          {err && <p role="alert" className="w-full text-rose-ink">{err}</p>}
        </form>
      )}
    </li>
  );
}

/** R-2502c: where Zoho's expenses / payments were paid from → which app account (petty cash, card, bank). */
function AccountMap({ list, bankAccounts, chosen, busy, onChange, onApply }: {
  list: PaidThroughAccount[]; bankAccounts: Preview["bankAccounts"]; chosen: Record<string, string>; busy: boolean;
  onChange: (zohoName: string, appId: string) => void; onApply: () => void;
}) {
  const merged = new Map<string, PaidThroughAccount>();
  for (const a of list) {
    const t = merged.get(a.zohoName);
    merged.set(a.zohoName, t ? { ...t, count: t.count + a.count, amount: t.amount + a.amount } : a);
  }
  if (!merged.size) return null;
  const missing = [...merged.values()].filter((a) => !(chosen[a.zohoName] || a.appAccountId)).length;
  return (
    <div className="rounded-md border border-hairline px-3 py-2">
      <p className="text-xs font-semibold text-ink mb-1">
        Paid from — which app account is each Zoho account?{missing > 0 ? ` (${missing} not chosen — their expenses and payments are left out)` : ""}
      </p>
      <table className="w-full text-xs">
        <tbody>
          {[...merged.values()].map((a) => (
            <tr key={a.zohoName} className="border-b border-hairline last:border-0">
              <td className="py-1 pr-2 text-ink">{a.zohoName}</td>
              <td className="py-1 pr-2 text-right text-ink-2 tabular-nums whitespace-nowrap">{a.count} · {rupee(a.amount)}</td>
              <td className="py-1 w-64">
                <label htmlFor={`acct-${a.zohoName}`} className="sr-only">App account for {a.zohoName}</label>
                <select id={`acct-${a.zohoName}`} className={selectCls} value={chosen[a.zohoName] ?? a.appAccountId ?? ""}
                  onChange={(e) => onChange(a.zohoName, e.target.value)}>
                  <option value="">Choose — or leave out</option>
                  {bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name}{b.last4 ? ` ··${b.last4}` : ""}{b.type === "cash" ? " (cash)" : b.type === "credit_card" ? " (card)" : ""}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button type="button" size="sm" className="mt-2" disabled={busy} onClick={onApply}>Use these accounts</Button>
    </div>
  );
}
