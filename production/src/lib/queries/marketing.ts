/**
 * Marketing reporting — the query layer for /marketing/reports.
 *
 * Assembles the inputs `lib/marketing/channel-economics.ts` needs, plus the
 * monthly spend-vs-revenue series and the conversion funnel. No metric is
 * computed here beyond counting; the judgement about which numbers are safe to
 * show lives in the pure module, where it is tested.
 *
 * ─── DEGRADES BEFORE MIGRATION 0232 ──────────────────────────────────────────
 * `expenses.channel` arrives with 0232, which is written but not applied. Until
 * it is, the spend read fails, and this returns a stated gap rather than taking
 * the page down. Measured 13 Aug 2026: the column does not exist yet.
 *
 * ─── THE FUNNEL STARTS AT LEADS, NOT CLICKS ──────────────────────────────────
 * The brief asks for Clicks → Leads → Quotes → Won. Nothing in this app records
 * a click: there is no ad-platform integration and no click table. So the Clicks
 * step is returned with `available: false` and a reason, not as a zero. A funnel
 * whose first step reads 0 tells an executive that no one clicked, which is a
 * different and much worse claim than "we do not measure clicks yet".
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  channelReport, type ChannelReport, type ChannelLeadInput, type ChannelSpendInput,
} from "@/lib/marketing/channel-economics";
import { isMarketingCategory } from "@/lib/marketing/ad-channels";
import { channelFor, EMPTY_UTM } from "@/lib/marketing/utm";
import type { Expense } from "@/lib/queries/expenses";
import { fetchPaidLeadIds } from "@/lib/payments/won-paid";

export type RangeKey = "this_month" | "last_quarter" | "ytd" | "all";

export interface DateRange { start: string; end: string; label: string }

/** Indian fiscal year starts 1 April — YTD means the FY, not the calendar year. */
export function resolveRange(key: RangeKey, now: Date = new Date()): DateRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();               // 0-11
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const end = iso(new Date(Date.UTC(y, m + 1, 1)));

  switch (key) {
    case "this_month":
      return { start: iso(new Date(Date.UTC(y, m, 1))), end, label: "This month" };
    case "last_quarter":
      return { start: iso(new Date(Date.UTC(y, m - 3, 1))), end, label: "Last 3 months" };
    case "ytd": {
      // FY starts 1 Apr. Before April, the FY began in the previous calendar year.
      const fyStartYear = m >= 3 ? y : y - 1;
      return { start: `${fyStartYear}-04-01`, end, label: `FY ${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}` };
    }
    case "all":
    default:
      return { start: "1970-01-01", end, label: "All time" };
  }
}

export interface FunnelStep {
  key: string;
  label: string;
  /** Count, or null when the step is not measured at all. */
  count: number | null;
  /** false = no data source exists for this step. */
  available: boolean;
  /** Conversion from the previous AVAILABLE step, 0…1. */
  conversion: number | null;
  /** Target conversion for the bottleneck alert. */
  benchmark: number | null;
  /** True when conversion is measured and below benchmark. */
  bottleneck: boolean;
  note: string | null;
}

/**
 * Default benchmarks for the drop-off alert.
 *
 * Starting points for Indian B2B SaaS reselling, NOT industry law — they exist so
 * the alert has a threshold at all, and they should be tuned against this
 * tenant's own history once there is more than one month of it.
 */
export const FUNNEL_BENCHMARKS = { leadToQuote: 0.4, quoteToWon: 0.25 };

export interface MonthPoint {
  month: string;        // 'YYYY-MM'
  spend: number;
  revenue: number;
}

export interface MarketingReport {
  range: DateRange;
  report: ChannelReport;
  funnel: FunnelStep[];
  monthly: MonthPoint[];
  /** Total revenue collected in the range (payments), not won-lead value. */
  collected: number;
  /** Of `collected`, the part from project (custom software) receipts. */
  projectCollected: number;
  /** Data gaps to render. Never swallowed. */
  gaps: string[];
}

export function useMarketingReport(rangeKey: RangeKey = "ytd") {
  const range = resolveRange(rangeKey);

  return useQuery({
    queryKey: ["marketing-report", rangeKey],
    queryFn: async (): Promise<MarketingReport> => {
      const supabase = createClient();
      const gaps: string[] = [];

      // ── Leads (attribution substrate) ────────────────────────────────────
      // `utm_source` is preferred when present (migration 0232 onward); the
      // form's own `source` tag is the fallback, which is all 61 existing leads
      // have. Selected together so both generations of lead work.
      const leadsQ = await supabase
        .from("leads")
        .select("id, project_id, source, stage, value, created_at, utm_source, utm_medium, utm_campaign, referrer_url")
        .gte("created_at", range.start)
        .lt("created_at", range.end);
      if (leadsQ.error) throw leadsQ.error;

      /* The comment above said utm_source was preferred; the code read `source` alone, so a
         lead from a Facebook tracking link counted as "enquiry-form" (the form's own tag)
         and never met the Facebook spend. channelFor applies the stated order: utm_source,
         then the referrer host, then the form's source (Pardeep, 26 Sep 2026). */
      /* R-375: won value (and so ROAS) counts only won leads with a recorded payment —
         accept_quote marks a lead won before any money arrives. */
      const paidIds = await fetchPaidLeadIds(supabase, (leadsQ.data ?? []).filter((l) => l.stage === "won"));
      const leads: ChannelLeadInput[] = (leadsQ.data ?? []).map((l) => ({
        source: channelFor({ ...EMPTY_UTM, utm_source: l.utm_source, utm_medium: l.utm_medium,
                             utm_campaign: l.utm_campaign, referrer_url: l.referrer_url }, l.source),
        stage: l.stage, value: l.value, paid: paidIds.has(l.id),
      }));

      // ── Ad spend, per channel, from `expenses` ───────────────────────────
      // Deliberately NOT from a separate ad-spend table: these are the rows the
      // accountant reconciles against the bank, so CAC can never disagree with
      // the accounts. See migration 0232's header for the full argument.
      let spend: ChannelSpendInput[] = [];
      const spendQ = await supabase
        .from("expenses")
        .select("channel, amount, expense_date, category, vendor_name")
        .gte("expense_date", range.start)
        .lt("expense_date", range.end);

      if (spendQ.error) {
        gaps.push(
          "Ad spend cannot be read by channel yet — migration 0232 adds `expenses.channel`. "
          + "Apply it, then tag each marketing expense with its channel."
        );
      } else {
        const rows = (spendQ.data ?? []) as {
          channel: string | null; amount: number | null;
          category: string | null; vendor_name: string | null;
        }[];
        const marketing = rows.filter((r) => /market|advert|ads/i.test(r.category ?? ""));
        const untagged = marketing.filter((r) => !r.channel);
        spend = marketing
          .filter((r) => r.channel)
          .map((r) => ({ channel: r.channel as string, rupees: r.amount ?? 0 }));

        if (untagged.length > 0) {
          const rupees = untagged.reduce((s, r) => s + (r.amount ?? 0), 0);
          gaps.push(
            `${untagged.length} marketing ${untagged.length === 1 ? "expense" : "expenses"} `
            + `(₹${rupees.toLocaleString("en-IN")}) have no channel tag, so they are excluded from `
            + `CAC and ROAS. Tag them in Expenses to bring them in.`
          );
        }
      }

      // ── Platform-reported spend beside the books (migration 20260927260000) ──
      // The books stay the source above; this only NAMES a disagreement, so a month whose
      // Google invoice is not booked yet does not silently read as "CAC improved".
      {
        const [{ data: accs }, { data: daily }] = await Promise.all([
          supabase.from("ad_accounts").select("id, platform"),
          supabase.from("ad_spend_daily").select("ad_account_id, spend").gte("day", range.start).lt("day", range.end),
        ]);
        const platformOf = new Map((accs ?? []).map((a) => [a.id, a.platform as string]));
        const reported = new Map<string, number>();
        for (const r of daily ?? []) { const p = platformOf.get(r.ad_account_id); if (p) reported.set(p, (reported.get(p) ?? 0) + Number(r.spend)); }
        for (const [p, plat] of reported) {
          const booked = spend.filter((x) => x.channel === p).reduce((a, x) => a + x.rupees, 0);
          const label = p === "google-ads" ? "Google Ads" : "Meta Ads";
          if (plat > 0 && (booked === 0 || Math.abs(booked - plat) / plat > 0.25)) {
            gaps.push(`${label} ne is range mein ₹${Math.round(plat).toLocaleString("en-IN")} kharcha report kiya, books mein ₹${Math.round(booked).toLocaleString("en-IN")} tagged hai — CAC books se hai; farq Ad accounts (live) page par mahine-wise dekho.`);
          }
        }
      }
      // ── Revenue actually collected, and the monthly series ───────────────
      const payQ = await supabase
        .from("payments")
        .select("amount, received_at, status")
        .eq("status", "received")
        .gte("received_at", range.start)
        .lt("received_at", range.end);
      if (payQ.error) throw payQ.error;

      /* Project (custom software) receipts live in `project_payments`, not `payments` —
         reading only the latter showed ₹0 collected while a ₹59L project was being paid
         (Pardeep, 26 Sep 2026). TDS rows count: the customer paid that part to the
         government on our behalf, and it is ours as a 26AS credit. */
      const projQ = await supabase
        .from("project_payments")
        .select("amount, received_at, project_id")
        .gte("received_at", range.start)
        .lt("received_at", range.end);
      if (projQ.error) throw projQ.error;

      const receipts = [
        ...(payQ.data ?? []).map((p) => ({ amount: p.amount ?? 0, received_at: p.received_at })),
        ...(projQ.data ?? []).map((p) => ({ amount: p.amount ?? 0, received_at: p.received_at })),
      ];
      const collected = receipts.reduce((s, p) => s + p.amount, 0);
      const projectCollected = (projQ.data ?? []).reduce((s, p) => s + (p.amount ?? 0), 0);

      const byMonth = new Map<string, MonthPoint>();
      const touch = (month: string): MonthPoint => {
        let p = byMonth.get(month);
        if (!p) { p = { month, spend: 0, revenue: 0 }; byMonth.set(month, p); }
        return p;
      };
      for (const p of receipts) {
        const mth = (p.received_at ?? "").slice(0, 7);
        if (mth) touch(mth).revenue += p.amount;
      }
      if (!spendQ.error) {
        for (const r of (spendQ.data ?? []) as { expense_date: string | null; amount: number | null; category: string | null }[]) {
          if (!/market|advert|ads/i.test(r.category ?? "")) continue;
          const mth = (r.expense_date ?? "").slice(0, 7);
          if (mth) touch(mth).spend += r.amount ?? 0;
        }
      }
      const monthly = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
      if (monthly.length < 2) {
        gaps.push(
          `Only ${monthly.length} month of data in this range — a spend-versus-revenue trend needs `
          + `at least two months before the shape means anything.`
        );
      }

      // ── Funnel ───────────────────────────────────────────────────────────
      const quotesQ = await supabase
        .from("quotes")
        .select("id, created_at")
        .gte("created_at", range.start)
        .lt("created_at", range.end);
      if (quotesQ.error) throw quotesQ.error;

      /* A project quotation lives on `project_sales`, not `quotes` — counting only the latter
         showed a won ₹59L software deal as 0 quotes and 0 deals (Pardeep, 26 Sep 2026).
         Anything past draft was sent to the customer, including one later cancelled. */
      const projQuotesQ = await supabase
        .from("project_sales")
        .select("id, status, created_at")
        .neq("status", "draft")
        .gte("created_at", range.start)
        .lt("created_at", range.end);
      if (projQuotesQ.error) throw projQuotesQ.error;

      const leadCount = leads.length;
      const quoteCount = (quotesQ.data ?? []).length + (projQuotesQ.data ?? []).length;
      /* A project paid in two instalments is one deal, so projects count once each. */
      const paidProjects = new Set((projQ.data ?? []).map((p) => p.project_id).filter(Boolean));
      const wonCount = (payQ.data ?? []).length + paidProjects.size;

      const l2q = leadCount > 0 ? quoteCount / leadCount : null;
      const q2w = quoteCount > 0 ? wonCount / quoteCount : null;

      const funnel: FunnelStep[] = [
        {
          key: "clicks", label: "Ad clicks", count: null, available: false,
          conversion: null, benchmark: null, bottleneck: false,
          note: "Not measured — no ad-platform integration records clicks. Shown as unavailable rather than zero, "
              + "because zero would claim nobody clicked.",
        },
        {
          key: "leads", label: "Leads captured", count: leadCount, available: true,
          conversion: null, benchmark: null, bottleneck: false, note: null,
        },
        {
          key: "quotes", label: "Quotes sent", count: quoteCount, available: true,
          conversion: l2q, benchmark: FUNNEL_BENCHMARKS.leadToQuote,
          bottleneck: l2q !== null && l2q < FUNNEL_BENCHMARKS.leadToQuote,
          note: null,
        },
        {
          key: "won", label: "Deals won (paid)", count: wonCount, available: true,
          conversion: q2w, benchmark: FUNNEL_BENCHMARKS.quoteToWon,
          bottleneck: q2w !== null && q2w < FUNNEL_BENCHMARKS.quoteToWon,
          note: null,
        },
      ];

      return {
        range,
        report: channelReport(leads, spend),
        funnel,
        monthly,
        collected,
        projectCollected,
        gaps,
      };
    },
    staleTime: 60_000,
  });
}

/** CSV for the channel leaderboard. Kept here so the page stays presentational. */
export function channelsToCsv(report: ChannelReport, range: DateRange): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const pct = (v: number | null) => (v === null ? "" : (v * 100).toFixed(1));

  const lines: string[] = [];
  lines.push(`Marketing channel report,${esc(range.label)},${range.start} to ${range.end}`);
  lines.push("");
  lines.push([
    "Channel", "Attributable", "Leads", "Won", "Lost", "Open",
    "Win rate %", "Won value", "Avg deal", "Spend", "CAC", "ROAS", "Notes",
  ].join(","));

  for (const c of [...report.channels, ...report.unattributed]) {
    lines.push([
      esc(c.channel), c.attributable ? "yes" : "no (data entry)",
      c.leads, c.won, c.lost, c.open,
      pct(c.winRate), c.wonValue, c.avgDealSize ?? "",
      c.spend ?? "", c.cac ?? "", c.roas === null ? "" : c.roas.toFixed(2),
      esc(c.notes.join(" ")),
    ].join(","));
  }

  lines.push("");
  lines.push(`Total leads,${report.totals.leads}`);
  lines.push(`Total won,${report.totals.won}`);
  lines.push(`Won value,${report.totals.wonValue}`);
  lines.push(`Recorded spend,${report.totals.spend}`);
  lines.push(`Unattributed share %,${(report.totals.unattributedShare * 100).toFixed(1)}`);
  // The blended figure is exported WITH its caveat, so a spreadsheet cannot
  // separate the number from the reason it may be unusable.
  lines.push(`Blended ROAS,${report.blendedRoas === null ? "" : report.blendedRoas.toFixed(2)},${esc(report.blendedNote ?? "")}`);
  return lines.join("\n");
}

// ============================================================
// Marketing & Advertising spend — /marketing/spend
// ============================================================

/** Every marketing-head expense in the range, newest first, for /marketing/spend. */
export function useMarketingSpend(rangeKey: RangeKey = "ytd") {
  const range = resolveRange(rangeKey);
  return useQuery({
    /* Under "expenses" so an expense added or edited anywhere refreshes this page too —
       useCreateExpense / useUpdateExpense invalidate that key. */
    queryKey: ["expenses", "marketing-spend", rangeKey],
    queryFn: async (): Promise<{ range: DateRange; rows: Expense[] }> => {
      const supabase = createClient();
      /* Same test as the ROAS page (`isMarketingCategory`): market / advert / ads. Filtered
         in the database so a year of rent and salaries is not shipped to the browser. */
      const { data, error } = await supabase
        .from("expenses")
        .select("*")
        .or("category.ilike.*market*,category.ilike.*advert*,category.ilike.*ads*")
        .gte("expense_date", range.start)
        .lt("expense_date", range.end)
        .order("expense_date", { ascending: false });
      if (error) throw error;
      return { range, rows: ((data ?? []) as Expense[]).filter((r) => isMarketingCategory(r.category)) };
    },
    staleTime: 30_000,
  });
}
