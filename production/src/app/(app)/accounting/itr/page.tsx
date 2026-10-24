/**
 * ITR-Ready Pack — company ke Income Tax Return ki taiyari, ek screen par.
 *
 * Ye page ITR FILE NAHI karta, aur ye baat screen par sabse upar likhi hai:
 * company ka return (ITR-6) sirf incometax.gov.in par, audit aur DSC ke baad
 * jata hai. Ye page wo sab jodta hai jiske liye CA ghanton maangta hai —
 * P&L, computation, dono regime ka tax-andaza, advance-tax schedule, TDS —
 * aur utni hi zor se wo bhi dikhata hai jo app ke paas NAHI hai (gaps),
 * kyunki aadha sach poore jhooth se kam khatarnak nahi hota (1 Sep 2026 ko
 * live tenant par TDS ₹4.13L darj tha aur invoices shunya — us din "tax ₹0"
 * dikhana jhooth hota).
 *
 * File hone ka record compliance_log me jata hai (obligation `it_itr6`,
 * period = FY key) — wahi jagah jo Compliance Calendar padhta hai, nayi
 * table nahi.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import { useItrPack } from "@/lib/queries/itr";
import { useComplianceLog, toFiledMap, useMarkComplianceFiled, useUnmarkComplianceFiled } from "@/lib/queries/compliance";
import { currentFinancialYear, type ItrPack } from "@/lib/tax/itr";
import { fyLabelOfYear } from "@/lib/dates/ist";
import { itrCsvRows, ITR_CSV_HEADERS } from "@/lib/tax/itr-export";

const ITR_OBLIGATION_KEY = "it_itr6";

/** Aaj IST me — FY chunav aur "kitne din bache" dono isi se. */
function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(date) - Date.parse(today)) / 86_400_000);
}

export default function ItrPage() {
  const today = istToday();
  const nowFy = currentFinancialYear(new Date());
  /* Default: pichhla FY — wahi hai jo file hona hai. Chalta hua FY advance
     tax ke liye ek click par. */
  const [fyYear, setFyYear] = React.useState(nowFy.startYear - 1);
  const { data: pack, isLoading, isError, refetch } = useItrPack(fyYear);
  const { data: log } = useComplianceLog();
  const filedMap = toFiledMap(log);

  const fyChoices = [nowFy.startYear - 2, nowFy.startYear - 1, nowFy.startYear];

  return (
    <div className="mx-auto max-w-[1240px] space-y-4 p-4 md:p-6 lg:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl text-ink">Income Tax (ITR) — preparation</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-3">
            This computation is an ESTIMATE, not an assessment — depreciation comes from the asset register (IT Act
            WDV); your CA adds disallowances and the audit. The return itself is filed on incometax.gov.in with a DSC; this pack cuts that
            work from hours to minutes.
          </p>
        </div>
        <div className="flex gap-2" role="group" aria-label="Financial year">
          {fyChoices.map((y) => (
            <button
              key={y}
              type="button"
              aria-pressed={fyYear === y}
              onClick={() => setFyYear(y)}
              className={
                fyYear === y
                  ? "rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-paper"
                  : "rounded-full border border-hairline bg-paper px-3 py-1.5 text-xs text-ink-2 hover:border-hairline-strong"
              }
            >
              FY {fyLabelOfYear(y)}
              {y === nowFy.startYear ? " (current)" : ""}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}
      {/* R-270: the shared error state, with a retry instead of "reload the page". */}
      {isError && <LoadError what="ITR figures" onRetry={() => { void refetch(); }} />}

      {pack && (
        <PackView
          pack={pack}
          today={today}
          filedOn={filedMap.get(`${ITR_OBLIGATION_KEY}|${pack.fy.fiscalKey}`) ?? null}
        />
      )}
    </div>
  );
}

function PackView({ pack, today, filedOn }: { pack: ItrPack; today: string; filedOn: string | null }) {
  const dueIn = daysUntil(pack.fy.itrDue, today);
  const incomeLines = pack.pnl.filter((l) => l.kind === "income");
  const expenseLines = pack.pnl.filter((l) => l.kind === "expense");

  const exportCsv = () => {
    downloadCSV(
      `itr-pack-${pack.fy.fiscalKey}.csv`,
      [...ITR_CSV_HEADERS],
      itrCsvRows(pack),
    );
  };

  return (
    <div className="space-y-4">
      {/* ── Due / filed status ─────────────────────────────────────── */}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Icon name="calendar" className="h-5 w-5 text-ink-3" />
          <div>
            <div className="text-sm font-medium text-ink">
              Return for {pack.fy.label} ({pack.fy.assessmentYear}) — due {formatDate(pack.fy.itrDue)}
            </div>
            <div className="text-xs text-ink-3">
              Due date for a company under audit (Section 139(1)) · filing late means a fee of up to ₹5,000 (234F) and losing the loss carry-forward
            </div>
          </div>
        </div>
        {filedOn ? (
          <Badge kind="success">Filed — {formatDate(filedOn)}</Badge>
        ) : dueIn < 0 ? (
          <Badge kind="danger">{Math.abs(dueIn)} days LATE</Badge>
        ) : (
          <Badge kind={dueIn <= 30 ? "warning" : "muted"}>{dueIn} days left</Badge>
        )}
      </Card>

      {/* ── GAPS — computation se PEHLE, kyunki ye usse zyada sach hain ── */}
      {pack.gaps.length > 0 && (
        <Card className="border-amber bg-amber-soft/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-ink">
            <Icon name="alert" className="h-4 w-4" />
            What the app does NOT have — the figures below are incomplete without it
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-2">
            {pack.gaps.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── P&L (jaisa darj hai) ─────────────────────────────────── */}
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-medium text-ink">P&amp;L — as recorded in the app</h2>
          <table className="w-full text-sm">
            <tbody>
              {incomeLines.map((l) => (
                <PnlRow key={l.label} label={l.label} source={l.source} count={l.count} amount={l.amount} />
              ))}
              {expenseLines.map((l) => (
                <PnlRow key={l.label} label={l.label} source={l.source} count={l.count} amount={-l.amount} />
              ))}
              <tr className="border-t border-hairline-strong">
                <td className="py-2 font-medium text-ink">Book profit</td>
                <td className={`py-2 text-right font-serif text-lg ${pack.bookProfit < 0 ? "text-rose-ink" : "text-ink"}`}>
                  {rupee(pack.bookProfit)}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-xs text-ink-3">Taxable income (rounded per Section 288A; ₹0 for a loss)</td>
                <td className="py-1 text-right text-xs text-ink-2">{rupee(pack.taxableIncome)}</td>
              </tr>
            </tbody>
          </table>
        </Card>

        {/* ── Tax estimate — dono regime ───────────────────────────── */}
        <Card className="p-4">
          <h2 className="mb-3 text-sm font-medium text-ink">Tax estimate — both regimes, your CA chooses</h2>
          {pack.estimates.length === 0 ? (
            <p className="text-sm text-ink-3">
              {pack.bookProfit < 0
                ? "Loss — no tax is due. But the loss can be carried forward ONLY if the return is filed on time."
                : "Taxable income is zero."}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {pack.estimates.map((e) => {
                const cheaper = pack.cheaperEstimate?.regime === e.regime;
                return (
                  <div
                    key={e.regime}
                    className={`rounded-lg border p-3 ${cheaper ? "border-emerald bg-emerald-soft/30" : "border-hairline"}`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-ink">{e.regimeLabel}</span>
                      {cheaper && <Badge kind="success" size="sm">lower</Badge>}
                    </div>
                    <dl className="space-y-1 text-xs text-ink-2">
                      <Row k={`Tax @ ${e.ratePct}%`} v={rupee(e.baseTax)} />
                      <Row k="Surcharge" v={rupee(e.surcharge)} />
                      <Row k="Cess 4%" v={rupee(e.cess)} />
                    </dl>
                    <div className="mt-2 border-t border-hairline pt-2 text-right font-serif text-lg text-ink">
                      {rupee(e.total)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-3 space-y-1 text-xs text-ink-3">
            <div className="flex justify-between">
              <span>TDS receivable ({pack.sources.tdsCount} {pack.sources.tdsCount === 1 ? "entry" : "entries"}) —{" "}
                <Link href="/accounting/tds-receivable/year-end" className="underline">reconcile here</Link>
              </span>
              <span className="text-ink-2">− {rupee(pack.sources.tdsCredit)}</span>
            </div>
            <div className="flex justify-between font-medium text-ink">
              <span>Net payable (on the lower regime)</span>
              <span>{rupee(pack.netPayableAfterTds)}</span>
            </div>
          </div>
        </Card>
      </div>

      {/* ── Advance tax ──────────────────────────────────────────────── */}
      <Card className="p-4">
        <h2 className="mb-1 text-sm font-medium text-ink">Advance tax — four instalments (Section 211)</h2>
        {!pack.advanceTaxRequired ? (
          <p className="text-sm text-ink-3">
            Not required — net payable after TDS is under ₹10,000 (Section 208).
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-ink-3">
              Based on the lower-regime estimate · paying late or short attracts interest under Section 234B/C
            </p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {pack.advanceTaxSchedule.map((i) => {
                const past = i.dueDate < today;
                const next = !past && pack.advanceTaxSchedule.find((x) => x.dueDate >= today)?.dueDate === i.dueDate;
                return (
                  <div
                    key={i.dueDate}
                    className={`rounded-lg border p-3 ${next ? "border-amber bg-amber-soft/40" : "border-hairline"} ${past ? "opacity-60" : ""}`}
                  >
                    <div className="text-xs text-ink-3">
                      {i.label} · up to {i.cumulativePct}%
                      {next && <Badge kind="warning" size="sm" className="ml-1.5">next</Badge>}
                    </div>
                    <div className="mt-1 font-serif text-lg text-ink">{rupee(i.cumulativeDue)}</div>
                    <div className="text-xs text-ink-3">{formatDate(i.dueDate)}{past ? " · passed" : ""}</div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Card>

      {/* ── Actions ─────────────────────────────────────────────────── */}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={exportCsv} icon="download">
            Download CA pack (CSV)
          </Button>
          <Link href="/compliance/income-tax" className="text-xs text-ink-3 underline">
            View in Compliance calendar
          </Link>
        </div>
        <FiledControl fy={pack.fy.fiscalKey} fyLabel={pack.fy.label} due={pack.fy.itrDue} filedOn={filedOn} today={today} />
      </Card>
    </div>
  );
}

function PnlRow({ label, source, count, amount }: { label: string; source: string; count: number; amount: number }) {
  return (
    <tr className="border-b border-hairline last:border-0">
      <td className="py-2">
        <div className="text-ink-2">{label}</div>
        <div className="text-xs text-ink-3">
          {source} · {count} row{count === 1 ? "" : "s"}
        </div>
      </td>
      <td className={`py-2 text-right tabular-nums ${amount < 0 ? "text-ink-2" : "text-ink"}`}>
        {rupee(amount)}
      </td>
    </tr>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt>{k}</dt>
      <dd className="tabular-nums text-ink">{v}</dd>
    </div>
  );
}

/**
 * "File ho gaya" ka record — compliance_log me, acknowledgment number ke
 * saath (`reference`). Wahi row Compliance Calendar par bhi dikhti hai.
 */
function FiledControl({ fy, fyLabel, due, filedOn, today }: {
  fy: string; fyLabel: string; due: string; filedOn: string | null; today: string;
}) {
  const mark = useMarkComplianceFiled();
  const unmark = useUnmarkComplianceFiled();
  const [ack, setAck] = React.useState("");

  if (filedOn) {
    return (
      <div className="flex items-center gap-2">
        <Badge kind="success">Filed {formatDate(filedOn)}</Badge>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => unmark.mutate({ obligation_key: ITR_OBLIGATION_KEY, period_key: fy })}
          disabled={unmark.isPending}
        >
          Marked by mistake? Undo
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        mark.mutate({
          obligation_key: ITR_OBLIGATION_KEY,
          period_key: fy,
          period_label: fyLabel,
          due_date: due,
          filed_date: today,
          reference: ack.trim() || null,
        });
      }}
    >
      <label htmlFor="itr-ack" className="text-xs text-ink-3">
        Filed? Acknowledgment no.
      </label>
      <Input
        id="itr-ack"
        value={ack}
        onChange={(e) => setAck(e.target.value)}
        placeholder="15-digit number from the portal"
        className="h-8 w-56 text-xs"
      />
      <Button type="submit" variant="outline" size="sm" disabled={mark.isPending}>
        Mark as filed
      </Button>
    </form>
  );
}
