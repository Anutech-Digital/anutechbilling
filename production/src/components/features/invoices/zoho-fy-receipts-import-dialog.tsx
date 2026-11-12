/**
 * R-2501 (G-FY2526) — Invoices → "FY 2025-26 receipts from Zoho": the year's Zoho customer payments
 * become receipts on the FY sales imported from Zoho (R-2499), with the TDS Zoho recorded (TDS
 * receivable) and any money Zoho left unapplied as the customer's advance. Where the bank line is
 * already in the app it is matched to the receipt; otherwise "Import again" matches it once the
 * statement is in. Owner / accountant only. Zoho is only read.
 *
 *   1. Read from Zoho   — the server reads the year's payments (list + each detail), paced, resumable.
 *                         R-2607: it runs ON THE SERVER (cron zoho-fy-read + this dialog's own
 *                         pass while it is open) — the window can be closed; reopening shows where
 *                         it stands. Before, the loop lived in this tab and stopped when it froze.
 *   2. Preview          — counts, money / TDS / advance totals, which app account each Zoho deposit
 *                         account goes to (suggested, changeable, or "Leave out" — its payments are
 *                         then skipped "Left out by owner."), why the rest is left out. The import
 *                         sends exactly these choices: nothing is mapped that the screen did not show.
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
import { formatForeign } from "@/lib/currency";
import { LEAVE_OUT, skipReasonKey, type ZohoDeposit } from "@/lib/integrations/zoho-books/receipts-import/plan";
import type { ImportBatch } from "@/lib/integrations/zoho-books/fy-import/store";

const API = "/api/integrations/zoho-books/receipts-import";
const FY = "2025-26";
/** R-2607: between two server passes of the open dialog (each pass reads up to ~40 s itself). */
const STEP_GAP_MS = 5_000;
/** R-2607: the server's read — progress, whether it is still asked for, why it stopped. */
/* R-2653: onlyAccount = the last Read again was limited to this Zoho deposit account. */
interface ReadState { listed: number; detailed: number; complete: boolean; running?: boolean; error?: string | null; onlyAccount?: string | null }

/** R-2607 — the read's progress line. R-2653: `onlyName` = the read was limited to that Zoho account. */
export function readStatusText(r: ReadState, onlyName?: string | null): string {
  const n = (x: number) => x.toLocaleString("en-IN");
  const only = onlyName ? ` (Read again: only ${onlyName})` : "";
  if (r.complete) return `Read all ${n(r.listed)} payments.${only}`;
  if (r.running) {
    /* R-2653: Read again keeps what is read — while it checks Zoho's list everything listed is still read. */
    const where = !r.listed ? "Reading the list from Zoho"
      : r.detailed >= r.listed ? "Checking Zoho for new or changed payments"
        : `Read ${n(r.detailed)} of ${n(r.listed)}`;
    return `${where}${only} — on the server; you can close this window and come back.`;
  }
  return r.listed ? `Read ${n(r.detailed)} of ${n(r.listed)} — stopped.` : "Not read yet.";
}

/** R-2653 — the "Read again" choice: all accounts, or only the payments deposited to one Zoho account. */
export const ALL_ACCOUNTS = "";

interface Preview {
  /* R-2565: withFee / fee — Razorpay payments whose fee Zoho took off (optional: an older server sends none). */
  counts: { scanned: number; import: number; already: number; alreadyNotBanked: number; skip: number; withFee?: number };
  totals: { cash: number; tds: number; excess: number; fee?: number };
  parts: number;
  deposits: ZohoDeposit[];
  accounts: { id: string; name: string }[];
  skipReasons: { reason: string; count: number }[];
  /* R-2693: amount = ₹ (null = not known, a foreign payment read before R-2693); currency / foreignAmount
     for a foreign-currency payment (optional: an older server sends none). skippedMore = not listed. */
  skipped: LeftOutRow[];
  skippedMore?: number;
  batches: ImportBatch[];
  canRemove: boolean;
}
interface LeftOutRow { number: string; date: string; customer: string; amount: number | null; currency?: string | null; foreignAmount?: number | null; reason: string | null }

/** R-2693 — a left-out payment's money: a foreign-currency one in its own currency (+ the ₹ at Zoho's
 *  rate when known), never its dollars shown as rupees. */
export function leftOutMoney(s: Pick<LeftOutRow, "amount" | "currency" | "foreignAmount">): string {
  if (s.currency && s.currency !== "INR" && s.foreignAmount !== null && s.foreignAmount !== undefined) {
    return `${formatForeign(s.foreignAmount, s.currency)}${s.amount ? ` (${rupee(s.amount)})` : ""}`;
  }
  return s.amount === null ? "—" : rupee(s.amount);
}

/**
 * R-2693 — the check's sum line: every scanned Zoho payment is in exactly one bucket — to record,
 * already recorded, refused by the check (the database's own reasons) or left out before the check
 * (the preview's reasons). When the buckets do not make the scanned count, it says so — never hidden.
 */
export function accountedText(scanned: number, leftOut: number, r: Pick<PartResult, "imported" | "already" | "skipped">): string {
  const n = (x: number) => x.toLocaleString("en-IN");
  const refused = r.skipped.length;
  const sum = r.imported + r.already + refused + leftOut;
  const parts = `${n(r.imported)} to record · ${n(r.already)} already recorded · ${n(refused)} refused by the check · ${n(leftOut)} left out before the check`;
  return sum === scanned
    ? `All ${n(scanned)} Zoho payments accounted for: ${parts} (reasons above).`
    : `${n(scanned)} Zoho payments read, but the numbers do not add up (${parts} = ${n(sum)}) — press Check first again; if it stays, tell support.`;
}

/** R-2693 — the check's refusals by kind (same grouping as "Left out, and why"), most first. */
export function refusalGroups(skipped: readonly { reason: string }[]): { reason: string; count: number }[] {
  const by = new Map<string, number>();
  for (const s of skipped) { const k = skipReasonKey(s.reason ?? ""); by.set(k, (by.get(k) ?? 0) + 1); }
  return [...by.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

/** R-2565: withFee / fee = Razorpay payments booked with their fee as Bank Charges (they wait for their Razorpay settlement line). */
interface PartResult { imported: number; already: number; banked: number; bankLater: number; withFee: number; fee: number; skipped: { number: string; reason: string }[] }

/** R-2565 — the Razorpay fee line for the summary / check result: shown apart, never taken off the receipts. */
export function razorpayFeeText(count: number, fee: number): string | null {
  if (!count || !fee) return null;
  return `${count.toLocaleString("en-IN")} Razorpay payment${count === 1 ? "" : "s"} · fee ${rupee(fee)} booked as Bank Charges (receipts stay the full amount; banked by their Razorpay settlement)`;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fy: FY, ...body }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error ?? "Something went wrong. Try again.");
  return j as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** R-2547 — the Import button's label once a part failed: carry on from that part (1-based). */
export const carryOnLabel = (part: number) => `Carry on from part ${part + 1}`;

/**
 * R-2547 — what the owner reads when part `part` (0-based) of `parts` fails: which part, why (the
 * database's statement time limit in plain words), what the parts before it saved (`saved`; null =
 * the check, which saves nothing) and how to carry on — payments already recorded count as already.
 */
export function partFailedMessage(part: number, parts: number, reason: string,
  saved: { imported: number; already: number } | null): string {
  const why = /canceling statement due to statement timeout/i.test(reason)
    ? "the database took too long on this part"
    : reason.trim().replace(/\.+$/, "");
  const head = `Part ${part + 1} of ${parts} stopped: ${why}.`;
  if (saved === null) return `${head} This was the check — nothing was saved. Press Check first again.`;
  const kept = part === 0 ? "Nothing from this part was saved."
    : `${part === 1 ? "Part 1 is" : `Parts 1–${part} are`} done (${saved.imported.toLocaleString("en-IN")} new receipts`
      + `${saved.already ? `, ${saved.already.toLocaleString("en-IN")} already recorded` : ""}).`;
  return `${head} ${kept} Press "${carryOnLabel(part)}" — payments already recorded count as already, nothing is booked twice.`;
}

/** A part failed: the message above + what the parts before it did. */
class PartFailed extends Error {
  constructor(message: string, readonly sum: PartResult, readonly part: number) { super(message); }
}

export function ZohoFyReceiptsImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState<null | "read" | "preview" | "check" | "import">(null);
  const [error, setError] = React.useState<string | null>(null);
  /* R-2547: a failed part's message — kept apart from `error`, so the preview refresh after the import does not wipe it. */
  const [partError, setPartError] = React.useState<string | null>(null);
  const [resumeAt, setResumeAt] = React.useState<number | null>(null);
  const [read, setRead] = React.useState<ReadState | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [accounts, setAccounts] = React.useState<Record<string, string>>({});
  /* R-2653: Read again — all accounts (default) or one Zoho deposit account (e.g. Razorpay Clearing). */
  const [onlyAccount, setOnlyAccount] = React.useState<string>(ALL_ACCOUNTS);
  const [depositNames, setDepositNames] = React.useState<Record<string, string>>({});
  const [check, setCheck] = React.useState<PartResult | null>(null);
  const [done, setDone] = React.useState<PartResult | null>(null);
  const stop = React.useRef(false);
  const invalidateMoney = React.useCallback(() => {
    for (const key of [["invoices"], ["payments"], ["bank"], ["balance-sheet"], ["outstanding-receivables"], ["aging"], ["tds"]]) void qc.invalidateQueries({ queryKey: key });
  }, [qc]);
  React.useEffect(() => { stop.current = false; return () => { stop.current = true; }; }, []);

  const loadPreview = React.useCallback(async (map: Record<string, string>) => {
    setBusy("preview"); setError(null); setCheck(null);
    try {
      const p = await call<Preview>({ action: "preview", accounts: map });
      setPreview(p);
      /* R-2653: the Zoho deposit accounts the "Read again" choice offers (kept while a read runs). */
      /* ("" = payments Zoho gave no account — not something a read can be limited to.) */
      setDepositNames((prev) => ({ ...prev, ...Object.fromEntries(p.deposits.filter((d) => d.zohoAccountId).map((d) => [d.zohoAccountId, d.zohoName])) }));
      /* The screen's choice = what the server used (owner's pick, Leave these out, else its suggestion)
         — and exactly what the import sends: the import maps nothing the screen did not show. An
         account the owner set to "Choose…" stays "" (no suggestion fills it later). */
      setAccounts(Object.fromEntries(p.deposits.flatMap((d): [string, string][] =>
        d.leftOut ? [[d.zohoAccountId, LEAVE_OUT]] : d.appAccountId ? [[d.zohoAccountId, d.appAccountId]] : map[d.zohoAccountId] === "" ? [[d.zohoAccountId, ""]] : [])));
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  }, []);

  /* R-2607: follow the server's read while this window is open — each "step" is one server pass
     (the cron does the same with the window closed; the lease keeps it to one at a time). */
  const followRead = React.useCallback(async (map: Record<string, string>) => {
    setBusy("read");
    let last: ReadState | null = null;
    try {
      for (;;) {
        last = await call<ReadState>({ action: "step" });
        setRead(last);
        if (last.complete || !last.running || stop.current) break;
        await sleep(STEP_GAP_MS);
      }
    } catch (e) { setError((e as Error).message); setBusy(null); return; }
    setBusy(null);
    if (last?.error) setError(last.error);
    if (last?.complete && !stop.current) await loadPreview(map);
  }, [loadPreview]);

  async function readZoho() {
    const again = !!(read?.complete || preview);
    setBusy("read"); setError(null); setPartError(null); setResumeAt(null); setPreview(null); setCheck(null); setDone(null);
    try {
      /* R-2653: Read again keeps what is read — only new / changed payments (of the chosen account) are read. */
      if (again) await call({ action: "restart", onlyAccount: onlyAccount || null });
      setRead(await call<ReadState>({ action: "start" }));
    } catch (e) { setError((e as Error).message); setBusy(null); return; }
    await followRead(accounts);
  }

  /** Parts `from`..last, in order; a failed part stops the run with PartFailed (what the earlier parts did + the message). */
  async function runParts(dryRun: boolean, from = 0): Promise<PartResult> {
    const sum: PartResult = { imported: 0, already: 0, banked: 0, bankLater: 0, withFee: 0, fee: 0, skipped: [] };
    const parts = preview?.parts ?? 0;
    for (let part = from; part < parts && !stop.current; part++) {
      try {
        const r = await call<{ result: { imported: number; already: number; banked: number; bank_later: number; with_fee?: number; fee?: number; skipped: { number: string; reason: string }[] } }>(
          { action: "import", part, dryRun, accounts });
        sum.imported += r.result.imported; sum.already += r.result.already; sum.banked += r.result.banked; sum.bankLater += r.result.bank_later;
        sum.withFee += r.result.with_fee ?? 0; sum.fee += r.result.fee ?? 0;
        sum.skipped.push(...r.result.skipped);
      } catch (e) {
        throw new PartFailed(partFailedMessage(part, parts, (e as Error).message, dryRun ? null : sum), sum, part);
      }
    }
    return sum;
  }

  async function dryRun() {
    setBusy("check"); setError(null); setPartError(null); setResumeAt(null);
    try { setCheck(await runParts(true)); } catch (e) { setPartError((e as Error).message); } finally { setBusy(null); }
  }

  /* R-2547: a failed part leaves `resumeAt` = that part; the next Import carries on from there (the parts
     before it are saved — no need to send them again). */
  async function doImport() {
    const from = resumeAt ?? 0;
    setBusy("import"); setError(null); setPartError(null); setDone(null);
    let failedAt: number | null = null;
    try {
      setDone(await runParts(false, from));
    } catch (e) {
      if (e instanceof PartFailed) {
        failedAt = e.part;
        if (e.sum.imported || e.sum.already || e.sum.skipped.length) setDone(e.sum);
      }
      setPartError((e as Error).message);
    } finally { setBusy(null); }
    setResumeAt(failedAt);
    invalidateMoney();
    await loadPreview(accounts);
  }

  /* On open: where the server's read stands (R-2607) — still running → follow it; else the preview. */
  React.useEffect(() => {
    if (!open || preview || read) return;
    void (async () => {
      try {
        const s = await call<ReadState>({ action: "status" });
        setRead(s);
        if (s.running) { await followRead({}); return; }
        if (s.error) setError(s.error);
      } catch { /* the preview below says what is wrong */ }
      await loadPreview({});
    })();
  }, [open, preview, read, loadPreview, followRead]);

  /* After Remove import: the same screens as after Import show the receipts gone (review). */
  async function afterRemove() {
    invalidateMoney();
    await loadPreview(accounts);
  }

  const toBook = (preview?.counts.import ?? 0) + (preview?.counts.alreadyNotBanked ?? 0);
  const feeText = razorpayFeeText(preview?.counts.withFee ?? 0, preview?.totals.fee ?? 0);
  const canResume = resumeAt !== null && resumeAt < (preview?.parts ?? 0);
  /* R-2607: closing while it reads is fine — the server carries on. */
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy || busy === "read") onOpenChange(o); }}>
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
            {(read?.complete || preview) && Object.keys(depositNames).length > 0 && (
              <label className="flex items-center gap-2 text-xs text-ink-2">
                Read again
                <select
                  data-testid="fy-receipts-only-account"
                  className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  value={onlyAccount}
                  disabled={!!busy}
                  onChange={(e) => setOnlyAccount(e.target.value)}
                >
                  <option value={ALL_ACCOUNTS}>All accounts</option>
                  {Object.entries(depositNames).map(([id, name]) => <option key={id} value={id}>Only {name}</option>)}
                </select>
              </label>
            )}
            {read && (
              <span className="text-xs text-ink-2" role="status">
                {readStatusText(read, read.onlyAccount ? depositNames[read.onlyAccount] ?? read.onlyAccount : null)}
              </span>
            )}
          </div>
          {onlyAccount && (read?.complete || preview) && (
            <p className="text-xs text-ink-2" data-testid="fy-receipts-only-hint">
              Only payments deposited to {depositNames[onlyAccount] ?? "this account"} are checked in Zoho. Payments to other
              accounts stay as last read — choose All accounts to check them too.
            </p>
          )}

          {partError && <p role="alert" data-testid="fy-receipts-part-error" className="text-xs text-rose-ink">{partError}</p>}
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
              {feeText && <p className="text-xs text-ink-2" data-testid="fy-receipts-fee">{feeText}</p>}

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
                          onChange={(e) => {
                            /* R-2547: another account choice = another plan — the old part message / carry-on point no longer fit. */
                            const next = { ...accounts, [d.zohoAccountId]: e.target.value };
                            setAccounts(next); setPartError(null); setResumeAt(null); void loadPreview(next);
                          }}
                          className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                        >
                          <option value="">Choose the app account…</option>
                          {preview.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                          <option value={LEAVE_OUT}>Leave these out</option>
                        </select>
                        {d.suggested && <span className="text-3xs text-ink-3">suggested</span>}
                        {d.leftOut && <span className="text-3xs text-ink-3">left out — not imported</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.skipReasons.length > 0 && (
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Left out, and why</p>
                  <ul className="text-xs text-ink-2 space-y-0.5 max-h-40 overflow-y-auto" data-testid="fy-receipts-skip-reasons">
                    {preview.skipReasons.map((r) => <li key={r.reason}><b>{r.count}</b> · {r.reason}</li>)}
                  </ul>
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-ink-3">Show the payments left out</summary>
                    <ul className="max-h-48 overflow-y-auto mt-1 space-y-0.5" data-testid="fy-receipts-left-out">
                      {preview.skipped.map((s, i) => (
                        <li key={`${s.number}-${s.date}-${i}`}><span className="font-mono">{s.number}</span> · {formatDate(s.date)} · {s.customer} · {leftOutMoney(s)} — {s.reason}</li>
                      ))}
                      {(preview.skippedMore ?? 0) > 0 && <li className="text-ink-3">… and {preview.skippedMore!.toLocaleString("en-IN")} more not listed here (counted above).</li>}
                    </ul>
                  </details>
                </div>
              )}
              {check && <PartSummary title="Check result (nothing saved)" r={check} accounted={accountedText(preview.counts.scanned, preview.counts.skip, check)} />}
              {done && <PartSummary title="Recorded" r={done} />}
              {preview.batches.length > 0 && (
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Imports</p>
                  <ul className="space-y-1.5">
                    {preview.batches.map((b) => <BatchRow key={b.id} b={b} canRemove={preview.canRemove} onChanged={afterRemove} />)}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={!!busy && busy !== "read"} onClick={() => onOpenChange(false)}>Close</Button>
          {preview && toBook > 0 && (
            <>
              <Button type="button" loading={busy === "check"} disabled={!!busy && busy !== "check"} onClick={dryRun}>Check first (nothing saved)</Button>
              <Button type="button" variant="primary" loading={busy === "import"} disabled={!(check || canResume) || (!!busy && busy !== "import")} onClick={doImport}
                title={check || canResume ? undefined : "Run the check first"}>
                {canResume ? carryOnLabel(resumeAt!)
                  : preview.counts.import > 0 ? `Import ${preview.counts.import.toLocaleString("en-IN")} receipts` : "Match bank lines"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PartSummary({ title, r, accounted }: { title: string; r: PartResult; accounted?: string }) {
  const feeText = razorpayFeeText(r.withFee, r.fee);
  const groups = refusalGroups(r.skipped);
  return (
    <div className="rounded-md border border-hairline px-3 py-2 text-xs" role="status">
      <p className="font-semibold text-ink">
        {title}: {r.imported.toLocaleString("en-IN")} receipts · {r.banked} matched to bank lines
        {r.bankLater ? ` · ${r.bankLater} wait for their bank line` : ""}{r.already ? ` · ${r.already} already recorded` : ""}{r.skipped.length ? ` · ${r.skipped.length} refused` : ""}
      </p>
      {feeText && <p className="text-ink-2" data-testid="fy-receipts-part-fee">{feeText}</p>}
      {accounted && <p className="text-ink-2" data-testid="fy-receipts-accounted">{accounted}</p>}
      {r.skipped.length > 0 && (
        <>
          {/* R-2693: the refusals by kind with a count, then every one (was cut at 200 without a word). */}
          <ul className="mt-1 text-ink-2" data-testid="fy-receipts-refused-reasons">
            {groups.map((g) => <li key={g.reason}><b>{g.count.toLocaleString("en-IN")}</b> · {g.reason}</li>)}
          </ul>
          <ul className="mt-1 max-h-32 overflow-y-auto text-ink-2">
            {r.skipped.map((s, i) => <li key={`${s.number}-${i}`}><span className="font-mono">{s.number}</span> — {s.reason}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

/** R-2501 follow-up: one import batch, with "Remove import" (owner only — the SQL checks; refused once
 *  anything in it was used: a refund, a TDS certificate, the advance spent, a line matched by hand). */
function BatchRow({ b, canRemove, onChanged }: { b: ImportBatch; canRemove: boolean; onChanged: () => Promise<void> }) {
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <li className="rounded-md border border-hairline px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-ink-2">{formatDate(b.createdAt)} · {b.importedCount} payments · {rupee(b.amountTotal)} · TDS {rupee(b.taxTotal)}{b.skippedCount ? ` · ${b.skippedCount} refused` : ""}</span>
        {b.removedAt ? <Badge kind="muted" size="sm">Removed {formatDate(b.removedAt)}</Badge>
          : canRemove && b.importedCount > 0 && !asking ? <Button type="button" size="sm" variant="ghost" icon="trash" onClick={() => setAsking(true)}>Remove import</Button> : null}
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
