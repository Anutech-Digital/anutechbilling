/**
 * R-2499 (G-FY2526) — Invoices → "FY 2025-26 sales from Zoho": the year's Zoho invoices come in as
 * the app's own sales, exactly as Zoho issued them (number, date, GST split), counted in revenue,
 * GSTR-1 / 3B, the day book and the ledger. Owner / accountant only.
 *
 *   1. Read from Zoho   — the server reads the year (list + each invoice), paced, resumable.
 *   2. Preview          — per month: Zoho's sales vs what will come in vs what is already in the app;
 *                         why the rest is left out (void, draft, no customer, opening invoice, …).
 *   3. Check (dry run)  — the database runs the real import and rolls it back: its own refusals.
 *   4. Import           — in parts; each part is one batch (activity log), removable while untouched.
 *
 * No IRN, no app number, no reminder emails; receipts come later (R-2501). Zoho is only read.
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
import { Checkbox } from "@/components/ui/checkbox";
import type { GstinChoice, MonthTotals } from "@/lib/integrations/zoho-books/sales-import/plan";
import type { ImportBatch } from "@/lib/integrations/zoho-books/fy-import/store";

const API = "/api/integrations/zoho-books/sales-import";
const FY = "2025-26";
/** Between two read requests: their Zoho calls stay under ZOHO_CALLS_PER_MIN. */
const READ_GAP_MS = Math.ceil((FY_CALLS_PER_REQUEST / ZOHO_CALLS_PER_MIN) * 60_000);

interface Preview {
  scanned: number;
  counts: { scanned: number; import: number; already: number; skip: number; voidOrDraft: number };
  parts: number;
  zohoByMonth: MonthTotals[]; importByMonth: MonthTotals[]; appByMonth: MonthTotals[];
  skipReasons: { reason: string; count: number }[];
  skipped: { number: string; date: string; customer: string; amount: number; reason: string | null }[];
  batches: ImportBatch[];
  /** R-2530: name matches one customer, but another PAN — the owner ticks "Use this customer anyway". */
  gstinChoices?: GstinChoice[];
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

export function ZohoFySalesImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState<null | "read" | "preview" | "check" | "import">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [read, setRead] = React.useState<{ listed: number; detailed: number; complete: boolean } | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [check, setCheck] = React.useState<PartResult | null>(null);
  const [done, setDone] = React.useState<PartResult | null>(null);
  /* R-2530: normalised Zoho name → customer id. Sent with preview AND every import part, so the
     server's plan (and its parts) is the one the owner saw. */
  const [useAnyway, setUseAnyway] = React.useState<Record<string, string>>({});
  const stop = React.useRef(false);
  /* Set on mount too: React strict mode mounts twice, and a stale `true` would stop every loop. */
  React.useEffect(() => { stop.current = false; return () => { stop.current = true; }; }, []);

  const loadPreview = React.useCallback(async (ticks: Record<string, string> = useAnyway) => {
    setBusy("preview"); setError(null);
    try { setPreview(await call<Preview>({ action: "preview", useAnyway: ticks })); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }, [useAnyway]);

  /* A tick changes what comes in: the old check no longer matches → preview again, check again. */
  /* The ticks change only when that preview came back — a failed preview leaves ticks, parts and
     checkboxes as they were, so the import never sends ticks the parts count was not built with. */
  async function toggleChoice(c: GstinChoice, on: boolean) {
    const next = { ...useAnyway };
    if (on) next[c.key] = c.customerId; else delete next[c.key];
    setBusy("preview"); setError(null);
    try {
      const p = await call<Preview>({ action: "preview", useAnyway: next });
      setUseAnyway(next); setPreview(p); setCheck(null); setDone(null);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function readZoho() {
    const again = !!(read?.complete || preview);
    setBusy("read"); setError(null); setPreview(null); setCheck(null); setDone(null);
    try {
      /* Read again = from the start: a Zoho invoice voided, edited or added since is seen. */
      if (again) await call({ action: "restart" });
      for (;;) {
        const r = await call<{ listed: number; detailed: number; complete: boolean; busy: boolean }>({ action: "read" });
        setRead(r);
        if (r.complete || stop.current) break;
        await sleep(r.busy ? 60_000 : READ_GAP_MS);
      }
    } catch (e) { setError((e as Error).message); setBusy(null); return; }
    setBusy(null);
    await loadPreview();
  }

  async function runParts(dryRun: boolean): Promise<PartResult> {
    const sum: PartResult = { imported: 0, already: 0, skipped: [] };
    for (let part = 0; part < (preview?.parts ?? 0) && !stop.current; part++) {
      const r = await call<{ result: { imported: number; already: number; skipped: { number: string; reason: string }[] } }>({ action: "import", part, dryRun, useAnyway });
      sum.imported += r.result.imported; sum.already += r.result.already; sum.skipped.push(...r.result.skipped);
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
      for (const key of [["invoices"], ["balance-sheet"], ["outstanding-receivables"], ["aging"], ["gst"], ["pnl"]]) void qc.invalidateQueries({ queryKey: key });
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
    await loadPreview();
  }

  React.useEffect(() => { if (open && !preview && !read) void loadPreview().catch(() => {}); }, [open, preview, read, loadPreview]);

  const toImport = preview?.counts.import ?? 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>FY {FY} sales from Zoho</DialogTitle>
          <DialogDescription>
            Zoho's invoices for 1 Apr 2025 – 31 Mar 2026 come in as your sales, with Zoho's number, date and GST
            (IGST or CGST + SGST). Void and draft invoices stay out. No e-invoice, no reminder emails; payments come later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="flex items-center gap-3 flex-wrap">
            <Button type="button" icon="download" loading={busy === "read"} disabled={!!busy && busy !== "read"} onClick={readZoho}>
              {read?.complete || preview ? "Read from Zoho again" : "Read from Zoho"}
            </Button>
            {read && (
              <span className="text-xs text-ink-2" role="status">
                {read.complete ? `Read all ${read.listed.toLocaleString("en-IN")} invoices.` : `Read ${read.detailed.toLocaleString("en-IN")} of ${read.listed.toLocaleString("en-IN")}${busy === "read" ? " — keep this open" : ""}`}
              </span>
            )}
          </div>

          {error && <p role="alert" className="text-xs text-rose-ink">{error}</p>}

          {preview && (
            <>
              <p data-testid="fy-sales-summary">
                <b>{preview.counts.scanned.toLocaleString("en-IN")}</b> Zoho invoices ·{" "}
                <b>{toImport.toLocaleString("en-IN")}</b> to import
                {preview.counts.already > 0 && <> · <Badge kind="muted" size="sm">{preview.counts.already} already in the app</Badge></>}
                {preview.counts.skip > 0 && <> · <Badge kind="warning" size="sm">{preview.counts.skip} left out</Badge></>}
              </p>
              <MonthTable preview={preview} />
              {(preview.gstinChoices?.length ?? 0) > 0 && (
                <GstinChoices choices={preview.gstinChoices ?? []} disabled={!!busy} onToggle={toggleChoice} />
              )}
              {preview.skipReasons.length > 0 && (
                <div>
                  <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Left out, and why</p>
                  <ul className="text-xs text-ink-2 space-y-0.5">
                    {preview.skipReasons.slice(0, 8).map((r) => <li key={r.reason}><b>{r.count}</b> · {r.reason}</li>)}
                  </ul>
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-ink-3">Show the invoices left out</summary>
                    <ul className="max-h-48 overflow-y-auto mt-1 space-y-0.5">
                      {preview.skipped.map((s) => (
                        <li key={s.number + s.date}><span className="font-mono">{s.number}</span> · {formatDate(s.date)} · {s.customer} · {rupee(s.amount)} — {s.reason}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              )}
              {check && <PartSummary title="Check result (nothing saved)" r={check} />}
              {done && <PartSummary title="Imported" r={done} />}
              {preview.batches.length > 0 && <Batches batches={preview.batches} onChanged={loadPreview} />}
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={!!busy} onClick={() => onOpenChange(false)}>Close</Button>
          {preview && toImport > 0 && (
            <>
              <Button type="button" loading={busy === "check"} disabled={!!busy && busy !== "check"} onClick={dryRun}>Check first (nothing saved)</Button>
              <Button type="button" variant="primary" loading={busy === "import"} disabled={!check || (!!busy && busy !== "import")} onClick={doImport}
                title={check ? undefined : "Run the check first"}>
                Import {toImport.toLocaleString("en-IN")} sales
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MonthTable({ preview }: { preview: Preview }) {
  const months = [...new Set([...preview.zohoByMonth, ...preview.importByMonth, ...preview.appByMonth].map((m) => m.month))].sort();
  const get = (list: MonthTotals[], m: string) => list.find((x) => x.month === m);
  const cell = (t: MonthTotals | undefined) => (t ? <>{rupee(t.taxable)}<span className="block text-3xs text-ink-3">GST {rupee(t.igst + t.cgst + t.sgst)} · {t.count}</span></> : "—");
  return (
    <div className="border border-hairline rounded-md overflow-x-auto max-h-72 overflow-y-auto">
      <table className="w-full text-xs">
        <thead className="bg-paper-2 border-b border-hairline sticky top-0">
          <tr>
            <th scope="col" className="p-2 text-left font-semibold text-ink-3">Month</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3">Zoho sales (taxable)</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3">IGST · CGST · SGST (Zoho)</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3">Will come in</th>
            <th scope="col" className="p-2 text-right font-semibold text-ink-3">Already in the app</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => {
            const z = get(preview.zohoByMonth, m);
            return (
              <tr key={m} className="border-b border-hairline last:border-0 tabular-nums">
                <td className="p-2 text-ink whitespace-nowrap">{monthLabel(m)}</td>
                <td className="p-2 text-right">{cell(z)}</td>
                <td className="p-2 text-right text-ink-2 whitespace-nowrap">{z ? `${rupee(z.igst)} · ${rupee(z.cgst)} · ${rupee(z.sgst)}` : "—"}</td>
                <td className="p-2 text-right">{cell(get(preview.importByMonth, m))}</td>
                <td className="p-2 text-right">{cell(get(preview.appByMonth, m))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** R-2530: same name as one app customer, another PAN — imported only when the owner ticks it.
 *  Each invoice keeps its own GSTIN and place of supply either way (GSTR-1 was filed with them). */
function GstinChoices({ choices, disabled, onToggle }: { choices: GstinChoice[]; disabled: boolean; onToggle: (c: GstinChoice, on: boolean) => void }) {
  return (
    <div data-testid="fy-sales-gstin-choices">
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Same name, different GSTIN — your call</p>
      <p className="text-xs text-ink-2 mb-1.5">
        Tick a customer only if it is the same buyer. The invoices keep their own GSTIN and place of supply, as filed in GSTR-1.
      </p>
      <ul className="space-y-1.5">
        {choices.map((c) => {
          const id = `use-anyway-${c.key.replace(/\s+/g, "-")}`;
          return (
            <li key={c.key} className="flex items-start gap-2 rounded-md border border-hairline px-3 py-2 text-xs">
              <Checkbox id={id} checked={c.chosen} disabled={disabled} onCheckedChange={(v) => onToggle(c, v === true)} className="mt-0.5" />
              <label htmlFor={id} className="min-w-0 cursor-pointer">
                <span className="text-ink font-medium">Use this customer anyway: {c.customerName}</span>
                <span className="block text-ink-2">
                  {c.count} {c.count === 1 ? "invoice" : "invoices"} · {rupee(c.amount)} · invoice GSTIN{" "}
                  <span className="font-mono">{c.invoiceGstins.join(", ")}</span> · customer GSTIN <span className="font-mono">{c.customerGstin}</span>
                  {c.zohoName !== c.customerName && <> · Zoho name {c.zohoName}</>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PartSummary({ title, r }: { title: string; r: PartResult }) {
  return (
    <div className="rounded-md border border-hairline px-3 py-2 text-xs" role="status">
      <p className="font-semibold text-ink">{title}: {r.imported.toLocaleString("en-IN")} sales{r.already ? ` · ${r.already} already in the app` : ""}{r.skipped.length ? ` · ${r.skipped.length} refused` : ""}</p>
      {r.skipped.length > 0 && (
        <ul className="mt-1 max-h-32 overflow-y-auto text-ink-2">
          {r.skipped.slice(0, 200).map((s) => <li key={s.number}><span className="font-mono">{s.number}</span> — {s.reason}</li>)}
        </ul>
      )}
    </div>
  );
}

function Batches({ batches, onChanged }: { batches: ImportBatch[]; onChanged: () => Promise<void> }) {
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Imports</p>
      <ul className="space-y-1.5">{batches.map((b) => <BatchRow key={b.id} b={b} onChanged={onChanged} />)}</ul>
    </div>
  );
}

function BatchRow({ b, onChanged }: { b: ImportBatch; onChanged: () => Promise<void> }) {
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <li className="rounded-md border border-hairline px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-ink-2">{formatDate(b.createdAt)} · {b.importedCount} sales · taxable {rupee(b.taxableTotal)} · GST {rupee(b.taxTotal)}{b.skippedCount ? ` · ${b.skippedCount} refused` : ""}</span>
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
          <Button type="submit" size="sm" variant="danger" loading={busy} disabled={reason.trim().length < 3}>Remove {b.importedCount} sales</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>Keep</Button>
          {err && <p role="alert" className="w-full text-rose-ink">{err}</p>}
        </form>
      )}
    </li>
  );
}
