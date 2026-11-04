/**
 * Ad accounts (live) — /marketing/ads
 *
 * Google Ads, Meta Ads, and LinkedIn Ads spend as the platforms report it, campaign by campaign, day by
 * day, synced nightly (lib/marketing/ad-sync.ts). This month's pace against the budget,
 * each campaign's cost per click / per lead, and the platform number beside what the books
 * say. Arithmetic: lib/marketing/ad-platforms.ts. The books stay the source for ROAS & CAC;
 * this page is where the two are compared.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";
import { ResponsiveContainer, BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, Legend } from "recharts";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError, LoadErrorInline } from "@/components/shared/load-error";
import { rupee, cn, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import {
  PLATFORM_LABEL, PLATFORM_CHANNEL, totalsOf, campaignStats, pacing, reconcileMonths, dailySeries, adCsvRows, AD_CSV_HEADERS,
  type AdPlatform,
} from "@/lib/marketing/ad-platforms";
import { useAdsStatus, useAdSpend, useBookedAdSpendByMonth, useLeadsByCampaign, useAdSyncRuns, useAdsSync, type AdsStatus } from "@/lib/queries/ads";
import { syncAdsWindow } from "@/lib/queries/ads";
import { linkedInHistoryChunks, linkedInOldestDay, linkedInDailyFrom } from "@/lib/marketing/linkedin-history";
import { useBudgets } from "@/lib/queries/marketing-budget";
import { approvedMonthlyBudget, canAskBudget } from "@/lib/marketing-budget/budget";
import { AskBudgetDialog } from "@/components/features/marketing-budget/budget-page";
import { istToday, addDaysISO } from "@/lib/dates/ist";

type Range = "7" | "30" | "90" | "all" | "custom";
type PlatformFilter = "all" | AdPlatform;

function todayIso(): string { return istToday(); }
function addDays(iso: string, n: number): string { return addDaysISO(iso, n); }
const num = (n: number) => n.toLocaleString("en-IN");

const MSG: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Connected — first sync done." },
  connected_scopelost: { ok: false, text: "Connected, but an earlier permission was left unticked on the Google consent screen — check Settings › Integrations." },
  connected_syncfailed: { ok: false, text: "Account connected, but the first sync failed — the reason is shown below." },
  denied: { ok: false, text: "Permission was denied." },
  noscope: { ok: false, text: "The Google Ads checkbox was not ticked — connect again." },
  noaccounts: { ok: false, text: "This login has no ad account — connect with the email that runs your ads." },
  badstate: { ok: false, text: "The sign-in expired — connect again." },
  notconfigured: { ok: false, text: "App keys are not set." },
  role: { ok: false, text: "Only an owner or manager can connect ad accounts." },
  error: { ok: false, text: "Could not connect — try again." },
};

export default function AdPlatformsPage() {
  const status = useAdsStatus();
  const sync = useAdsSync();
  const budgets = useBudgets();
  const [range, setRange] = React.useState<Range>("90");
  const [pf, setPf] = React.useState<PlatformFilter>("all");
  const [selectedAccountId, setSelectedAccountId] = React.useState("all");
  const [budgetPlatform, setBudgetPlatform] = React.useState<AdPlatform | null>(null);
  const [why, setWhy] = React.useState<string | null>(null);
  const [showHistorySync, setShowHistorySync] = React.useState(false);
  const [historyMode, setHistoryMode] = React.useState<"all" | "custom">("all");
  const [historyFrom, setHistoryFrom] = React.useState("");
  const [historyTo, setHistoryTo] = React.useState("");
  const [historyProgress, setHistoryProgress] = React.useState<{ done: number; total: number; rows: number } | null>(null);
  const [historySyncing, setHistorySyncing] = React.useState(false);
  const [customFrom, setCustomFrom] = React.useState("");
  const [customTo, setCustomTo] = React.useState("");

  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const requestedPlatform = q.get("platform");
    if (requestedPlatform === "google-ads" || requestedPlatform === "meta-ads" || requestedPlatform === "linkedin-ads") {
      setPf(requestedPlatform);
    }
    if (q.get("account")) setSelectedAccountId(q.get("account")!);
    for (const key of ["google", "meta", "linkedin"]) {
      const v = q.get(key); if (!v) continue;
      const m = MSG[v]; if (m) (m.ok ? toast.success : toast.error)(`${key === "google" ? "Google Ads" : key === "meta" ? "Meta Ads" : "LinkedIn Ads"}: ${m.text}`);
    }
    if (q.get("why")) setWhy(q.get("why"));
    if (q.get("google") || q.get("meta") || q.get("linkedin")) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const today = todayIso();
  const isPreset = range !== "all" && range !== "custom";
  const presetDays = isPreset ? Number(range) : 0;
  const from = range === "all" ? linkedInOldestDay(today) : range === "custom" ? customFrom || addDays(today, -89) : addDays(today, -(presetDays - 1));
  const to = range === "custom" ? customTo || today : today;
  const historyStart = linkedInOldestDay(today);
  const dailyFrom = linkedInDailyFrom(today);
  const fromDay = from < addDays(today, -400) ? `${from.slice(0, 7)}-01` : addDays(today, -400);
  const spend = useAdSpend(fromDay);
  const booked = useBookedAdSpendByMonth(fromDay);
  const leadsByCampaign = useLeadsByCampaign(from, to);
  const runs = useAdSyncRuns();
  const accounts = status.data?.accounts ?? [];
  const linkedinAccounts = accounts.filter((a) => a.platform === "linkedin-ads");
  const selectableAccounts = accounts.filter((a) => pf === "all" || a.platform === pf);
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  React.useEffect(() => {
    if (status.data && selectedAccountId !== "all" && !status.data.accounts.some((a) => a.id === selectedAccountId)) setSelectedAccountId("all");
  }, [status.data, selectedAccountId]);

  const allRows = React.useMemo(() => spend.data ?? [], [spend.data]);
  const rows = React.useMemo(() => allRows.filter((r) => (pf === "all" || r.platform === pf) && (selectedAccountId === "all" || r.account_id === selectedAccountId)), [allRows, pf, selectedAccountId]);
  const inRange = React.useMemo(() => rows.filter((r) => r.day <= to && (r.day >= from || (r.platform === "linkedin-ads" && r.day < dailyFrom && r.day.slice(0, 7) === from.slice(0, 7)))), [rows, from, to, dailyFrom]);
  const prevRows = React.useMemo(() => isPreset ? rows.filter((r) => r.day >= addDays(from, -presetDays) && r.day < from) : [], [rows, from, isPreset, presetDays]);
  const totals = React.useMemo(() => totalsOf(inRange), [inRange]);
  const prev = React.useMemo(() => totalsOf(prevRows), [prevRows]);
  const longRange = Date.parse(to) - Date.parse(from) > 90 * 86400000;
  const useMonthlySeries = longRange || from < dailyFrom;
  const series = React.useMemo(() => useMonthlySeries ? monthlySeries(inRange) : dailySeries(inRange, from, to), [inRange, from, to, useMonthlySeries]);
  const campaigns = React.useMemo(() => campaignStats(inRange, leadsByCampaign.data ?? new Map()), [inRange, leadsByCampaign.data]);

  const budgetFor = (p: AdPlatform): number | null => approvedMonthlyBudget(budgets.data?.budgets ?? [], p, today.slice(0, 7));
  const pendingFor = (p: AdPlatform): boolean => (budgets.data?.budgets ?? []).some((b) => b.channel === p && b.month.slice(0, 7) === today.slice(0, 7) && b.status === "pending");
  const paceG = pacing(allRows.filter((r) => r.platform === "google-ads" && (selectedAccountId === "all" || r.account_id === selectedAccountId)), today, selectedAccountId === "all" ? budgetFor("google-ads") : null);
  const paceM = pacing(allRows.filter((r) => r.platform === "meta-ads" && (selectedAccountId === "all" || r.account_id === selectedAccountId)), today, selectedAccountId === "all" ? budgetFor("meta-ads") : null);
  const paceL = pacing(allRows.filter((r) => r.platform === "linkedin-ads" && (selectedAccountId === "all" || r.account_id === selectedAccountId)), today, selectedAccountId === "all" ? budgetFor("linkedin-ads") : null);

  const anyConnected = accounts.length > 0 || allRows.length > 0;
  const foreign = accounts.filter((a) => a.enabled && a.currency !== "INR" && (pf === "all" || a.platform === pf) && (selectedAccountId === "all" || a.id === selectedAccountId));
  const comparisonPlatforms = (["google-ads", "meta-ads", "linkedin-ads"] as const).filter((platform) => pf === "all" || pf === platform);
  const monthlyComparisons = comparisonPlatforms.flatMap((adPlatform) =>
    reconcileMonths(allRows.filter((row) => row.platform === adPlatform), booked.data?.[PLATFORM_CHANNEL[adPlatform]] ?? new Map(), adPlatform)
      .slice(0, 6).map((row) => ({ ...row, adPlatform })),
  ).sort((a, b) => b.month.localeCompare(a.month) || a.adPlatform.localeCompare(b.adPlatform));

  const exportCsv = () => downloadCSV(`ad-spend-${from}-${to}.csv`, AD_CSV_HEADERS, adCsvRows(inRange, new Map(accounts.map((a) => [a.id, a.name]))));

  async function syncHistory() {
    const start = historyMode === "all" ? historyStart : historyFrom;
    const end = historyMode === "all" ? today : historyTo;
    let chunks;
    try { chunks = linkedInHistoryChunks(start, end, today); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Choose valid dates."); return; }
    const historyAccountId = selectedAccount?.platform === "linkedin-ads" ? selectedAccount.id : undefined;
    if (historyAccountId && !selectedAccount?.enabled) {
      toast.error("Turn on sync for this LinkedIn account first."); return;
    }
    setHistorySyncing(true);
    setHistoryProgress({ done: 0, total: chunks.length, rows: 0 });
    let written = 0;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const result = await syncAdsWindow({ from: chunks[i].from, to: chunks[i].to, accountId: historyAccountId });
        if (result.errors.length) throw new Error(result.errors[0]);
        if (!result.accounts) throw new Error("No enabled LinkedIn ad account was found for this sync.");
        written += result.rowsWritten;
        setHistoryProgress({ done: i + 1, total: chunks.length, rows: written });
      }
      await Promise.all([spend.refetch(), status.refetch(), runs.refetch()]);
      toast.success(`LinkedIn history synced — ${written} campaign rows.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "LinkedIn history sync failed.");
      await Promise.all([spend.refetch(), status.refetch(), runs.refetch()]);
    } finally { setHistorySyncing(false); }
  }

  return (
    <div className="mx-auto max-w-[1800px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Paid ads performance</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            Google, Facebook / Instagram and LinkedIn spend by campaign, pulled from the platforms every night. The books (Spend page) are the
            billed truth, this is the platform's view — both side by side here. ROAS &amp; CAC uses the books.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {anyConnected && (
            <>
              <Button variant="default" icon="download" onClick={exportCsv} disabled={inRange.length === 0}>Export CSV</Button>
              {accounts.length > 0 && <>
                {status.data?.linkedin.connected && (pf === "all" || pf === "linkedin-ads") && <Button variant="outline" onClick={() => setShowHistorySync((v) => !v)} disabled={historySyncing}>{showHistorySync ? "Hide LinkedIn history" : "Sync LinkedIn history"}</Button>}
                <Button variant="primary" icon="refresh" onClick={() => sync.mutate(selectedAccountId === "all" ? undefined : selectedAccountId)} loading={sync.isPending} disabled={historySyncing || (selectedAccount ? !selectedAccount.enabled : false)}>{sync.isPending ? "Syncing…" : selectedAccount ? "Sync this account" : "Sync all accounts"}</Button>
              </>}
            </>
          )}
        </div>
      </header>

      {showHistorySync && status.data?.linkedin.connected && (
        <Card>
          <div className="space-y-4">
            <div>
              <h2 className="font-semibold text-ink">Sync LinkedIn Ads history</h2>
              <p className="text-sm text-ink-3 mt-1">Fetch campaign-group spend, clicks and impressions for {selectedAccount?.platform === "linkedin-ads" ? selectedAccount.name : "all LinkedIn accounts"}. Keep this page open until the sync finishes. Re-sync older dates to replace the old ad-set-level report.</p>
            </div>
            <TabBar value={historyMode} onChange={(v) => { setHistoryMode(v as "all" | "custom"); setHistoryProgress(null); }} items={[{ id: "all", label: "All available history" }, { id: "custom", label: "Custom dates" }]} />
            {historyMode === "custom" && (
              <div className="grid gap-4 sm:grid-cols-2 max-w-xl">
                <FormField label="From" htmlFor="history-from"><Input id="history-from" type="date" min={historyStart} max={today} value={historyFrom || addDays(today, -365)} onChange={(e) => setHistoryFrom(e.target.value)} /></FormField>
                <FormField label="To" htmlFor="history-to"><Input id="history-to" type="date" min={historyStart} max={today} value={historyTo || today} onChange={(e) => setHistoryTo(e.target.value)} /></FormField>
              </div>
            )}
            <p className="text-xs text-ink-3">LinkedIn keeps standard ad performance for up to 10 years. Older results are synced as full-month totals; recent results are daily. Custom dates in older months include those full months.</p>
            <div className="flex items-center gap-3 flex-wrap">
              <Button variant="primary" onClick={() => void syncHistory()} loading={historySyncing} disabled={sync.isPending}>{historySyncing ? "Syncing history…" : "Start history sync"}</Button>
              {historyProgress && <span role="status" className="text-sm text-ink-3">{historyProgress.done}/{historyProgress.total} date windows · {historyProgress.rows} rows saved</span>}
            </div>
          </div>
        </Card>
      )}

      {why && <Card className="p-3 border-rose/30 bg-rose-soft/30 text-sm text-ink">{why}</Card>}

      {status.isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      ) : status.isError ? (
        <LoadError what="Ad account status" error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            {(["google-ads", "meta-ads", "linkedin-ads"] as const).map((platform) => (
              <PlatformCard key={platform} platform={platform} status={status.data} accounts={accounts.filter((a) => a.platform === platform)} />
            ))}
          </div>
        </>
      )}

      {anyConnected && (
        <>
          {foreign.length > 0 && (
            <p className="text-xs text-amber-ink">{foreign.map((a) => `${a.name} (${a.currency})`).join(", ")} not in INR — the numbers below are in the account's currency.</p>
          )}

          {/* R-1807: a failed spend read is an error + Try again, never "₹0 spent". */}
          {spend.isPending ? (
            <Card><Skeleton className="h-40" /></Card>
          ) : spend.isError ? (
            <LoadError what="Ad spend" error={spend.error} onRetry={() => void spend.refetch()} />
          ) : (<>

          {/* This month's pace */}
          {budgets.isError && <LoadErrorInline what="Approved ad budgets" error={budgets.error} onRetry={() => void budgets.refetch()} />}
          <div className="grid gap-3 md:grid-cols-3">
            {([["google-ads", paceG], ["meta-ads", paceM], ["linkedin-ads", paceL]] as const).filter(([p]) => (pf === "all" || p === pf) && (!selectedAccount || p === selectedAccount.platform)).map(([p, pc]) => (
              <Card key={p} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink">{PLATFORM_LABEL[p]} · {pc.month}</p>
                  {pc.verdict === "over" && <Badge kind="danger" size="sm">Over budget</Badge>}
                  {pc.verdict === "on_track" && <Badge kind="success" size="sm">On track</Badge>}
                  {pc.verdict === "under" && <Badge kind="info" size="sm">Well under budget</Badge>}
                  {!pc.budget && pendingFor(p) && <Badge kind="warning" size="sm">Approval pending</Badge>}
                  {!selectedAccount && canAskBudget(budgets.data?.role) && <button type="button" onClick={() => setBudgetPlatform(p)} aria-label={`Request ${PLATFORM_LABEL[p]} budget`} className="text-xs underline text-ink-3 hover:text-ink">{pc.budget ? "Request more" : "Request budget"} →</button>}
                </div>
                <div className="mt-2 flex items-baseline gap-3 flex-wrap">
                  <span className="font-serif text-3xl text-ink tabular-nums">{rupee(pc.spent)}</span>
                  <span className="text-xs text-ink-3">{pc.daysGone}/{pc.daysInMonth} days · {rupee(pc.dailyRate)}/day · month estimate <b className="text-ink-2">{rupee(pc.projected)}</b>{pc.budget ? ` of ${rupee(pc.budget)} approved (${pc.projectedPct}%)` : ""}</span>
                </div>
                {pc.budget && (
                  <div className="mt-2 h-2 rounded bg-paper-2 overflow-hidden">
                    <div className={cn("h-full", pc.verdict === "over" ? "bg-rose" : pc.verdict === "under" ? "bg-indigo" : "bg-emerald")} style={{ width: `${Math.min(100, (pc.spent / pc.budget) * 100)}%` }} />
                  </div>
                )}
              </Card>
            ))}
          </div>
          <p className="text-xs text-ink-3">The owner approves requests in <Link href={"/marketing/budget" as Route} className="underline">Budget &amp; Payments</Link>. Approved amounts appear here automatically.</p>

          {/* Range KPIs + chart */}
          <Card id="ad-results" className="p-4 scroll-mt-24">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div>
                <p className="text-sm font-semibold text-ink">Spend &amp; results</p>
                <p className="text-xs text-ink-3">{formatDate(from)} – {formatDate(to)}{isPreset ? ` vs previous ${range} days` : ""}</p>
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                <TabBar value={pf} onChange={(v) => { setPf(v as PlatformFilter); setSelectedAccountId("all"); }} items={[{ id: "all", label: "All" }, { id: "google-ads", label: "Google" }, { id: "meta-ads", label: "Meta" }, { id: "linkedin-ads", label: "LinkedIn" }]} />
                {accounts.length > 0 && <label className="flex items-center gap-2 text-xs text-ink-3">Ad account
                  <select aria-label="Ad account" className="rounded-md border border-hairline bg-paper px-2 py-1.5 text-sm text-ink max-w-56" value={selectedAccountId} onChange={(e) => { const id = e.target.value; setSelectedAccountId(id); const account = accounts.find((a) => a.id === id); if (account) setPf(account.platform); }}>
                    <option value="all">{pf === "all" ? "All ad accounts" : `All ${PLATFORM_LABEL[pf]} accounts`}</option>
                    {selectableAccounts.map((a) => <option key={a.id} value={a.id}>{pf === "all" ? `${PLATFORM_LABEL[a.platform]} · ` : ""}{a.name} ({a.account_id})</option>)}
                  </select>
                </label>}
                <TabBar value={range} onChange={(v) => setRange(v as Range)} items={[{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }, { id: "all", label: "All time" }, { id: "custom", label: "Custom" }]} />
              </div>
            </div>
            {range === "custom" && <div className="flex flex-wrap items-end gap-3 mb-4"><FormField label="From" htmlFor="report-from"><Input id="report-from" type="date" min={historyStart} max={to} value={customFrom || addDays(today, -89)} onChange={(e) => setCustomFrom(e.target.value)} /></FormField><FormField label="To" htmlFor="report-to"><Input id="report-to" type="date" min={from} max={today} value={customTo || today} onChange={(e) => setCustomTo(e.target.value)} /></FormField></div>}
            {(range === "all" || range === "custom") && from < dailyFrom && <p className="text-xs text-ink-3 mb-3">Older LinkedIn results are monthly. A custom date inside an older month includes that full month.</p>}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <Kpi label="Spend" value={rupee(totals.spend)} change={pct(totals.spend, prev.spend)} compare={isPreset} />
              <Kpi label="Impressions" value={num(totals.impressions)} change={pct(totals.impressions, prev.impressions)} compare={isPreset} />
              <Kpi label="Clicks" value={num(totals.clicks)} change={pct(totals.clicks, prev.clicks)} compare={isPreset} hint={totals.ctr !== null ? `CTR ${totals.ctr}%` : undefined} />
              <Kpi label="Cost / click" value={totals.cpc !== null ? rupee(totals.cpc) : "—"} change={totals.cpc !== null && prev.cpc !== null ? pct(totals.cpc, prev.cpc) : null} compare={isPreset} invert />
              <Kpi label="Conversions (platform)" value={num(totals.conversions)} change={pct(totals.conversions, prev.conversions)} compare={isPreset} />
              <Kpi label="Cost / conversion" value={totals.cpa !== null ? rupee(totals.cpa) : "—"} change={totals.cpa !== null && prev.cpa !== null ? pct(totals.cpa, prev.cpa) : null} compare={isPreset} invert />
            </div>
            {inRange.length > 0 && (
              <div className="h-64 mt-4 -ml-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series}>
                    <CartesianGrid stroke="hsl(var(--hairline))" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" tickFormatter={(d: string) => useMonthlySeries ? d.slice(0, 7) : d.slice(5)} />
                    <YAxis tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" tickFormatter={(v: number) => rupee(v, { compact: true })} />
                    <Tooltip formatter={(v: number, name: string) => [name === "Clicks" ? num(v) : rupee(v), name]} labelFormatter={(d) => formatDate(String(d))} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--hairline))", background: "hsl(var(--paper))" }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="google" name="Google Ads" stackId="s" fill="hsl(var(--amber))" maxBarSize={28} />
                    <Bar dataKey="meta" name="Meta Ads" stackId="s" fill="hsl(var(--indigo))" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="linkedin" name="LinkedIn Ads" stackId="s" fill="hsl(var(--emerald))" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* Campaigns */}
          <Card className="p-0 overflow-hidden">
            <div className="p-4 pb-2">
              <p className="text-sm font-semibold text-ink">Campaigns · {isPreset ? `last ${range} days` : `${formatDate(from)} – ${formatDate(to)}`}</p>
              <p className="text-xs text-ink-3">LinkedIn rows show Campaign Groups, the top campaign level. Leads match utm_campaign to the name. Conversions are the platform's number.</p>
              {linkedinAccounts.length > 0 && <p className="text-xs text-ink-3 mt-1">For LinkedIn dates synced before this change, use <button type="button" className="underline" onClick={() => setShowHistorySync(true)}>Sync older data</button> to load Campaign Groups.</p>}
            </div>
            {campaigns.length === 0 ? (
              <div className="p-4"><EmptyState icon="target" title="No spend in this range" body="Campaigns appear here after a sync." /></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-paper-2 border-b border-hairline">
                    <tr className="text-left text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                      <th className="p-3">Campaign</th><th className="p-3 text-right">Spend</th><th className="p-3 text-right">Impr.</th><th className="p-3 text-right">Clicks</th><th className="p-3 text-right">CPC</th><th className="p-3 text-right">Conv.</th><th className="p-3 text-right">Leads (app)</th><th className="p-3 text-right">CPL</th><th className="p-3">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => (
                      <tr key={`${c.platform}|${c.account_id}|${c.campaign_id}`} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                        <td className="p-3"><span className="font-medium text-ink">{c.campaign_name}</span> <Badge kind={c.platform === "google-ads" ? "warning" : c.platform === "meta-ads" ? "info" : "success"} size="sm">{c.platform === "google-ads" ? "Google" : c.platform === "meta-ads" ? "Meta" : "LinkedIn"}</Badge><span className="block text-xs text-ink-3">{accounts.find((a) => a.id === c.account_id)?.name ?? "Ad account"}</span></td>
                        <td className="p-3 text-right tabular-nums font-serif">{rupee(c.spend)}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{num(c.impressions)}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{num(c.clicks)}{c.ctr !== null && <span className="text-xs text-ink-3"> ({c.ctr}%)</span>}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{c.cpc !== null ? rupee(c.cpc) : "—"}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{num(c.conversions)}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{c.leads || "—"}</td>
                        <td className={cn("p-3 text-right tabular-nums", c.cpl !== null ? "text-ink" : "text-ink-3")}>{c.cpl !== null ? rupee(c.cpl) : "—"}</td>
                        <td className="p-3 text-ink-3 whitespace-nowrap">{c.platform === "linkedin-ads" && c.lastActive < dailyFrom ? new Date(`${c.lastActive}T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }) : formatDate(c.lastActive)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Ad platform spend against recorded expenses */}
          {selectedAccount && <p className="text-xs text-ink-3">Choose all accounts to compare platform spend with recorded expenses. Expenses are recorded by platform.</p>}
          {!selectedAccount && <Card className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-ink">Ad spend vs recorded expenses</h2>
                <p className="mt-1 max-w-3xl text-sm text-ink-3">Check whether each platform’s monthly ad spend has been recorded as an expense. Difference means recorded expense minus ad spend. GST, prepaid top-ups, and missing entries can explain a gap.</p>
              </div>
              <Link href={"/marketing/reports" as Route} className="text-sm font-medium text-amber-ink hover:underline">See revenue return →</Link>
            </div>
            {booked.isLoading ? <Skeleton className="mt-4 h-40 rounded-md" /> : booked.isError ? (
              <LoadErrorInline what="The booked marketing expenses" error={booked.error} onRetry={() => void booked.refetch()} />
            ) : (
              <div className="mt-4 space-y-4">
                <div className={cn("grid gap-3", comparisonPlatforms.length > 1 && "md:grid-cols-3")}>
                  {comparisonPlatforms.map((platform) => {
                    const latest = monthlyComparisons.find((row) => row.adPlatform === platform);
                    return <div key={platform} className="min-w-0 rounded-md border border-hairline bg-paper p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-ink">{PLATFORM_LABEL[platform]}</p>
                        {latest && <span className="text-xs text-ink-3">{monthLabel(latest.month)}</span>}
                      </div>
                      {latest ? <>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <div><p className="text-xs text-ink-3">Ad platform spent</p><p className="mt-0.5 font-serif text-xl tabular-nums text-ink">{rupee(latest.platform)}</p></div>
                          <div><p className="text-xs text-ink-3">Expense recorded</p><p className="mt-0.5 font-serif text-xl tabular-nums text-ink">{rupee(latest.books)}</p></div>
                        </div>
                        <p className="mt-3 border-t border-hairline pt-3 text-sm font-medium text-ink">Difference: {latest.diff > 0 ? "+" : ""}{rupee(latest.diff)}</p>
                        <p className="mt-1 text-xs leading-relaxed text-ink-3">{latest.note}</p>
                      </> : <p className="mt-3 text-sm text-ink-3">No spend or recorded expenses yet.</p>}
                    </div>;
                  })}
                </div>
                {monthlyComparisons.length > 0 && <details className="rounded-md border border-hairline">
                  <summary className="cursor-pointer select-none p-3 text-sm font-medium text-ink">View monthly comparison ({monthlyComparisons.length})</summary>
                  <div className="overflow-x-auto border-t border-hairline">
                    <table className="min-w-[820px] w-full text-sm">
                      <thead className="bg-paper-2 text-left text-xs text-ink-3"><tr><th className="p-3">Month</th><th className="p-3">Platform</th><th className="p-3 text-right">Ad spend</th><th className="p-3 text-right">Recorded expense</th><th className="p-3 text-right">Difference</th><th className="p-3">What it means</th></tr></thead>
                      <tbody>{monthlyComparisons.map((row) => <tr key={`${row.adPlatform}-${row.month}`} className="border-t border-hairline align-top">
                        <td className="p-3 whitespace-nowrap tabular-nums">{monthLabel(row.month)}</td>
                        <td className="p-3 whitespace-nowrap">{PLATFORM_LABEL[row.adPlatform]}</td>
                        <td className="p-3 text-right whitespace-nowrap tabular-nums">{rupee(row.platform)}</td>
                        <td className="p-3 text-right whitespace-nowrap tabular-nums">{rupee(row.books)}</td>
                        <td className="p-3 text-right whitespace-nowrap tabular-nums">{row.diff > 0 ? "+" : ""}{rupee(row.diff)}</td>
                        <td className="p-3 text-ink-3">{row.note}</td>
                      </tr>)}</tbody>
                    </table>
                  </div>
                </details>}
              </div>
            )}
            <p className="mt-4 text-xs text-ink-3">Need to record an expense? Open <Link href={"/marketing/spend" as Route} className="underline">Marketing Spend</Link>. For prepaid Meta ads, use <Link href={"/accounting/prepaid" as Route} className="underline">Prepaid</Link>.</p>
          </Card>}
          </>)}

          {(runs.data?.length ?? 0) > 0 && (
            <details className="text-xs text-ink-3">
              <summary className="cursor-pointer select-none">Sync history ({runs.data!.length})</summary>
              <ul className="mt-2 space-y-1">
                {runs.data!.map((r) => (
                  <li key={r.id} className="flex flex-wrap gap-x-3">
                    <span className="tabular-nums">{formatDate(r.started_at)}</span><span>{r.trigger}</span>
                    <span className={r.ok === false ? "text-rose-ink" : r.ok ? "text-emerald" : ""}>{r.ok === null ? "running…" : r.ok ? "ok" : "failed"}</span>
                    <span>{r.accounts} accounts · {r.rows_written} rows</span>{r.error && <span className="text-rose-ink">{r.error}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {budgetPlatform && <AskBudgetDialog open onClose={() => setBudgetPlatform(null)} initialChannel={budgetPlatform} />}
    </div>
  );
}

function pct(cur: number, prev: number): number | null { return prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null; }
function monthLabel(month: string): string { return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }); }

function monthlySeries(rows: readonly import("@/lib/marketing/ad-platforms").AdSpendRow[]): ReturnType<typeof dailySeries> {
  const byMonth = new Map<string, ReturnType<typeof dailySeries>[number]>();
  for (const row of rows) {
    const day = `${row.day.slice(0, 7)}-01`;
    const point = byMonth.get(day) ?? { day, google: 0, meta: 0, linkedin: 0, clicks: 0, conversions: 0 };
    if (row.platform === "google-ads") point.google += row.spend;
    else if (row.platform === "meta-ads") point.meta += row.spend;
    else point.linkedin += row.spend;
    point.clicks += row.clicks;
    point.conversions += row.conversions;
    byMonth.set(day, point);
  }
  return [...byMonth.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function Kpi({ label, value, change, hint, invert, compare }: { label: string; value: string; change: number | null; hint?: string; invert?: boolean; compare?: boolean }) {
  const good = change !== null && (invert ? change < 0 : change > 0);
  const bad = change !== null && (invert ? change > 0 : change < 0);
  return (
    <div className="rounded-md border border-hairline p-3">
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</p>
      <p className="font-serif text-2xl text-ink mt-1 tabular-nums">{value}</p>
      {(compare || hint) && <p className="text-xs mt-0.5">
        {!compare ? <span className="text-ink-3">{hint}</span> : change === null ? <span className="text-ink-3">{hint ?? "No previous data"}</span> : (
          <><span className={cn("font-semibold", good ? "text-emerald" : bad ? "text-rose" : "text-ink-3")}>{change > 0 ? "+" : ""}{change}%</span>{hint && <span className="text-ink-3"> · {hint}</span>}</>
        )}
      </p>}
    </div>
  );
}

function PlatformCard({ platform, status, accounts }: { platform: AdPlatform; status?: AdsStatus; accounts: AdsStatus["accounts"] }) {
  const isG = platform === "google-ads";
  const isMeta = platform === "meta-ads";
  const configured = isG ? status?.google.configured : isMeta ? status?.meta.configured : status?.linkedin.configured;
  const connected = accounts.length > 0;
  const googleNeedsAccess = isG && connected && accounts.length === 0 && Boolean(status?.google.lastError);
  const expiry = isMeta ? status?.meta.tokenExpiresAt : platform === "linkedin-ads" ? status?.linkedin.tokenExpiresAt : null;
  const expired = expiry ? Date.parse(expiry) <= Date.now() : false;
  const expiringSoon = expiry ? !expired && Date.parse(expiry) - Date.now() < 7 * 86_400_000 : false;
  const syncingCount = accounts.filter((account) => account.enabled).length;
  const pausedCount = accounts.length - syncingCount;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink inline-flex items-center gap-2">
            {PLATFORM_LABEL[platform]}
            {expired ? <Badge kind="danger" size="sm">Token expired</Badge> : googleNeedsAccess ? <Badge kind="danger" size="sm">Needs API access</Badge> : connected ? <Badge kind="success" size="sm">Connected</Badge> : configured ? <Badge kind="warning" size="sm">Connect</Badge> : <Badge kind="muted" size="sm">Setup</Badge>}
            {expiringSoon && <Badge kind="danger" size="sm">Token expires {formatDate(expiry!)}</Badge>}
          </p>
          <p className="text-xs text-ink-3 mt-0.5">{accounts.length} {accounts.length === 1 ? "account" : "accounts"} · {syncingCount} syncing{pausedCount ? ` · ${pausedCount} paused` : ""}</p>
          {isG && status?.google.email && accounts.length > 0 && <p className="text-xs text-ink-3 mt-1 truncate">Connected as {status.google.email}</p>}
          {isG && status?.google.lastError && <p className="text-xs text-rose-ink mt-1">{status.google.lastError}</p>}
        </div>
        <Button asChild size="sm" variant="outline"><Link href={`/marketing/ads/accounts?platform=${platform}` as Route}>View accounts</Link></Button>
      </div>
    </Card>
  );
}
