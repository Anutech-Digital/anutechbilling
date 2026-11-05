/**
 * R-2501 (G-FY2526) — Invoices → "FY 2025-26 receipts from Zoho": the year's Zoho customer payments
 * become receipts on the FY sales imported from Zoho (R-2499), with the TDS Zoho recorded (TDS
 * receivable) and any money Zoho left unapplied as the customer's advance. Where the bank line is
 * already in the app it is matched to the receipt; otherwise "Import again" matches it once the
 * statement is in. Owner / accountant only. Zoho is only read.
 *
 *   1. Read from Zoho   — the server reads the year's payments (list + each detail), paced, resumable.
 *   2. Preview          — counts, money / TDS / advance totals, which app account each Zoho deposit
 *                         account goes to (suggested, changeable), why the rest is left out.
 *   3. Check (dry run)  — the database runs the real import and rolls it back.
 *   4. Import           — in parts; each part is one batch (activity log).
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
import type { ZohoDeposit } from "@/lib/integrations/zoho-books/receipts-import/plan";
import type { ImportBatch } from "@/lib/integrations/zoho-books/fy-import/store";

const API = "/api/integrations/zoho-books/receipts-import";
const FY = "2025-26";
const READ_GAP_MS = Math.ceil((FY_CALLS_PER_REQUEST / ZOHO_CALLS_PER_MIN) * 60_000);

interface Preview {
  counts: { scanned: number; import: number; already: number; alreadyNotBanked: number; skip: number };
  totals: { cash: number; tds: number; excess: number };
  parts: number;
  deposits: ZohoDeposit[];
  accounts: { id: string; name: string }[];
  skipReasons: { reason: string; count: number }[];
  skipped: { number: string; date: string; customer: string; amount: number; reason: string | null }[];
  batches: ImportBatch[];
}
interface PartResult { imported: number; already: number; banked: number; bankLater: number; skipped: { number: string; reason: string }[] }

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fy: FY, ...body }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error ?? "Something went wrong. Try again.");
  return j as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ZohoFyReceiptsImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState<null | "read" | "preview" | "check" | "import">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [read, setRead] = React.useState<{ listed: number; detailed: number; complete: boolean } | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [accounts, setAccounts] = React.useState<Record<string, string>>({});
  const [check, setCheck] = React.useState<PartResult | null>(null);
  const [done, setDone] = React.useState<PartResult | null>(null);
  const stop = React.useRef(false);
  React.useEffect(() => { stop.current = false; return () => { stop.current = true; }; }, []);

  const loadPreview = React.useCallback(async (map: Record<string, string>) => {
    setBusy("preview"); setError(null); setCheck(null);
    try {
      const p = await call<Preview>({ action: "preview", accounts: map });
      setPreview(p);
      /* The screen's choice = what the server used (owner's pick, else its suggestion). */
      setAccounts(Object.fromEntries(p.deposits.filter((d) => d.appAccountId).map((d) => [d.zohoAccountId, d.appAccountId as string])));
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }, []);

  async function readZoho() {
    const again = !!(read?.complete || preview);
    setBusy("read"); setError(null); setPreview(null); setCheck(null); setDone(null);
    try {
      if (again) await call({ action: "restart" });
      for (;;) {
        const r = await call<{ listed: number; detailed: number; complete: boolean; busy: boolean }>({ action: "read" });
        setRead(r);
        if (r.complete || stop.current) break;
        await sleep(r.busy ? 60_000 : READ_GAP_MS);
      }
    } catch (e) { setError((e as Error).message); setBusy(null); return; }
    setBusy(null);
    await loadPreview(accounts);
  }

  async function runParts(dryRun: boolean): Promise<PartResult> {
    const sum: PartResult = { imported: 0, already: 0, banked: 0, bankLater: 0, skipped: [] };
    for (let part = 0; part < (preview?.parts ?? 0) && !stop.current; part++) {
      const r = await call<{ result: { imported: number; already: number; banked: number; bank_later: number; skipped: { number: string; reason: string }[] } }>(
        { action: "import", part, dryRun, accounts });
      sum.imported += r.result.imported; sum.already += r.result.already; sum.banked += r.result.banked; sum.bankLater += r.result.bank_later;
      sum.skipped.push(...r.result.skipped);
    }
    return sum;
  }

  async function dryRun() {
    setBusy("check"); setError(null);
    try { setCheck(await runParts(true)); } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }

  async function doImport() {
    setBusy("import"); setError(null);
    try {
      setDone(await runParts(false));
      for (const key of [["invoices"], ["payments"], ["bank"], ["balance-sheet"], ["outstanding-receivables"], ["aging"], ["tds"]]) void qc.invalidateQueries({ queryKey: key });
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
    await loadPreview(accounts);
  }

  React.useEffect(() => { if (open && !preview && !read) void loadPreview({}).catch(() => {}); }, [open, preview, read, loadPreview]);

  const toBook = (preview?.counts.import ?? 0) + (preview?.counts.alreadyNotBanked ?? 0);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>FY {FY} receipts from Zoho</DialogTitle>
          <DialogDescription>
            Zoho's customer payments for 1 Apr 2025 – 31 Mar 2026 are recorded on the FY {FY} sales from Zoho, with the
            TDS Zoho shows and any extra kept as the customer's advance. A bank line already in the app is matched; the rest
            are matched when you import again after the bank statement is in.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-3 flex-wrap">
            <Button type="button" icon="download" loading={busy === "read"} disabled={!!busy && busy !== "read"} onClick={readZoho}>
              {read?.complete || preview ? "Read from Zoho again" : "Read from Zoho"}
            </Button>
            {read && (
              <span className="text-xs text-ink-2" role="status">
                {read.complete ? `Read all ${read.listed.toLocaleString("en-IN")} payments.` : `Read ${read.detailed.toLocaleString("en-IN")} of ${read.listed.toLocaleString("en-IN")}${busy === "read" ? " — keep this open" : ""}`}
              </span>
            )}
          </div>

          {error && <p role="alert" className="text-xs text-rose-ink">{error}</p>}

          {preview && (
            <>
              <p data-testid="fy-receipts-summary">
                <b>{preview.counts.scanned.toLocaleString("en-IN")}</b> Zoho payments ·{" "}
                <b>{preview.counts.import.toLocaleString("en-IN")}</b> to record ({rupee(preview.totals.cash)} received · TDS {rupee(preview.totals.tds)} · advance {rupee(preview.totals.excess)})
                {preview.counts.already > 0 && <> · <Badge kind="muted" size="sm">{preview.counts.already} already recorded</Badge></>}
                {preview.counts.alreadyNotBanked > 0 && <> · <Badge kind="info" size="sm">{preview.counts.alreadyNotBanked} waiting for their bank line</Badge></>}
                {preview.counts.skip > 0 && <> · <Badge kind="warning" size="sm">{preview.counts.skip} left out</Badge></>}
              </p>

              {preview.deposits.length > 0 && (
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Where the money went</p>
                  <ul className="space-y-1.5">
                    {preview.deposits.map((d) => (
                      <li key={d.zohoAccountId} className="flex items-center gap-2 flex-wrap text-xs">
                        <span className="text-ink-2 min-w-48">Zoho: <b className="text-ink">{d.zohoName}</b> · {d.count} · {rupee(d.amount)}</span>
                        <label htmlFor={`acct-${d.zohoAccountId}`} className="sr-only">App account for Zoho&apos;s {d.zohoName}</label>
                        <select
                          id={`acct-${d.zohoAccountId}`}
                          value={accounts[d.zohoAccountId] ?? ""}
                          disabled={!!busy}
                          onChange={(e) => { const next = { ...accounts, [d.zohoAccountId]: e.target.value }; setAccounts(next); void loadPreview(next); }}
                          className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                        >
                          <option value="">Choose the app account…</option>
                          {preview.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                        {d.suggested && <span className="text-3xs text-ink-3">suggested</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.skipReasons.length > 0 && (
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Left out, and why</p>
                  <ul className="text-xs text-ink-2 space-y-0.5">
                    {preview.skipReasons.slice(0, 8).map((r) => <li key={r.reason}><b>{r.count}</b> · {r.reason}</li>)}
                  </ul>
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-ink-3">Show the payments left out</summary>
                    <ul className="max-h-48 overflow-y-auto mt-1 space-y-0.5">
                      {preview.skipped.map((s) => (
                        <li key={s.number + s.date}><span className="font-mono">{s.number}</span> · {formatDate(s.date)} · {s.customer} · {rupee(s.amount)} — {s.reason}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
              {check && <PartSummary title="Check result (nothing saved)" r={check} />}
              {done && <PartSummary title="Recorded" r={done} />}
              {preview.batches.length > 0 && (
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Imports</p>
                  <ul className="space-y-1.5">
                    {preview.batches.map((b) => <BatchRow key={b.id} b={b} onChanged={() => loadPreview(accounts)} />)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={!!busy} onClick={() => onOpenChange(false)}>Close</Button>
          {preview && toBook > 0 && (
            <>
              <Button type="button" loading={busy === "check"} disabled={!!busy && busy !== "check"} onClick={dryRun}>Check first (nothing saved)</Button>
              <Button type="button" variant="primary" loading={busy === "import"} disabled={!check || (!!busy && busy !== "import")} onClick={doImport}
                title={check ? undefined : "Run the check first"}>
                {preview.counts.import > 0 ? `Import ${preview.counts.import.toLocaleString("en-IN")} receipts` : "Match bank lines"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PartSummary({ title, r }: { title: string; r: PartResult }) {
  return (
    <div className="rounded-md border border-hairline px-3 py-2 text-xs" role="status">
      <p className="font-semibold text-ink">
        {title}: {r.imported.toLocaleString("en-IN")} receipts · {r.banked} matched to bank lines
        {r.bankLater ? ` · ${r.bankLater} wait for their bank line` : ""}{r.already ? ` · ${r.already} already recorded` : ""}{r.skipped.length ? ` · ${r.skipped.length} refused` : ""}
      </p>
      {r.skipped.length > 0 && (
        <ul className="mt-1 max-h-32 overflow-y-auto text-ink-2">
          {r.skipped.slice(0, 200).map((s, i) => <li key={`${s.number}-${i}`}><span className="font-mono">{s.number}</span> — {s.reason}</li>)}
        </ul>
      )}
    </div>
  );
}

/** R-2501 follow-up: one import batch, with "Remove import" (owner only — the SQL checks; refused once
 *  anything in it was used: a refund, a TDS certificate, the advance spent, a line matched by hand). */
function BatchRow({ b, onChanged }: { b: ImportBatch; onChanged: () => Promise<void> }) {
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <li className="rounded-md border border-hairline px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-ink-2">{formatDate(b.createdAt)} · {b.importedCount} payments · {rupee(b.amountTotal)} · TDS {rupee(b.taxTotal)}{b.skippedCount ? ` · ${b.skippedCount} refused` : ""}</span>
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
          <Input id={`rm-${b.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. wrong account" className="h-8 w-56" />
          <Button type="submit" size="sm" variant="danger" loading={busy} disabled={reason.trim().length < 3}>Remove {b.importedCount} receipts</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>Keep</Button>
          {err && <p role="alert" className="w-full text-rose-ink">{err}</p>}
        </form>
      )}
    </li>
  );
}
