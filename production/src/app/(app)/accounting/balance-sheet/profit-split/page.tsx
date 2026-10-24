"use client";

/**
 * R-1849 — Accounting → Balance Sheet → Partners → Year-end profit split (Partnership / LLP).
 *
 * The person types the deed's terms per partner (interest %, remuneration for the year, working
 * partner or not); lib/accounting/partner-appropriation.ts works out what the law allows
 * (interest ≤ 12%, remuneration ≤ the s.40(b)(v) / s.35(e)(iii) limit on book profit), the rest
 * by ratio, and TDS (194T / 393(3)). "Post the split" is one database call that checks it all
 * again; "Undo" is one call too. Stacked rows, no wide table — fits 375px.
 */
import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useComplianceProfile } from "@/lib/compliance/profile";
import { useFirmPartners } from "@/lib/queries/partners";
import { showsPartnersRegister } from "@/lib/accounting/partners";
import { useOwnerEquityMovements } from "@/lib/queries/owner-equity";
import { useOpeningBalances } from "@/lib/queries/balance-sheet";
import { usePnL } from "@/lib/queries/pnl";
import { reportProfit } from "@/lib/accounting/pnl-assemble";
import { istToday, fyStartYear, fyLabelOfYear } from "@/lib/dates/ist";
import {
  partnerAppropriation, capitalAtFyStart, remunerationRule, interestSection, partnerTdsRule,
  MAX_PARTNER_INTEREST_PCT, type DeedTerms,
} from "@/lib/accounting/partner-appropriation";
import {
  usePartnerAppropriations, usePostPartnerAppropriation, useUndoPartnerAppropriation, type PostedSplitDetail,
} from "@/lib/queries/partner-appropriations";
import { PARTNERS_HREF } from "@/components/features/partners/partner-picker";
import { fmtBS } from "../format";

const MONEY_ROLES = ["owner", "manager", "accountant"];
const FY = (y: number) => `FY ${fyLabelOfYear(y)}`;

export default function ProfitSplitPage() {
  const today = istToday();
  const thisFy = fyStartYear(today);
  const [fy, setFy] = React.useState(thisFy - 1);

  const me = useCurrentUser();
  const canPost = MONEY_ROLES.includes(me.data?.role ?? "");
  const profileQ = useComplianceProfile();
  const isFirm = showsPartnersRegister(profileQ.data?.businessType ?? null);
  const partnersQ = useFirmPartners(isFirm);
  const movementsQ = useOwnerEquityMovements(isFirm);
  const openingQ = useOpeningBalances();
  const splitsQ = usePartnerAppropriations(isFirm);
  const pnl = usePnL({ from: `${fy}-04-01`, to: `${fy + 1}-03-31` }, isFirm);

  const splits = React.useMemo(() => splitsQ.data ?? [], [splitsQ.data]);
  const posted = splits.find((s) => s.fyStart === fy) ?? null;
  const fyChoices = React.useMemo(() => {
    const ys = new Set<number>([thisFy, thisFy - 1, thisFy - 2, ...splits.map((s) => s.fyStart)]);
    return [...ys].sort((a, b) => b - a);
  }, [thisFy, splits]);

  const loading = me.isPending || profileQ.isPending || (isFirm && (partnersQ.isLoading || movementsQ.isLoading || openingQ.isLoading || splitsQ.isLoading));
  const failedQ = [partnersQ, movementsQ, openingQ, splitsQ].find((q) => q.isError);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            <Link href="/accounting/balance-sheet" className="hover:underline">Balance Sheet</Link> · Partners
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Year-end profit split</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Interest on capital and remuneration as your partnership deed says — within the income-tax limits — then the rest by the profit-sharing ratio.
          </p>
        </div>
        {isFirm && (
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <span>Year</span>
            <select value={fy} onChange={(e) => setFy(Number(e.target.value))} aria-label="Financial year"
              className="rounded-md border border-hairline bg-paper px-2 py-1.5 text-sm text-ink">
              {fyChoices.map((y) => <option key={y} value={y}>{FY(y)}{splits.some((s) => s.fyStart === y) ? " · split posted" : ""}</option>)}
            </select>
          </label>
        )}
      </div>

      {loading ? (
        <Card className="p-5"><Skeleton className="h-6 w-1/2 mb-3" /><Skeleton className="h-24 w-full" /></Card>
      ) : !isFirm ? (
        <Card className="p-5 text-sm text-ink-2">
          The profit split is for a <b>Partnership</b> or <b>LLP</b>. Your business type is set to something else.{" "}
          <Link href={"/settings?tab=company" as never} className="text-indigo underline">Check the business type</Link>
        </Card>
      ) : failedQ ? (
        <LoadError what="The partners and their capital" error={failedQ.error} onRetry={() => void failedQ.refetch()} />
      ) : posted ? (
        <PostedView split={posted} partners={partnersQ.data ?? []} canUndo={canPost} isLatest={!splits.some((s) => s.fyStart > fy)} />
      ) : (
        <SplitForm
          key={fy}
          fy={fy}
          today={today}
          netProfit={pnl.data ? reportProfit(pnl.data) : null}
          pnlError={pnl.isError ? pnl.error : null}
          onRetryPnl={() => void pnl.refetch()}
          partners={partnersQ.data ?? []}
          movements={movementsQ.data ?? []}
          openingAsOf={openingQ.data?.asOf ?? null}
          earlier={splits.filter((s) => s.fyStart < fy)}
          canPost={canPost}
        />
      )}
    </div>
  );
}

function SplitForm({ fy, today, netProfit, pnlError, onRetryPnl, partners, movements, openingAsOf, earlier, canPost }: {
  fy: number;
  today: string;
  netProfit: number | null;
  pnlError: unknown;
  onRetryPnl: () => void;
  partners: NonNullable<ReturnType<typeof useFirmPartners>["data"]>;
  movements: NonNullable<ReturnType<typeof useOwnerEquityMovements>["data"]>;
  openingAsOf: string | null;
  earlier: PostedSplitDetail[];
  canPost: boolean;
}) {
  const post = usePostPartnerAppropriation();
  const confirm = useConfirm();
  const last = earlier.at(-1) ?? null;

  /* The deed's terms, typed. Start from last year's split if there is one. */
  const [terms, setTerms] = React.useState<Record<string, { interestPct: string; remuneration: string; working: boolean }>>(() =>
    Object.fromEntries(partners.map((p) => {
      const prev = last?.lines.find((l) => l.partnerId === p.id);
      return [p.id, { interestPct: prev ? String(prev.deedInterestPct) : "", remuneration: prev ? String(prev.deedRemuneration) : "", working: prev ? prev.working : true }];
    })));
  const set = (id: string, patch: Partial<{ interestPct: string; remuneration: string; working: boolean }>) =>
    setTerms((t) => ({ ...t, [id]: { ...(t[id] ?? { interestPct: "", remuneration: "", working: true }), ...patch } }));

  const apPartners = React.useMemo(() => partners.map((p) => ({
    id: p.id, name: p.name, sharePct: Number(p.profit_share_pct), joinedOn: p.joined_on, leftOn: p.left_on, pan: p.pan,
    capitalBase: capitalAtFyStart({
      fyStart: fy, contribution: Number(p.capital_contribution) || 0, openingAsOf,
      movements: movements.filter((m) => m.partner_id === p.id),
      earlierPostedNet: earlier.filter((s) => !(openingAsOf && s.postedOn <= openingAsOf))
        .reduce((t, s) => t + s.lines.filter((l) => l.partnerId === p.id).reduce((u, l) => u + l.interest + l.remuneration + l.profitShare - l.tds, 0), 0),
    }),
  })), [partners, movements, openingAsOf, earlier, fy]);

  const num = (s: string) => { const n = Number(String(s).replace(/[,\s₹%]/g, "")); return Number.isFinite(n) && n >= 0 ? n : 0; };
  const deed: Record<string, DeedTerms> = Object.fromEntries(Object.entries(terms).map(([id, t]) =>
    [id, { interestPct: num(t.interestPct), remuneration: Math.round(num(t.remuneration)), working: t.working }]));
  const a = partnerAppropriation({ fyStart: fy, netProfit, partners: apPartners, terms: deed, today });
  const rule = remunerationRule(fy);
  const iSec = interestSection(fy);
  const tdsRule = partnerTdsRule(fy);

  async function onPost() {
    const ok = await confirm({
      title: `Post the profit split for ${FY(fy)}?`,
      body: `Interest ${fmtBS(a.interestTotal)}, remuneration ${fmtBS(a.remunerationTotal)} and shares ${fmtBS(a.residual)} go to the partners' capital accounts on 31 Mar ${fy + 1}${a.tdsTotal > 0 ? `; TDS ${fmtBS(a.tdsTotal)} goes to TDS payable` : ""}. You can undo it later.`,
      confirmLabel: "Post the split",
    });
    if (ok) post.mutate(a);
  }

  if (pnlError) return <LoadError what="The year's profit" error={pnlError} onRetry={onRetryPnl} />;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-3 min-w-0">
        {a.lines.length === 0 && (
          <Card className="p-4 text-sm text-ink-2">
            No partners in the firm during {FY(fy)}. <Link href={PARTNERS_HREF as never} className="text-indigo underline">Add partners</Link>
          </Card>
        )}
        {a.lines.map((l) => {
          const t = terms[l.partnerId] ?? { interestPct: "", remuneration: "", working: true };
          return (
            <Card key={l.partnerId} className="p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-medium text-ink break-words min-w-0">{l.name}</h2>
                <span className="text-xs text-ink-3 shrink-0">{l.sharePct}% share</span>
              </div>
              <p className="text-xs text-ink-3">Capital on 1 Apr {fy}: {fmtBS(l.capitalBase)}{l.interestDays < 365 ? ` · in the firm ${l.interestDays} days` : ""}</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <label className="text-xs text-ink-2">
                  Interest on capital (deed, % a year)
                  <Input inputMode="decimal" value={t.interestPct} placeholder="e.g. 12" aria-label={`Interest % for ${l.name}`}
                    onChange={(e) => set(l.partnerId, { interestPct: e.target.value })} className="mt-1" />
                </label>
                <label className="text-xs text-ink-2">
                  Remuneration for the year (deed, ₹)
                  <Input inputMode="numeric" value={t.remuneration} placeholder="e.g. 500000" aria-label={`Remuneration for ${l.name}`}
                    onChange={(e) => set(l.partnerId, { remuneration: e.target.value })} className="mt-1" />
                </label>
                <label className="flex items-center gap-2 text-xs text-ink-2 sm:mt-5">
                  <input type="checkbox" checked={t.working} onChange={(e) => set(l.partnerId, { working: e.target.checked })}
                    className="h-4 w-4 accent-indigo" />
                  Working partner
                </label>
              </div>
              <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-xs">
                <Fig k="Interest" v={l.interest} note={l.interestCapped ? `${MAX_PARTNER_INTEREST_PCT}% used` : undefined} />
                <Fig k="Remuneration" v={l.remuneration} note={l.remuneration < (l.working ? l.deedRemuneration : 0) ? "cut to the limit" : undefined} />
                <Fig k="Share of profit" v={l.profitShare} />
                <Fig k={tdsRule ? "TDS" : "TDS (none before FY 2025-26)"} v={-l.tds} />
              </dl>
              <p className="mt-2 text-sm flex justify-between gap-3 border-t border-hairline pt-2">
                <span className="text-ink-2">To {l.name}&apos;s capital account</span>
                <span className="tabular-nums font-medium">{fmtBS(l.net)}</span>
              </p>
            </Card>
          );
        })}
      </div>

      <Card className="p-4 h-fit lg:sticky lg:top-4">
        <h2 className="font-medium text-ink">{FY(fy)} — the split</h2>
        <dl className="mt-2 space-y-1 text-sm">
          <Row k={<Link href={"/accounting/pnl" as never} className="underline">Net profit (P&amp;L)</Link>} v={netProfit} />
          <Row k="− Interest on capital" v={-a.interestTotal} />
          <Row k="= Book profit" v={netProfit === null ? null : a.bookProfit} strong />
          <Row k="Remuneration the law allows" v={a.maxRemuneration} muted />
          <Row k="− Remuneration" v={-a.remunerationTotal} />
          <Row k="= Shared by ratio" v={netProfit === null ? null : a.residual} strong />
          {a.tdsTotal > 0 && <Row k="TDS to deposit" v={a.tdsTotal} muted />}
        </dl>

        {a.remunerationOver > 0 && (
          <p role="alert" className="mt-3 rounded-md bg-rose-soft px-3 py-2 text-xs text-rose-ink">
            Remuneration in the deed is {fmtBS(a.remunerationAsked)}, but only {fmtBS(a.maxRemuneration)} is allowed on this profit — {fmtBS(a.remunerationOver)} would not be accepted as an expense for income tax. Each partner&apos;s remuneration is cut in proportion.
          </p>
        )}
        {a.warnings.filter((w) => !w.startsWith("Remuneration in the deed")).map((w) => (
          <p key={w} className="mt-2 rounded-md bg-amber-soft px-3 py-2 text-xs text-amber-ink">{w}</p>
        ))}
        {a.blockers.map((b) => (
          <p key={b} className="mt-2 rounded-md bg-paper-2 px-3 py-2 text-xs text-ink-2">{b}</p>
        ))}

        {canPost ? (
          <Button variant="primary" className="mt-3 w-full" onClick={onPost} disabled={a.blockers.length > 0 || post.isPending} loading={post.isPending}>
            Post the split for {FY(fy)}
          </Button>
        ) : (
          <p className="mt-3 text-xs text-ink-3">Only an owner, manager or accountant can post the split.</p>
        )}

        <p className="mt-3 text-3xs text-ink-3 leading-relaxed">
          Limits: interest up to {MAX_PARTNER_INTEREST_PCT}% simple a year ({iSec.section}); remuneration to working partners on the first {fmtBS(rule.firstSlab)} of book profit {fmtBS(rule.floor)} or {rule.firstPct}%, whichever is more, and {rule.balancePct}% of the rest ({rule.section}).
          {tdsRule ? ` TDS ${tdsRule.ratePct}% on a partner's interest + remuneration above ${fmtBS(tdsRule.threshold)} (${tdsRule.section}).` : ""}{" "}
          <a href={rule.source} target="_blank" rel="noreferrer" className="underline">Source</a>
        </p>
      </Card>
    </div>
  );
}

function PostedView({ split, partners, canUndo, isLatest }: {
  split: PostedSplitDetail;
  partners: NonNullable<ReturnType<typeof useFirmPartners>["data"]>;
  canUndo: boolean;
  isLatest: boolean;
}) {
  const undo = useUndoPartnerAppropriation();
  const confirm = useConfirm();
  const name = (id: string) => partners.find((p) => p.id === id)?.name ?? "Partner";
  async function onUndo() {
    const ok = await confirm({
      title: `Undo the profit split for ${FY(split.fyStart)}?`,
      body: `The interest, remuneration, shares and TDS posted on 31 Mar ${split.fyStart + 1} are taken back from the partners' capital accounts. If you have already deposited the TDS, the challan stays.`,
      confirmLabel: "Undo the split", danger: true,
    });
    if (ok) undo.mutate(split.fyStart);
  }
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-3 min-w-0">
        {split.lines.map((l) => (
          <Card key={l.partnerId} className="p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-medium text-ink break-words min-w-0">{name(l.partnerId)}</h2>
              <span className="text-xs text-ink-3 shrink-0">{l.sharePct}% share</span>
            </div>
            <dl className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-xs">
              <Fig k={`Interest (${l.interestPct}%)`} v={l.interest} />
              <Fig k="Remuneration" v={l.remuneration} />
              <Fig k="Share of profit" v={l.profitShare} />
              <Fig k={l.tdsSection ? `TDS (s.${l.tdsSection})` : "TDS"} v={-l.tds} />
            </dl>
            <p className="mt-2 text-sm flex justify-between gap-3 border-t border-hairline pt-2">
              <span className="text-ink-2">To the capital account</span>
              <span className="tabular-nums font-medium">{fmtBS(l.interest + l.remuneration + l.profitShare - l.tds)}</span>
            </p>
          </Card>
        ))}
      </div>
      <Card className="p-4 h-fit">
        <h2 className="font-medium text-ink">{FY(split.fyStart)} — posted on 31 Mar {split.fyStart + 1}</h2>
        <dl className="mt-2 space-y-1 text-sm">
          <Row k="Net profit (P&L)" v={split.netProfit} />
          <Row k="− Interest on capital" v={-split.interestTotal} />
          <Row k="= Book profit" v={split.bookProfit} strong />
          <Row k="Remuneration the law allowed" v={split.maxRemuneration} muted />
          <Row k="− Remuneration" v={-split.remunerationTotal} />
          <Row k="= Shared by ratio" v={split.residual} strong />
          {split.tdsTotal > 0 && <Row k="TDS to deposit" v={split.tdsTotal} muted />}
        </dl>
        <Link href={"/accounting/balance-sheet" as never} className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-indigo px-3 py-2 text-sm font-medium text-white hover:opacity-90">
          See the partners&apos; capital accounts
        </Link>
        {canUndo && (
          isLatest ? (
            <Button variant="ghost" className="mt-2 w-full" onClick={onUndo} disabled={undo.isPending} loading={undo.isPending}>Undo this split</Button>
          ) : (
            <p className="mt-2 text-xs text-ink-3">A later year is split too — undo that one first to undo this one.</p>
          )
        )}
      </Card>
    </div>
  );
}

function Fig({ k, v, note }: { k: string; v: number; note?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-3">{k}</dt>
      <dd className="tabular-nums text-ink">{fmtBS(v)}{note ? <span className="block text-3xs text-amber-ink">{note}</span> : null}</dd>
    </div>
  );
}

function Row({ k, v, strong, muted }: { k: React.ReactNode; v: number | null; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-semibold text-ink border-t border-hairline pt-1" : muted ? "text-ink-3" : "text-ink-2"}`}>
      <dt className="min-w-0">{k}</dt>
      <dd className="tabular-nums shrink-0">{v === null ? "…" : fmtBS(v)}</dd>
    </div>
  );
}
