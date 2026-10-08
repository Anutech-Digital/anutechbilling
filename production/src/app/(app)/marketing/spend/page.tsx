/**
 * Marketing & Advertising spend — /marketing/spend
 *
 * Pardeep, 26 Sep 2026: one place to run both heads — how much went on Marketing, how
 * much on Advertising, through which channel, to whom — and to fix what is untagged
 * without leaving the page. ROAS & CAC (/marketing/reports) answers whether the spend
 * paid; this page is the spend itself. The arithmetic is in lib/marketing/spend-summary.ts,
 * where it is tested; this file only lays it out.
 *
 * One page with a Marketing | Advertising filter rather than two pages: both heads come
 * from the same expense rows and share channels (Google is SEO AND ads), so the useful
 * view is the two side by side.
 */
"use client";

import * as React from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { AddExpenseDialog } from "@/components/features/accounting/add-expense-dialog";
import { rupee, cn, formatDate } from "@/lib/utils";
import { AD_CHANNELS, isMarketingCategory } from "@/lib/marketing/ad-channels";
import { summariseSpend, headOf, channelLabel, type SpendHead } from "@/lib/marketing/spend-summary";
import { useMarketingSpend, type RangeKey } from "@/lib/queries/marketing";
import { useUpdateExpense, type Expense } from "@/lib/queries/expenses";
import { useCampaignOptions } from "@/lib/queries/marketing-campaigns";
import { usePrepaidAdvances, type PrepaidAdvance } from "@/lib/queries/prepaid-advances";
import Link from "next/link";

const RANGES: TabBarItem[] = [
  { id: "this_month",   label: "This month" },
  { id: "last_quarter", label: "Last 3 months" },
  { id: "ytd",          label: "This FY" },
  { id: "all",          label: "All time" },
];

type HeadFilter = "all" | "Marketing" | "Advertising";
const HEADS: TabBarItem[] = [
  { id: "all",         label: "All" },
  { id: "Marketing",   label: "Marketing" },
  { id: "Advertising", label: "Advertising" },
];

const HEAD_COLOR: Record<SpendHead, string> = {
  Advertising: "hsl(var(--amber))",
  Marketing:   "hsl(var(--indigo))",
  Other:       "hsl(var(--ink-3))",
};

export default function MarketingSpendPage() {
  const [range, setRange] = React.useState<RangeKey>("ytd");
  const [head, setHead] = React.useState<HeadFilter>("all");
  const [onlyUntagged, setOnlyUntagged] = React.useState(false);
  const [adding, setAdding] = React.useState<"Marketing" | "Advertising" | null>(null);
  const [editing, setEditing] = React.useState<Expense | null>(null);
  const { data, isLoading, error } = useMarketingSpend(range);

  const rows = React.useMemo(
    () => (data?.rows ?? []).filter((r) => head === "all" || headOf(r.category) === head),
    [data, head],
  );
  const all = React.useMemo(() => summariseSpend(data?.rows ?? []), [data]);
  const s = React.useMemo(() => summariseSpend(rows), [rows]);
  const listed = onlyUntagged ? rows.filter((r) => !r.channel) : rows;
  const advances = usePrepaidAdvances();
  const openAdvances = React.useMemo(
    () => (advances.data ?? []).filter((a) => a.balance > 0 && isMarketingCategory(a.category)
      && (head === "all" || headOf(a.category) === head)),
    [advances.data, head],
  );

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Spend</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            <b className="text-ink-2">Advertising</b> = money paid to show ads (Google / Facebook / LinkedIn ads, newspaper, hoardings).{" "}
            <b className="text-ink-2">Marketing</b> = other brand work (SEO, branding, campaign tools, content).
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" icon="plus" onClick={() => setAdding("Marketing")}>Marketing expense</Button>
          <Button size="sm" icon="plus" onClick={() => setAdding("Advertising")}>Advertising expense</Button>
        </div>
      </header>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <TabBar items={RANGES} value={range} onChange={(v) => setRange(v as RangeKey)} />
        <TabBar items={HEADS} value={head} onChange={(v) => setHead(v as HeadFilter)} />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : error ? (
        <Card className="py-2">
          <EmptyState icon="alert" title="Could not load spend" body={(error as Error).message} />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Metric label="Total spend" value={rupee(all.total)} sub={`${(data?.rows ?? []).length} entries · incl. GST`} />
            <Metric label="Advertising" value={rupee(all.byHead.Advertising)} sub={share(all.byHead.Advertising, all.total)} tone="Advertising" />
            <Metric label="Marketing" value={rupee(all.byHead.Marketing)} sub={share(all.byHead.Marketing, all.total) + (all.byHead.Other ? ` · plus ${rupee(all.byHead.Other)} in other marketing categories` : "")} tone="Marketing" />
            <Metric
              label="No channel set"
              value={rupee(all.untagged.amount)}
              sub={all.untagged.count === 0
                ? "Every entry has a channel — ROAS & CAC counts it all."
                : `${all.untagged.count} ${all.untagged.count === 1 ? "entry" : "entries"} not counted in ROAS & CAC. Set a channel below.`}
              warn={all.untagged.count > 0}
            />
          </div>

          <AdvancesCard advances={openAdvances} />

          {(data?.rows ?? []).length === 0 ? (
            <Card className="py-2">
              <EmptyState icon="chart" title="No Marketing / Advertising spend in this period"
                body="Add spend with the buttons above, or change the date range. Expenses in the Marketing or Advertising category show up here." />
            </Card>
          ) : (
            <>
              <MonthlyChart monthly={s.monthly} head={head} />
              <div className="grid gap-4 lg:grid-cols-2">
                <ChannelBreakdown s={s} head={head} />
                <VendorBreakdown s={s} />
              </div>
              <EntriesTable
                rows={listed}
                total={rows.length}
                onlyUntagged={onlyUntagged}
                setOnlyUntagged={setOnlyUntagged}
                untaggedCount={s.untagged.count}
                onEdit={setEditing}
              />
            </>
          )}
        </>
      )}

      {adding && <AddExpenseDialog defaultCategory={adding} onClose={() => setAdding(null)} />}
      {editing && <AddExpenseDialog expense={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/**
 * Money already handed to an ad platform (Facebook, Google…) and not yet used.
 *
 * Not spend: the top-up is an asset until the platform's month-end invoice is booked
 * against it on the Prepaid page — that invoice is the expense counted above. Shown here
 * so the whole Facebook story sits on one page: given, used, left.
 */
function AdvancesCard({ advances }: { advances: PrepaidAdvance[] }) {
  if (advances.length === 0) return null;
  const byVendor = new Map<string, { vendor: string; balance: number; channel: string | null }>();
  for (const a of advances) {
    const k = a.vendor_name.trim().toLowerCase();
    const v = byVendor.get(k) ?? { vendor: a.vendor_name.trim(), balance: 0, channel: a.channel ?? null };
    v.balance += a.balance;
    byVendor.set(k, v);
  }
  const list = [...byVendor.values()].sort((x, y) => y.balance - x.balance);
  const total = list.reduce((t, v) => t + v.balance, 0);
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Advance balance (held by platforms)</p>
          <p className="font-serif text-2xl leading-none text-ink">{rupee(total)}</p>
          <p className="text-xs text-ink-2 mt-2 max-w-xl leading-relaxed">
            Money paid in advance — not spend yet. When the platform's month-end invoice arrives,
            use <b>Book invoice</b> on Prepaid; that amount is added to spend above and this balance goes down.
          </p>
        </div>
        <Link href="/accounting/prepaid" className="text-sm font-medium text-amber-ink hover:underline whitespace-nowrap">
          Book invoice →
        </Link>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {list.map((v) => (
          <div key={v.vendor} className="rounded-lg border border-hairline bg-paper-2/40 px-3 py-2 text-sm">
            <span className="font-medium text-ink">{v.vendor}</span>
            <span className="text-ink-3"> · {channelLabel(v.channel)}</span>
            <div className="text-xs text-ink-2 mt-0.5 tabular-nums">{rupee(v.balance)} left</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}% of kul` : "—";
}

function Metric({ label, value, sub, tone, warn }: {
  label: string; value: string; sub?: string; tone?: SpendHead; warn?: boolean;
}) {
  return (
    <Card className={cn("p-4", warn && "border-amber/40 bg-amber-soft/30")}>
      <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5 flex items-center gap-1.5">
        {tone && <span className="inline-block h-2 w-2 rounded-full" style={{ background: HEAD_COLOR[tone] }} />}
        {label}
      </p>
      <p className="font-serif text-2xl leading-none text-ink">{value}</p>
      {sub && <p className="text-xs text-ink-2 mt-2 leading-relaxed">{sub}</p>}
    </Card>
  );
}

function MonthlyChart({ monthly, head }: { monthly: ReturnType<typeof summariseSpend>["monthly"]; head: HeadFilter }) {
  const showOther = head === "all" && monthly.some((m) => m.Other > 0);
  return (
    <Card className="p-4">
      <p className="text-sm font-semibold text-ink mb-3">Spend by month</p>
      <div className="h-64 -ml-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={monthly}>
            <CartesianGrid stroke="hsl(var(--hairline))" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" />
            <YAxis tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))"
                   tickFormatter={(v: number) => rupee(v, { compact: true })} />
            <Tooltip
              formatter={(v: number, name: string) => [rupee(v), name]}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--hairline))", background: "hsl(var(--paper))" }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {head !== "Marketing" && <Bar dataKey="Advertising" stackId="s" fill={HEAD_COLOR.Advertising} maxBarSize={48} />}
            {head !== "Advertising" && <Bar dataKey="Marketing" stackId="s" fill={HEAD_COLOR.Marketing} maxBarSize={48} />}
            {showOther && <Bar dataKey="Other" name="Other marketing" stackId="s" fill={HEAD_COLOR.Other} maxBarSize={48} />}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

const th = "px-3 py-2 text-2xs font-semibold text-ink-3 uppercase tracking-wider";
const td = "px-3 py-2 text-sm";

function ChannelBreakdown({ s, head }: { s: ReturnType<typeof summariseSpend>; head: HeadFilter }) {
  return (
    <Card flush>
      <div className="px-4 pt-4 pb-2">
        <p className="text-sm font-semibold text-ink">By channel</p>
        <p className="text-xs text-ink-3 mt-0.5">How much went through each channel. For leads and ROAS → ROAS &amp; CAC.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-paper-2 border-y border-hairline-strong">
            <tr>
              <th className={cn(th, "text-left")}>Channel</th>
              {head === "all" && <th className={cn(th, "text-right")}>Advertising</th>}
              {head === "all" && <th className={cn(th, "text-right")}>Marketing</th>}
              <th className={cn(th, "text-right")}>Total</th>
            </tr>
          </thead>
          <tbody>
            {s.byChannel.map((c) => (
              <tr key={c.channel ?? "none"} className="border-b border-hairline last:border-0">
                <td className={td}>
                  <span className={cn(!c.channel && "text-amber-ink")}>{c.label}</span>
                  <span className="text-xs text-ink-3"> · {c.count}</span>
                </td>
                {head === "all" && <td className={cn(td, "text-right tabular-nums")}>{c.Advertising ? rupee(c.Advertising) : <span className="text-ink-3">—</span>}</td>}
                {head === "all" && <td className={cn(td, "text-right tabular-nums")}>{c.Marketing + c.Other ? rupee(c.Marketing + c.Other) : <span className="text-ink-3">—</span>}</td>}
                <td className={cn(td, "text-right tabular-nums font-medium")}>{rupee(c.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function VendorBreakdown({ s }: { s: ReturnType<typeof summariseSpend> }) {
  const top = s.byVendor.slice(0, 10);
  return (
    <Card flush>
      <div className="px-4 pt-4 pb-2">
        <p className="text-sm font-semibold text-ink">Paid to (top {top.length})</p>
        <p className="text-xs text-ink-3 mt-0.5">Agency, platform or vendor — largest first.</p>
      </div>
      <table className="w-full">
        <thead className="bg-paper-2 border-y border-hairline-strong">
          <tr>
            <th className={cn(th, "text-left")}>Vendor</th>
            <th className={cn(th, "text-right")}>Entries</th>
            <th className={cn(th, "text-right")}>Total</th>
          </tr>
        </thead>
        <tbody>
          {top.map((v) => (
            <tr key={v.vendor} className="border-b border-hairline last:border-0">
              <td className={td}>{v.vendor}</td>
              <td className={cn(td, "text-right tabular-nums text-ink-3")}>{v.count}</td>
              <td className={cn(td, "text-right tabular-nums font-medium")}>{rupee(v.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function EntriesTable({ rows, total, onlyUntagged, setOnlyUntagged, untaggedCount, onEdit }: {
  rows: Expense[]; total: number; onlyUntagged: boolean; setOnlyUntagged: (v: boolean) => void;
  untaggedCount: number; onEdit: (e: Expense) => void;
}) {
  const update = useUpdateExpense();
  const setChannel = (e: Expense, channel: string) =>
    update.mutate({ id: e.id, patch: { channel: channel === "none" ? null : channel } });
  const campaigns = useCampaignOptions();
  const campOpts = campaigns.data ?? [];
  const setCampaign = (e: Expense, id: string) =>
    update.mutate({ id: e.id, patch: { campaign_id: id === "none" ? null : id } });

  return (
    <Card flush>
      <div className="px-4 pt-4 pb-2 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-ink">All entries</p>
          <p className="text-xs text-ink-3 mt-0.5">Set the channel{campOpts.length ? " and campaign" : ""} right here — it saves instantly. Use Edit for other changes.</p>
        </div>
        {untaggedCount > 0 && (
          <Button variant={onlyUntagged ? "primary" : "outline"} size="sm" onClick={() => setOnlyUntagged(!onlyUntagged)}>
            {onlyUntagged ? `Show all (${total})` : `Only without channel (${untaggedCount})`}
          </Button>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead className="bg-paper-2 border-y border-hairline-strong">
            <tr>
              <th className={cn(th, "text-left")}>Date</th>
              <th className={cn(th, "text-left")}>Paid to / for</th>
              <th className={cn(th, "text-left")}>Head</th>
              <th className={cn(th, "text-left")}>Channel</th>
              {campOpts.length > 0 && <th className={cn(th, "text-left")}>Campaign</th>}
              <th className={cn(th, "text-right")}>Amount</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-ink-3">No entries.</td></tr>
            ) : rows.map((e) => {
              const h = headOf(e.category);
              return (
                <tr key={e.id} className="border-b border-hairline last:border-0">
                  <td className={cn(td, "whitespace-nowrap text-ink-2")}>{formatDate(e.expense_date)}</td>
                  <td className={td}>
                    <div className="font-medium text-ink">{e.vendor_name || <span className="text-ink-3">—</span>}</div>
                    {e.description && <div className="text-xs text-ink-3 truncate max-w-[22rem]">{e.description}</div>}
                  </td>
                  <td className={td}>
                    <Badge kind={h === "Advertising" ? "warning" : h === "Marketing" ? "info" : "muted"} size="sm">
                      {h === "Other" ? e.category : h}
                    </Badge>
                  </td>
                  <td className={td}>
                    <Select value={e.channel ?? "none"} onValueChange={(v) => setChannel(e, v)}>
                      <SelectTrigger className={cn("h-8 w-[200px] text-xs", !e.channel && "border-amber/60 text-amber-ink")} aria-label={`Channel for ${e.vendor_name ?? "entry"}`}>
                        <SelectValue>{channelLabel(e.channel)}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Unknown / general</SelectItem>
                        {AD_CHANNELS.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </td>
                  {campOpts.length > 0 && (
                    <td className={td}>
                      <Select value={e.campaign_id ?? "none"} onValueChange={(v) => setCampaign(e, v)}>
                        <SelectTrigger className="h-8 w-[170px] text-xs" aria-label={`Campaign for ${e.vendor_name ?? "entry"}`}>
                          <SelectValue>{campOpts.find((c) => c.id === e.campaign_id)?.name ?? "—"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No campaign</SelectItem>
                          {campOpts.filter((c) => !c.cancelled || c.id === e.campaign_id).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </td>
                  )}
                  <td className={cn(td, "text-right tabular-nums font-medium")}>{rupee(e.amount)}</td>
                  <td className={cn(td, "text-right")}>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(e)}>Edit</Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
