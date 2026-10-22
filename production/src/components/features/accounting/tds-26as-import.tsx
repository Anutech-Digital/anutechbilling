/**
 * 26AS / AIS import — file do, app TDS receivable se milaaye, aap dekh kar confirm karo.
 *
 * File browser me hi padhi jaati hai (lib/accounting/tds-26as.ts) — deductors ke TAN/naam
 * wali file server par upload nahi hoti. Server par sirf confirm hui row ids jaati hain
 * (tds_mark_26as_verified), aur wo bhi sirf khuli (pending_cert / cert_received) rows badalti hain.
 * Jo match nahi hua, wo chhupta nahi: har bucket ka naam aur "ab kya karein" likha hai.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate } from "@/lib/utils";
import { localDateISO } from "@/lib/leads/outcomes";
import { useTdsReceivables, useApply26asMatches } from "@/lib/queries/tds-receivable";
import {
  parseTdsCreditFile, matchCredits, type ParsedCredits, type MatchResult, type TdsCreditEntry,
} from "@/lib/accounting/tds-26as";

const inr = (paise: number) => rupee(Math.round(paise / 100));

export function Tds26asImport() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Icon name="upload" size={12} /> Import 26AS / AIS
      </Button>
      {open && <ImportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const allQ = useTdsReceivables({ status: "all" });
  const apply = useApply26asMatches();
  const [parsed, setParsed] = React.useState<ParsedCredits | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());

  const result: MatchResult | null = React.useMemo(() => {
    if (!parsed || !allQ.data) return null;
    return matchCredits(parsed.entries, allQ.data.map((r) => ({
      id: r.id, customer_name: r.customer_name, customer_tan: r.customer_tan,
      tds_amount: r.tds_amount, payment_received_date: r.payment_received_date,
      fiscal_year: r.fiscal_year, status: r.status,
    })));
  }, [parsed, allQ.data]);

  React.useEffect(() => {
    setPicked(new Set((result?.matched ?? []).map((m) => m.receivable.id)));
  }, [result]);

  const onFile = async (f: File | undefined) => {
    setParsed(null); setFileError(null);
    if (!f) return;
    try {
      setParsed(parseTdsCreditFile(f.name, await f.text()));
    } catch (e) {
      setFileError((e as Error).message);
    }
  };

  const today = localDateISO(new Date());
  const seenOn = parsed?.asOn && parsed.asOn <= today ? parsed.asOn : today;

  const confirm = async () => {
    if (picked.size === 0) return;
    try {
      await apply.mutateAsync({ ids: [...picked], seenOn });
      onClose();
    } catch { /* hook toasts */ }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import Form 26AS / AIS</DialogTitle>
          <DialogDescription>
            Add the 26AS &quot;Text&quot; file (.txt) from TRACES or the AIS JSON. The file is read in this browser only —
            it is not uploaded. Statuses change only after you confirm the matched entries.
          </DialogDescription>
        </DialogHeader>

        <input
          type="file"
          accept=".txt,.json,text/plain,application/json"
          aria-label="26AS text or AIS JSON file"
          onChange={(e) => onFile(e.target.files?.[0])}
          className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-hairline file:bg-paper-2 file:px-3 file:py-1.5 file:text-sm"
        />

        {fileError && (
          <p role="alert" className="text-sm text-rose rounded-md border border-rose/40 bg-rose-soft/30 p-3">{fileError}</p>
        )}
        {allQ.error && (
          <p role="alert" className="text-sm text-rose">Could not load TDS entries: {(allQ.error as Error).message}. Reload the page.</p>
        )}

        {parsed && (
          <p className="text-xs text-ink-3">
            {parsed.source === "26as" ? "Form 26AS" : "AIS"} · {parsed.entries.length} TDS entries
            {parsed.pan ? <> · PAN <span className="font-mono">{parsed.pan}</span></> : null}
            {parsed.financialYear ? <> · FY {parsed.financialYear}</> : null}
            {parsed.asOn ? <> · as on {formatDate(parsed.asOn)}</> : null}
            {" "}— check once that the PAN is your company's.
          </p>
        )}

        {result && (
          <div className="space-y-4">
            <Bucket
              tone="success" title={`Matched — ready to verify (${result.matched.length})`}
              help="Deductor TAN, amount (to ₹1) and FY match. Untick any you do not accept."
            >
              {result.matched.map((m) => (
                <label key={m.receivable.id} className="flex items-center gap-3 py-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.has(m.receivable.id)}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(m.receivable.id); else n.delete(m.receivable.id); return n; })}
                  />
                  <span className="flex-1 min-w-0 truncate">{m.receivable.customer_name} · <span className="font-mono text-xs">{m.entry.tan}</span></span>
                  <span className="text-ink-3 text-xs">{formatDate(m.entry.date)}{m.dayGap > 0 ? ` (±${m.dayGap}d)` : ""}</span>
                  <span className="font-mono">{rupee(m.receivable.tds_amount)}</span>
                </label>
              ))}
            </Bucket>

            <EntryBucket tone="warning" title="In 26AS but not Final" entries={result.notFinal}
              help="Booking status is not F (U = unmatched, P = provisional, O = overbooked) — the deductor's challan is not yet linked in 26AS. Ask the customer to correct the challan; until then the claim is not safe." />

            <Bucket tone="danger" title={`Amount differs (${result.amountMismatch.length})`}
              help="Same customer (TAN) and FY, but a different amount. Compare with the customer's Form 16A — if less was deposited, the rest cannot be claimed.">
              {result.amountMismatch.map((x, i) => (
                <div key={`${x.receivable.id}-${i}`} className="flex gap-3 py-1 text-sm">
                  <span className="flex-1 truncate">{x.receivable.customer_name}</span>
                  <span className="text-ink-3">26AS {inr(x.entry.tdsPaise)} vs records {rupee(x.receivable.tds_amount)}</span>
                </div>
              ))}
            </Bucket>

            <Bucket tone="danger" title={`Open in your records, not in this file (${result.missing.length})`}
              help="The customer deducted TDS but it is not in 26AS — either not deposited, or deposited under a wrong TAN / PAN. Ask the customer for Form 16A and the challan.">
              {result.missing.map((r) => (
                <div key={r.id} className="flex gap-3 py-1 text-sm">
                  <span className="flex-1 truncate">{r.customer_name}</span>
                  <span className="text-ink-3">{formatDate(r.payment_received_date)}</span>
                  <span className="font-mono">{rupee(r.tds_amount)}</span>
                </div>
              ))}
            </Bucket>

            <EntryBucket tone="muted" title="In 26AS, no record in the app" entries={result.unknown}
              help="No TDS entry for this TAN in the app. TDS was probably missed when the payment was recorded — add a TDS entry on that payment." />

            <Bucket tone="muted" title={`Open entries with no customer TAN (${result.noTan.length})`}
              help="Cannot match with the file without a TAN. Open the entry, add the customer's TAN, then import again.">
              {result.noTan.map((r) => (
                <div key={r.id} className="flex gap-3 py-1 text-sm">
                  <span className="flex-1 truncate">{r.customer_name}</span>
                  <span className="font-mono">{rupee(r.tds_amount)}</span>
                </div>
              ))}
            </Bucket>

            {result.alreadyDone.length > 0 && (
              <p className="text-xs text-ink-3">{result.alreadyDone.length} entries match rows that are already verified / claimed / closed — unchanged.</p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={confirm} disabled={picked.size === 0 || apply.isPending}>
            {apply.isPending ? "Saving…" : `Mark ${picked.size} as verified on 26AS`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Bucket({ tone, title, help, children }: {
  tone: "success" | "warning" | "danger" | "muted"; title: string; help: string; children: React.ReactNode;
}) {
  const empty = React.Children.count(children) === 0;
  if (empty) return null;
  return (
    <section className="rounded-lg border border-hairline p-3">
      <div className="flex items-center gap-2 mb-1"><Badge kind={tone}>{title}</Badge></div>
      <p className="text-xs text-ink-3 mb-2">{help}</p>
      <div className="divide-y divide-hairline">{children}</div>
    </section>
  );
}

function EntryBucket({ tone, title, entries, help }: {
  tone: "warning" | "muted"; title: string; entries: TdsCreditEntry[]; help: string;
}) {
  return (
    <Bucket tone={tone} title={`${title} (${entries.length})`} help={help}>
      {entries.map((e, i) => (
        <div key={`${e.tan}-${e.date}-${i}`} className="flex gap-3 py-1 text-sm">
          <span className="flex-1 truncate">{e.deductorName ?? "—"} · <span className="font-mono text-xs">{e.tan}</span>{e.booking ? ` · ${e.booking}` : ""}</span>
          <span className="text-ink-3">{formatDate(e.date)}</span>
          <span className="font-mono">{inr(e.tdsPaise)}</span>
        </div>
      ))}
    </Bucket>
  );
}
