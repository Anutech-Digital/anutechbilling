/**
 * Ad accounts (live) — /marketing/ads
 *
 * Google Ads and Meta Ads spend as the platforms report it, campaign by campaign, day by
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, cn, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import {
  PLATFORM_LABEL, PLATFORM_CHANNEL, totalsOf, campaignStats, pacing, reconcileMonths, dailySeries, adCsvRows, AD_CSV_HEADERS,
  type AdPlatform,
} from "@/lib/marketing/ad-platforms";
import { useAdsStatus, useAdSpend, useBookedAdSpendByMonth, useLeadsByCampaign, useAdSyncRuns, useAdsSync, useToggleAdAccount, type AdsStatus } from "@/lib/queries/ads";
import { useMarketingTools } from "@/lib/queries/marketing-hub";
import { istToday, addDaysISO } from "@/lib/dates/ist";

type Range = 7 | 30 | 90;
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
  nodevtoken: { ok: false, text: "Google connected, but GOOGLE_ADS_DEVELOPER_TOKEN is not set — accounts cannot be read." },
  noaccounts: { ok: false, text: "This login has no ad account — connect with the email that runs your ads." },
  badstate: { ok: false, text: "The sign-in expired — connect again." },
  notconfigured: { ok: false, text: "App keys are not set." },
  error: { ok: false, text: "Could not connect — try again." },
};

export default function AdPlatformsPage() {
  const status = useAdsStatus();
  const sync = useAdsSync();
  const toggle = useToggleAdAccount();
  const tools = useMarketingTools();
  const [range, setRange] = React.useState<Range>(30);
  const [pf, setPf] = React.useState<PlatformFilter>("all");
  const [why, setWhy] = React.useState<string | null>(null);

  React.useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    for (const key of ["google", "meta"]) {
      const v = q.get(key); if (!v) continue;
      const m = MSG[v]; if (m) (m.ok ? toast.success : toast.error)(`${key === "google" ? "Google Ads" : "Meta Ads"}: ${m.text}`);
    }
    if (q.get("why")) setWhy(q.get("why"));
    if (q.get("google") || q.get("meta")) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const today = todayIso();
  const fromDay = addDays(today, -400);
  const spend = useAdSpend(fromDay);
  const booked = useBookedAdSpendByMonth(addDays(today, -400));
  const leadsByCampaign = useLeadsByCampaign(addDays(today, -(range - 1)));
  const runs = useAdSyncRuns();

  const allRows = React.useMemo(() => spend.data ?? [], [spend.data]);
  const rows = React.useMemo(() => allRows.filter((r) => pf === "all" || r.platform === pf), [allRows, pf]);
  const from = addDays(today, -(range - 1));
  const inRange = React.useMemo(() => rows.filter((r) => r.day >= from && r.day <= today), [rows, from, today]);
  const prevRows = React.useMemo(() => rows.filter((r) => r.day >= addDays(from, -range) && r.day < from), [rows, from, range]);
  const totals = React.useMemo(() => totalsOf(inRange), [inRange]);
  const prev = React.useMemo(() => totalsOf(prevRows), [prevRows]);
  const series = React.useMemo(() => dailySeries(inRange, from, today), [inRange, from, today]);
  const campaigns = React.useMemo(() => campaignStats(inRange, leadsByCampaign.data ?? new Map()), [inRange, leadsByCampaign.data]);

  const budgetFor = (p: AdPlatform): number | null => {
    const t = (tools.data ?? []).find((x) => x.tool_key === p);
    return t && t.monthly_budget > 0 ? t.monthly_budget : null;
  };
  const paceG = pacing(allRows.filter((r) => r.platform === "google-ads"), today, budgetFor("google-ads"));
  const paceM = pacing(allRows.filter((r) => r.platform === "meta-ads"), today, budgetFor("meta-ads"));

  const accounts = status.data?.accounts ?? [];
  const anyConnected = accounts.length > 0;
  const foreign = accounts.filter((a) => a.enabled && a.currency !== "INR");

  const exportCsv = () => downloadCSV(`ad-spend-${from}-${today}.csv`, AD_CSV_HEADERS, adCsvRows(inRange));

  return (
    <div className="mx-auto max-w-[1400px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Ad accounts (live)</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            Google Ads and Facebook / Instagram spend by campaign, pulled from the platforms every night. The books (Spend page) are the
            billed truth, this is the platform's view — both side by side here. ROAS &amp; CAC uses the books.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {anyConnected && (
            <>
              <Button variant="default" icon="download" onClick={exportCsv} disabled={inRange.length === 0}>Export CSV</Button>
              <Button variant="primary" icon="refresh" onClick={() => sync.mutate()} loading={sync.isPending}>{sync.isPending ? "Syncing…" : "Sync now"}</Button>
            </>
          )}
        </div>
      </header>

      {why && <Card className="p-3 border-rose/30 bg-rose-soft/30 text-sm text-ink">{decodeURIComponent(why)}</Card>}

      {status.isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <PlatformCard platform="google-ads" status={status.data} accounts={accounts.filter((a) => a.platform === "google-ads")} onToggle={(id, enabled) => toggle.mutate({ accountId: id, enabled })} />
          <PlatformCard platform="meta-ads" status={status.data} accounts={accounts.filter((a) => a.platform === "meta-ads")} onToggle={(id, enabled) => toggle.mutate({ accountId: id, enabled })} />
        </div>
      )}

      {anyConnected && (
        <>
          {foreign.length > 0 && (
            <p className="text-xs text-amber-ink">{foreign.map((a) => `${a.name} (${a.currency})`).join(", ")} not in INR — the numbers below are in the account's currency.</p>
          )}

          {/* This month's pace */}
          <div className="grid gap-3 md:grid-cols-2">
            {([["google-ads", paceG], ["meta-ads", paceM]] as const).map(([p, pc]) => (
              <Card key={p} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink">{PLATFORM_LABEL[p]} · {pc.month}</p>
                  {pc.verdict === "over" && <Badge kind="danger" size="sm">Over budget</Badge>}
                  {pc.verdict === "on_track" && <Badge kind="success" size="sm">On track</Badge>}
                  {pc.verdict === "under" && <Badge kind="info" size="sm">Well under budget</Badge>}
                  {pc.verdict === "no_budget" && <Link href={"/marketing" as Route} className="text-xs underline text-ink-3">Set a budget →</Link>}
                </div>
                <div className="mt-2 flex items-baseline gap-3 flex-wrap">
                  <span className="font-serif text-3xl text-ink tabular-nums">{rupee(pc.spent)}</span>
                  <span className="text-xs text-ink-3">{pc.daysGone}/{pc.daysInMonth} days · {rupee(pc.dailyRate)}/day · month estimate <b className="text-ink-2">{rupee(pc.projected)}</b>{pc.budget ? ` of ${rupee(pc.budget)} (${pc.projectedPct}%)` : ""}</span>
                </div>
                {pc.budget && (
                  <div className="mt-2 h-2 rounded bg-paper-2 overflow-hidden">
                    <div className={cn("h-full", pc.verdict === "over" ? "bg-rose" : pc.verdict === "under" ? "bg-indigo" : "bg-emerald")} style={{ width: `${Math.min(100, (pc.spent / pc.budget) * 100)}%` }} />
                  </div>
                )}
              </Card>
            ))}
          </div>

          {/* Range KPIs + chart */}
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div>
                <p className="text-sm font-semibold text-ink">Spend &amp; results</p>
                <p className="text-xs text-ink-3">{formatDate(from)} – {formatDate(today)} vs previous {range} days</p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <TabBar value={pf} onChange={(v) => setPf(v as PlatformFilter)} items={[{ id: "all", label: "Dono" }, { id: "google-ads", label: "Google" }, { id: "meta-ads", label: "Meta" }]} />
                <TabBar value={String(range)} onChange={(v) => setRange(Number(v) as Range)} items={[{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }]} />
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <Kpi label="Spend" value={rupee(totals.spend)} change={pct(totals.spend, prev.spend)} />
              <Kpi label="Impressions" value={num(totals.impressions)} change={pct(totals.impressions, prev.impressions)} />
              <Kpi label="Clicks" value={num(totals.clicks)} change={pct(totals.clicks, prev.clicks)} hint={totals.ctr !== null ? `CTR ${totals.ctr}%` : undefined} />
              <Kpi label="Cost / click" value={totals.cpc !== null ? rupee(totals.cpc) : "—"} change={totals.cpc !== null && prev.cpc !== null ? pct(totals.cpc, prev.cpc) : null} invert />
              <Kpi label="Conversions (platform)" value={num(totals.conversions)} change={pct(totals.conversions, prev.conversions)} />
              <Kpi label="Cost / conversion" value={totals.cpa !== null ? rupee(totals.cpa) : "—"} change={totals.cpa !== null && prev.cpa !== null ? pct(totals.cpa, prev.cpa) : null} invert />
            </div>
            {inRange.length > 0 && (
              <div className="h-64 mt-4 -ml-2">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={series}>
                    <CartesianGrid stroke="hsl(var(--hairline))" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" tickFormatter={(d: string) => d.slice(5)} />
                    <YAxis tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" tickFormatter={(v: number) => rupee(v, { compact: true })} />
                    <Tooltip formatter={(v: number, name: string) => [name === "Clicks" ? num(v) : rupee(v), name]} labelFormatter={(d) => formatDate(String(d))} contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--hairline))", background: "hsl(var(--paper))" }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="google" name="Google Ads" stackId="s" fill="hsl(var(--amber))" maxBarSize={28} />
                    <Bar dataKey="meta" name="Meta Ads" stackId="s" fill="hsl(var(--indigo))" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          {/* Campaigns */}
          <Card className="p-0 overflow-hidden">
            <div className="p-4 pb-2">
              <p className="text-sm font-semibold text-ink">Campaigns · last {range} days</p>
              <p className="text-xs text-ink-3">Leads = leads in the app whose utm_campaign matches the campaign name (from Tracking links). Conversions = the platform's own number.</p>
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
                      <tr key={`${c.platform}|${c.campaign_id}`} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                        <td className="p-3"><span className="font-medium text-ink">{c.campaign_name}</span> <Badge kind={c.platform === "google-ads" ? "warning" : "info"} size="sm">{c.platform === "google-ads" ? "Google" : "Meta"}</Badge></td>
                        <td className="p-3 text-right tabular-nums font-serif">{rupee(c.spend)}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{num(c.impressions)}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{num(c.clicks)}{c.ctr !== null && <span className="text-xs text-ink-3"> ({c.ctr}%)</span>}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{c.cpc !== null ? rupee(c.cpc) : "—"}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{num(c.conversions)}</td>
                        <td className="p-3 text-right tabular-nums text-ink-2">{c.leads || "—"}</td>
                        <td className={cn("p-3 text-right tabular-nums", c.cpl !== null ? "text-ink" : "text-ink-3")}>{c.cpl !== null ? rupee(c.cpl) : "—"}</td>
                        <td className="p-3 text-ink-3 whitespace-nowrap">{formatDate(c.lastActive)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Platform vs books */}
          <Card className="p-4">
            <p className="text-sm font-semibold text-ink">Platform vs books · by month</p>
            <p className="text-xs text-ink-3 mb-3">Platform = amount consumed; books = channel-tagged marketing expenses (incl. GST). The reason for any difference is shown alongside.</p>
            <div className="grid gap-4 lg:grid-cols-2">
              {(["google-ads", "meta-ads"] as const).map((p) => {
                const rec = reconcileMonths(allRows.filter((r) => r.platform === p), booked.data?.[PLATFORM_CHANNEL[p]] ?? new Map(), p).slice(0, 6);
                return (
                  <div key={p}>
                    <p className="text-xs font-semibold text-ink-2 mb-1">{PLATFORM_LABEL[p]}</p>
                    {rec.length === 0 ? <p className="text-xs text-ink-3">Nothing yet</p> : (
                      <table className="w-full text-xs">
                        <thead><tr className="text-left text-3xs uppercase tracking-wider text-ink-3"><th className="py-1">Month</th><th className="py-1 text-right">Platform</th><th className="py-1 text-right">Books</th><th className="py-1 text-right">Difference</th><th className="py-1 pl-2">Reason</th></tr></thead>
                        <tbody>
                          {rec.map((r) => (
                            <tr key={r.month} className="border-t border-hairline">
                              <td className="py-1.5 tabular-nums">{r.month}</td>
                              <td className="py-1.5 text-right tabular-nums">{rupee(r.platform)}</td>
                              <td className="py-1.5 text-right tabular-nums">{rupee(r.books)}</td>
                              <td className={cn("py-1.5 text-right tabular-nums", Math.abs(r.diff) < 1 ? "text-ink-3" : r.diff > 0 ? "text-emerald" : "text-rose")}>{r.diff > 0 ? "+" : ""}{rupee(r.diff)}{r.diffPct !== null ? ` (${r.diffPct > 0 ? "+" : ""}${r.diffPct}%)` : ""}</td>
                              <td className="py-1.5 pl-2 text-ink-3">{r.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-ink-3 mt-3"><Link href={"/marketing/spend" as Route} className="underline">Spend page</Link>: book or tag expenses · <Link href={"/accounting/prepaid" as Route} className="underline">Prepaid</Link>: draw down the Facebook advance.</p>
          </Card>

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
    </div>
  );
}

function pct(cur: number, prev: number): number | null { return prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null; }

function Kpi({ label, value, change, hint, invert }: { label: string; value: string; change: number | null; hint?: string; invert?: boolean }) {
  const good = change !== null && (invert ? change < 0 : change > 0);
  const bad = change !== null && (invert ? change > 0 : change < 0);
  return (
    <div className="rounded-md border border-hairline p-3">
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</p>
      <p className="font-serif text-2xl text-ink mt-1 tabular-nums">{value}</p>
      <p className="text-xs mt-0.5">
        {change === null ? <span className="text-ink-3">{hint ?? "pichhla period 0"}</span> : (
          <><span className={cn("font-semibold", good ? "text-emerald" : bad ? "text-rose" : "text-ink-3")}>{change > 0 ? "+" : ""}{change}%</span>{hint && <span className="text-ink-3"> · {hint}</span>}</>
        )}
      </p>
    </div>
  );
}

function PlatformCard({ platform, status, accounts, onToggle }: { platform: AdPlatform; status?: AdsStatus; accounts: AdsStatus["accounts"]; onToggle: (id: string, enabled: boolean) => void }) {
  const isG = platform === "google-ads";
  const configured = isG ? status?.google.configured : status?.meta.configured;
  const connected = isG ? status?.google.connected : status?.meta.connected;
  const connectHref = isG ? "/api/integrations/google-ads/connect" : "/api/integrations/meta-ads/connect";
  const expiry = !isG ? status?.meta.tokenExpiresAt : null;
  const expiringSoon = expiry ? Date.parse(expiry) - Date.now() < 7 * 86_400_000 : false;
  const setupNote = isG
    ? (!configured ? "Google OAuth keys are not set." : !status?.google.devToken ? "GOOGLE_ADS_DEVELOPER_TOKEN is not set (Ads manager account → API Center)." : null)
    : (!configured ? "META_APP_ID / META_APP_SECRET are not set (Meta app with Marketing API, ads_read)." : null);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink inline-flex items-center gap-2">
            {PLATFORM_LABEL[platform]}
            {connected ? <Badge kind="success" size="sm">Connected</Badge> : configured ? <Badge kind="warning" size="sm">Connect</Badge> : <Badge kind="muted" size="sm">Setup</Badge>}
            {expiringSoon && <Badge kind="danger" size="sm">Token expires {formatDate(expiry!)}</Badge>}
          </p>
          <p className="text-xs text-ink-3 mt-0.5">{setupNote ?? (isG && status?.google.email ? status.google.email : connected ? `${accounts.length} account` : "Connect with the login that runs your ads.")}</p>
          {isG && status?.google.lastError && <p className="text-xs text-rose-ink mt-1">{status.google.lastError}</p>}
        </div>
        {configured && (!isG || status?.google.devToken) ? (
          <Button asChild size="sm" variant={connected ? "outline" : "primary"}><a href={connectHref}>{connected ? "Reconnect" : "Connect"}</a></Button>
        ) : <Button size="sm" variant="ghost" disabled>Setup</Button>}
      </div>
      {accounts.length > 0 && (
        <ul className="mt-3 divide-y divide-hairline">
          {accounts.map((a) => (
            <li key={a.id} className="py-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-ink truncate">{a.name} <span className="text-xs text-ink-3 font-mono">{a.account_id}</span> <span className="text-xs text-ink-3">{a.currency}</span></p>
                <p className="text-xs text-ink-3">{a.last_synced_at ? `synced ${formatDate(a.last_synced_at)}` : "not synced yet"}{a.last_error ? <span className="text-rose-ink"> · {a.last_error}</span> : ""}</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-ink-3 shrink-0">
                <Switch checked={a.enabled} onCheckedChange={(v) => onToggle(a.id, v)} aria-label={`Sync ${a.name}`} /> sync
              </label>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
