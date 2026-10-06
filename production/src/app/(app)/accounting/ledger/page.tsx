/**
 * The khata — a running Dr/Cr statement for one customer or one vendor.
 *
 * ─── WHAT THIS PAGE IS FOR, WHICH IS NOT "ANOTHER REPORT" ───────────────────
 * /accounting/aging answers "who owes me, and how old is it" across every customer. This
 * answers a different question that a reseller gets asked by name: *"send me my account
 * statement"*. A CA reconciling against their own Tally book, or a customer disputing one
 * line, needs the transactions in order with a balance carried down the page — not a
 * bucketed total.
 *
 * ─── ONE ENGINE, TWO DIRECTIONS ─────────────────────────────────────────────
 * Customer and vendor statements are mirror images (invoice → Dr, vendor bill → Cr), and
 * the whole mirror lives in `side()` in lib/accounting/ledger.ts with tests on both
 * directions. This page picks a `kind` and renders; it contains no sign logic of its own,
 * because a second copy of that decision is how a vendor statement ends up claiming the
 * vendor owes us money.
 *
 * ─── OPENING BALANCE IS FETCHED, NOT ASSUMED ────────────────────────────────
 * The opening is the signed sum of everything before the window — computed in SQL by
 * report_party_ledger since S17 (28 Sep 2026), never assumed to be zero. A plain
 * date-filtered query would quietly start every statement at zero.
 */
"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { cn, rupee } from "@/lib/utils";
import { useCustomers } from "@/lib/queries/customers";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  useCustomerLedger, useVendorLedger, useLedgerVendors,
} from "@/lib/queries/ledger";
import {
  fyOf, fyPeriod, quarterPeriod, monthPeriod,
  type LedgerKind, type LedgerPeriod, type LedgerStatement,
} from "@/lib/accounting/ledger";
import {
  ledgerCsvRows, ledgerFileName, ledgerTallyXml,
  ledgerWhatsAppText, ledgerWhatsAppUrl, LEDGER_CSV_HEADERS,
} from "@/lib/accounting/ledger-export";
import { downloadCSV } from "@/lib/csv";
import TallyDaybookButton from "@/components/features/accounting/tally-daybook-button";
import { localDateISO } from "@/lib/leads/outcomes";

/** The FY we are in now — the default window, because that is what a CA asks for. */
function currentFy(): number {
  return fyOf(localDateISO(new Date()));
}

type PeriodKey = "fy" | "fy-prev" | "q1" | "q2" | "q3" | "q4" | "month";

function periodFor(key: PeriodKey, fy: number): LedgerPeriod {
  switch (key) {
    case "fy":      return fyPeriod(fy);
    case "fy-prev": return fyPeriod(fy - 1);
    case "q1":      return quarterPeriod(fy, 1);
    case "q2":      return quarterPeriod(fy, 2);
    case "q3":      return quarterPeriod(fy, 3);
    case "q4":      return quarterPeriod(fy, 4);
    case "month": {
      const today = localDateISO(new Date());
      const [y, m] = today.split("-").map(Number);
      return monthPeriod(y, m);
    }
  }
}

/**
 * ─── WHY THE SUSPENSE WRAPPER BELOW EXISTS ──────────────────────────────────
 * This page reads ?customer= with useSearchParams(), and Next refuses to prerender a
 * component that does so unless it sits inside a Suspense boundary — the build fails with
 * a prerender error on this route and nothing else. Worth stating:  and
 * the whole test suite pass regardless, so only  catches it. Same class as
 * the typedRoutes trap in CLAUDE.md §25.2.
 */
function LedgerPageInner() {
  /* ─── ?customer=<id> OPENS STRAIGHT ON THAT PARTY ──────────────────────────
     So a statement is one click from wherever the customer already is — the
     subscriptions list, in particular, where a renewal conversation is exactly when
     somebody asks "what do they actually owe us?".

     Read once, into the initial state, rather than in an effect: an effect would let the
     page paint an empty picker first and then jump, and a param that fights a later
     manual choice is worse than one that seeds it. */
  const search = useSearchParams();
  const seededCustomer = search.get("customer");

  const [kind, setKind] = React.useState<LedgerKind>("customer");
  const [partyId, setPartyId] = React.useState<string | null>(seededCustomer);
  const [vendorName, setVendorName] = React.useState<string | null>(null);
  const [periodKey, setPeriodKey] = React.useState<PeriodKey>("fy");

  const fy = React.useMemo(() => currentFy(), []);
  const period = React.useMemo(() => periodFor(periodKey, fy), [periodKey, fy]);

  const customersQ = useCustomers();
  const vendorsQ = useLedgerVendors();
  const { data: me } = useCurrentUser();

  const custLedgerQ = useCustomerLedger(kind === "customer" ? partyId : null, period);
  const vendLedgerQ = useVendorLedger(kind === "vendor" ? vendorName : null, period);

  const entriesQ = kind === "customer" ? custLedgerQ : vendLedgerQ;
  const customer = (customersQ.data ?? []).find((c) => c.id === partyId) ?? null;
  const partyName = kind === "customer" ? (customer?.name ?? "") : (vendorName ?? "");

  const statement: LedgerStatement | null = entriesQ.data ?? null;

  const selected = kind === "customer" ? !!partyId : !!vendorName;

  /* ── Exports ───────────────────────────────────────────────────────────── */
  const onCsv = () => {
    if (!statement) return;
    downloadCSV(
      ledgerFileName(partyName, statement, "csv"),
      [...LEDGER_CSV_HEADERS],
      ledgerCsvRows(statement),
    );
    toast.success("Statement downloaded", {
      description: "Opens in Excel. The opening balance is the first row, so the columns add up.",
    });
  };

  const onTallyXml = () => {
    if (!statement) return;
    const xml = ledgerTallyXml(statement, partyName, me?.tenantName ?? "");
    const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = ledgerFileName(partyName, statement, "xml");
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    /* Said plainly rather than implying a one-click merge: Tally rejects a voucher whose
       LEDGERNAME does not already exist in the target company, silently for that row. */
    toast.success("Tally XML downloaded", {
      description: `Import via Gateway of Tally → Import Data → Vouchers. The ledger “${partyName}” must already exist in that company, or Tally skips the voucher.`,
    });
  };

  const onWhatsApp = () => {
    if (!statement) return;
    const text = ledgerWhatsAppText({
      partyName, statement, sellerName: me?.tenantName ?? null,
    });
    const phone = kind === "customer" ? customer?.contact_phone : null;
    window.open(ledgerWhatsAppUrl(phone, text), "_blank");
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
          <Link href={"/accounting" as Route} className="hover:text-ink-2">Accounting</Link>
        </p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Ledger</h1>
        <p className="text-sm text-ink-2 mt-1">
          One party&apos;s account, in order, with the balance carried down — the statement a
          customer or a CA asks for by name.
        </p>
      </div>

      {/* Who and when */}
      <Card className="p-3 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* Customer / vendor. A segmented control, not a dropdown: it changes what the
              Dr and Cr columns MEAN, which is too consequential to hide in a menu. */}
          <div>
            <label className="block text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Ledger of
            </label>
            <div className="inline-flex rounded-md border border-hairline overflow-hidden">
              {(["customer", "vendor"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer",
                    kind === k ? "bg-ink text-paper" : "bg-paper text-ink-2 hover:bg-paper-2",
                  )}
                >
                  {k === "customer" ? "Customer" : "Vendor"}
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-[220px] flex-1">
            <label htmlFor="party" className="block text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              {kind === "customer" ? "Customer" : "Vendor"}
            </label>
            {kind === "customer" ? (
              <select
                id="party"
                value={partyId ?? ""}
                onChange={(e) => setPartyId(e.target.value || null)}
                className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[13px] text-ink"
              >
                <option value="">Choose a customer…</option>
                {(customersQ.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : (
              <select
                id="party"
                value={vendorName ?? ""}
                onChange={(e) => setVendorName(e.target.value || null)}
                className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[13px] text-ink"
              >
                <option value="">Choose a vendor or payee…</option>
                {/* Ordered by total billed, and LABELLED. ANUTECH's expenses are dominated
                    by payroll, so an unlabelled list puts five employees above the first
                    real supplier with nothing to tell them apart. Excluding payroll would
                    have hidden ₹12L of genuine payables — see useLedgerVendors. */}
                {(vendorsQ.data ?? []).map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} · {rupee(v.billed, { compact: true })}
                    {v.isPayroll ? " · staff" : v.categories[0] ? ` · ${v.categories[0]}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="period" className="block text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Period
            </label>
            <select
              id="period"
              value={periodKey}
              onChange={(e) => setPeriodKey(e.target.value as PeriodKey)}
              className="rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-[13px] text-ink"
            >
              <option value="fy">{fyPeriod(fy).label}</option>
              <option value="fy-prev">{fyPeriod(fy - 1).label}</option>
              <option value="q1">{quarterPeriod(fy, 1).label}</option>
              <option value="q2">{quarterPeriod(fy, 2).label}</option>
              <option value="q3">{quarterPeriod(fy, 3).label}</option>
              <option value="q4">{quarterPeriod(fy, 4).label}</option>
              <option value="month">This month</option>
            </select>
          </div>

          {/* S34 — poori company ka day book (Sales + Receipt + Payment vouchers) is period ka.
              Party chunne ki zaroorat nahi, isliye party wale buttons se alag. */}
          <TallyDaybookButton period={period} companyName={me?.tenantName ?? ""} />

          {selected && statement && (
            <div className="flex items-center gap-1.5 ml-auto">
              <Button size="sm" variant="outline" icon="file" onClick={onCsv}>Excel / CSV</Button>
              <Button size="sm" variant="outline" icon="upload" onClick={onTallyXml}>Tally XML</Button>
              {kind === "customer" && (
                <Button size="sm" variant="primary" icon="whatsapp" onClick={onWhatsApp}>
                  Send statement
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>

      {!selected ? (
        <EmptyState
          icon="file"
          title={`Pick a ${kind} to see their account`}
          body={
            kind === "customer"
              ? "Every invoice, receipt, credit note and debit note in date order, with the running balance a customer can check against their own books."
              : "Every bill from this vendor and every payment against it, in date order. Purchase orders are not included — nothing is owed until the vendor actually bills you."
          }
        />
      ) : entriesQ.isError && !statement ? (
        /* R-270: a failed fetch used to leave the skeleton spinning forever. */
        <LoadError what="Statement" onRetry={() => { void entriesQ.refetch(); }} />
      ) : entriesQ.isLoading || !statement ? (
        <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : (
        <>
          <SummaryStrip statement={statement} partyName={partyName} />
          <StatementTable statement={statement} />
        </>
      )}
    </div>
  );
}

/**
 * Opening, billed, settled, closing.
 *
 * All four, never just the closing. A CA reconciles the movements; a lone net figure hides
 * the ₹10.79L billed and ₹15.19L received that produced it, and there is no way to find a
 * disagreement from a net.
 */
function SummaryStrip({ statement: s, partyName }: { statement: LedgerStatement; partyName: string }) {
  const owingWord = s.kind === "customer" ? "owes you" : "you owe";
  const oppositeWord = s.kind === "customer" ? "held as advance" : "paid ahead";

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      <Cell label="Opening balance" value={Math.abs(s.openingBalance)} side={s.openingSide} />
      <Cell label={s.kind === "customer" ? "Billed this period" : "Purchased this period"} value={s.totalBilled} />
      <Cell label={s.kind === "customer" ? "Received this period" : "Paid this period"} value={s.totalSettled} />
      <Card className={cn(
        "p-3.5",
        s.closingBalance === 0 ? "border-emerald/40 bg-emerald-soft/30"
          : s.closingSide === (s.kind === "customer" ? "Dr" : "Cr") ? "border-amber/50 bg-amber-soft/25"
          : "border-hairline",
      )}>
        <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Closing balance</div>
        <div className="font-serif text-2xl leading-none tabular-nums">
          {rupee(Math.abs(s.closingBalance))}
          {s.closingSide && <span className="ml-1.5 text-sm font-sans font-semibold text-ink-2">{s.closingSide}</span>}
        </div>
        {/* Spelled out, because "Dr" is not plain English to the person being sent this. */}
        <div className="text-xs text-ink-3 mt-1.5">
          {s.closingBalance === 0
            ? "Fully settled — nothing outstanding either way."
            : s.closingSide === (s.kind === "customer" ? "Dr" : "Cr")
              ? `${partyName || "This party"} ${owingWord} this.`
              : `${oppositeWord} — ${s.kind === "customer" ? "you are holding their money" : "this vendor holds yours"}.`}
        </div>
      </Card>
    </div>
  );
}

function Cell({ label, value, side }: { label: string; value: number; side?: "Dr" | "Cr" | null }) {
  return (
    <Card className="p-3.5">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className="font-serif text-2xl leading-none tabular-nums text-ink">
        {rupee(value)}
        {side && <span className="ml-1.5 text-sm font-sans font-semibold text-ink-2">{side}</span>}
      </div>
    </Card>
  );
}

/** The statement itself, in Tally's column order so a CA can read it without translating. */
function StatementTable({ statement: s }: { statement: LedgerStatement }) {
  return (
    <Card className="p-0 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-paper-2 text-ink-2">
            <tr className="text-left">
              <th className="p-2.5 font-semibold whitespace-nowrap">Date</th>
              <th className="p-2.5 font-semibold">Particulars</th>
              <th className="p-2.5 font-semibold whitespace-nowrap">Voucher</th>
              <th className="p-2.5 font-semibold text-right whitespace-nowrap">Debit</th>
              <th className="p-2.5 font-semibold text-right whitespace-nowrap">Credit</th>
              <th className="p-2.5 font-semibold text-right whitespace-nowrap">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {/* Opening balance as a ROW of the table, not a caption above it — so the eye
                and a column sum both start from the same number. */}
            <tr className="bg-paper-2/40">
              <td className="p-2.5 font-mono text-ink-3 whitespace-nowrap">{s.period.from}</td>
              <td className="p-2.5 font-medium text-ink-2" colSpan={2}>Opening Balance</td>
              <td className="p-2.5" />
              <td className="p-2.5" />
              <td className="p-2.5 text-right font-mono tabular-nums text-ink-2 whitespace-nowrap">
                {rupee(Math.abs(s.openingBalance))} {s.openingSide ?? ""}
              </td>
            </tr>

            {s.rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-ink-3 text-[12px]">
                  No transactions in {s.period.label}.
                  {s.openingBalance !== 0 && " The opening balance above is carried forward from earlier."}
                </td>
              </tr>
            )}

            {s.rows.map((r, i) => (
              <tr key={`${r.reference}-${i}`} className="hover:bg-paper-2/40">
                <td className="p-2.5 font-mono text-ink-2 whitespace-nowrap">{r.date}</td>
                <td className="p-2.5">
                  <span className="font-mono text-ink">{r.reference}</span>
                  {r.narration && <span className="block text-xs text-ink-3">{r.narration}</span>}
                </td>
                <td className="p-2.5 whitespace-nowrap">
                  <Badge kind="muted" size="sm">{r.voucher}</Badge>
                </td>
                {/* An unused column is BLANK, not ₹0 — a "₹0" in the Credit column of a
                    sales row reads as a zero-value credit note. */}
                <td className="p-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                  {r.debit ? rupee(r.debit) : ""}
                </td>
                <td className="p-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                  {r.credit ? rupee(r.credit) : ""}
                </td>
                <td className="p-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                  {rupee(Math.abs(r.balance))}
                  <span className="ml-1 text-ink-3">{r.balanceSide ?? "—"}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-paper-2 font-semibold">
            <tr>
              <td className="p-2.5 font-mono text-ink-3 whitespace-nowrap">{s.period.to}</td>
              <td className="p-2.5 text-ink" colSpan={2}>Closing Balance</td>
              <td className="p-2.5 text-right font-mono tabular-nums whitespace-nowrap">{rupee(s.totalDebit)}</td>
              <td className="p-2.5 text-right font-mono tabular-nums whitespace-nowrap">{rupee(s.totalCredit)}</td>
              <td className="p-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                {rupee(Math.abs(s.closingBalance))}
                <span className="ml-1 text-ink-3">{s.closingSide ?? "—"}</span>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="px-3 py-2 text-xs text-ink-3 border-t border-hairline flex items-center gap-1.5">
        <Icon name="info" size={12} />
        {s.kind === "customer"
          ? "Dr = owed to you · Cr = held on their behalf. Void invoices are excluded — a void document was never issued."
          : "Cr = owed to the vendor · Dr = paid ahead. Purchase orders are excluded: nothing is owed until a bill arrives."}
      </p>
    </Card>
  );
}

export default function LedgerPage() {
  return (
    /* A skeleton rather than null: the fallback is what a customer with a slow connection
       actually sees, and a blank screen reads as a broken link. */
    <React.Suspense fallback={<div className="p-4 md:p-6 lg:p-8"><Skeleton className="h-8 w-48" /></div>}>
      <LedgerPageInner />
    </React.Suspense>
  );
}
