/**
 * R-1980 — the reads behind "Sales by campaign" (Marketing → Reports) and the Online Orders
 * Source column. All arithmetic is in lib/marketing/campaign-sales.ts; this only fetches.
 *
 * Every read is paged past the gateway's 1000-row cap (fetchAllRows / fetchAllRowsIn), runs
 * under RLS, and — when the caller knows its company — also carries `tenant_id = …`.
 *
 * ─── WHERE THE AD FIELDS COME FROM ────────────────────────────────────────────
 * Today the ad fields live on the LEAD (utm_source / utm_medium / utm_campaign since
 * migration 20260821090100); a payment reaches them through its quote's lead_id.
 * R-1978 adds the ad fields to QUOTES (and utm_term / utm_content to leads). This file does
 * not wait for it: `adColumns()` asks once whether those columns exist and, when they do,
 * reads them — campaign-sales.ts then prefers the quote's own set. No code change is needed
 * the day R-1978's migration lands; until then the report reads the lead.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import { fetchAllRows, fetchAllRowsIn, type PageQuery } from "@/lib/ops/fetch-all";
import { resolveRange, type DateRange, type RangeKey } from "@/lib/queries/marketing";
import {
  campaignSalesReport, type CampaignSalesInput, type CampaignSalesReport,
  type SalesBilling, type SalesCampaignDef, type SalesCampaignExpense, type SalesInvoice, type SalesLead,
  type SalesPayment, type SalesQuote, type SalesSpendDay, type SalesSubscription,
} from "@/lib/marketing/campaign-sales";

/** Ad columns R-1978 adds to quotes. */
export const QUOTE_AD_COLUMNS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
/** Ad columns R-1978 adds to leads (source / medium / campaign are there already). */
export const LEAD_NEW_AD_COLUMNS = ["utm_term", "utm_content"] as const;

/* Untyped view of the client: the R-1978 columns are not in the generated types yet. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = SupabaseClient<any>;
type Db = SupabaseClient<Database> | Loose;

/**
 * Which optional ad columns this database has — the ONE switch between "lead only" and
 * "quote's own fields first". A `select(cols).limit(0)` costs no rows; an undefined-column
 * answer (or any error) means "not there yet".
 */
export async function adColumns(db: Db): Promise<{ quote: readonly string[]; lead: readonly string[] }> {
  const loose = db as Loose;
  const has = async (table: string, cols: readonly string[]) => {
    try {
      const { error } = await loose.from(table).select(["id", ...cols].join(", ")).limit(0);
      return !error;
    } catch {
      return false;
    }
  };
  const [q, l] = await Promise.all([has("quotes", QUOTE_AD_COLUMNS), has("leads", LEAD_NEW_AD_COLUMNS)]);
  return { quote: q ? QUOTE_AD_COLUMNS : [], lead: l ? LEAD_NEW_AD_COLUMNS : [] };
}

const sel = (base: string, extra: readonly string[]) => [base, ...extra].join(", ");
const LEAD_BASE = "id, created_at, source, utm_source, utm_medium, utm_campaign, referrer_url";

/** Every row the report needs for [range.start, range.end). */
export async function fetchCampaignSalesInput(db: Db, range: Pick<DateRange, "start" | "end">, tenantId?: string | null): Promise<CampaignSalesInput> {
  const loose = db as Loose;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scoped = (q: any) => (tenantId ? q.eq("tenant_id", tenantId) : q);
  const cols = await adColumns(db);

  // Payments received in the range, and payments refunded in the range (received earlier, maybe).
  const PAY = "id, quote_id, invoice_id, amount, status, received_at, refunded_at";
  const [got, back] = await Promise.all([
    fetchAllRows<SalesPayment>((a, z) => scoped(loose.from("payments").select(PAY))
      .gte("received_at", range.start).lt("received_at", range.end)
      .order("id", { ascending: true }).range(a, z) as PageQuery<SalesPayment>),
    fetchAllRows<SalesPayment>((a, z) => scoped(loose.from("payments").select(PAY))
      .eq("status", "refunded").gte("refunded_at", range.start).lt("refunded_at", range.end)
      .order("id", { ascending: true }).range(a, z) as PageQuery<SalesPayment>),
  ]);
  const payments = [...new Map([...got, ...back].map((p) => [p.id, p])).values()];

  const INV = "id, quote_id, amount, taxable_value";
  const invoices = new Map<string, SalesInvoice>();
  const loadInvoices = async (ids: (string | null | undefined)[]) => {
    const need = ids.filter((x): x is string => !!x && !invoices.has(x));
    for (const r of await fetchAllRowsIn<SalesInvoice, string>(need, (chunk, a, z) =>
      scoped(loose.from("invoices").select(INV)).in("id", chunk).order("id", { ascending: true }).range(a, z) as PageQuery<SalesInvoice>)) {
      invoices.set(r.id, r);
    }
  };
  await loadInvoices(payments.map((p) => p.invoice_id));

  // Monthly flex: the invoice came from subscription billing and has no quote_id.
  const flexInvoiceIds = payments
    .filter((p) => !p.quote_id && p.invoice_id && !invoices.get(p.invoice_id)?.quote_id)
    .map((p) => p.invoice_id);
  const billings = await fetchAllRowsIn<SalesBilling, string>(flexInvoiceIds, (chunk, a, z) =>
    scoped(loose.from("subscription_billings").select("id, invoice_id, subscription_id")).in("invoice_id", chunk)
      .order("id", { ascending: true }).range(a, z) as PageQuery<SalesBilling>);
  const subscriptions = await fetchAllRowsIn<SalesSubscription, string>(billings.map((b) => b.subscription_id), (chunk, a, z) =>
    scoped(loose.from("subscriptions").select("id, quote_id")).in("id", chunk)
      .order("id", { ascending: true }).range(a, z) as PageQuery<SalesSubscription>);

  const quoteIds = [
    ...payments.map((p) => p.quote_id),
    ...[...invoices.values()].map((i) => i.quote_id),
    ...subscriptions.map((s) => s.quote_id),
  ];
  const quotes = await fetchAllRowsIn<SalesQuote, string>(quoteIds, (chunk, a, z) =>
    scoped(loose.from("quotes").select(sel("id, lead_id, invoice_id, tax_rate", cols.quote))).in("id", chunk)
      .order("id", { ascending: true }).range(a, z) as PageQuery<SalesQuote>);
  await loadInvoices(quotes.map((q) => q.invoice_id));

  const leadSel = sel(LEAD_BASE, cols.lead);
  const created = await fetchAllRows<SalesLead>((a, z) => scoped(loose.from("leads").select(leadSel))
    .gte("created_at", range.start).lt("created_at", range.end)
    .order("id", { ascending: true }).range(a, z) as PageQuery<SalesLead>);
  const leads = new Map(created.map((l) => [l.id, l]));
  for (const l of await fetchAllRowsIn<SalesLead, string>(quotes.map((q) => q.lead_id).filter((id) => id && !leads.has(id)), (chunk, a, z) =>
    scoped(loose.from("leads").select(leadSel)).in("id", chunk).order("id", { ascending: true }).range(a, z) as PageQuery<SalesLead>)) {
    leads.set(l.id, l);
  }

  // Ad platforms' own numbers. Primary key (ad_account_id, day, campaign_id) is the total order.
  const [accounts, days, campaigns, expenses] = await Promise.all([
    fetchAllRows<{ id: string; platform: string }>((a, z) => scoped(loose.from("ad_accounts").select("id, platform"))
      .order("id", { ascending: true }).range(a, z) as PageQuery<{ id: string; platform: string }>),
    fetchAllRows<{ ad_account_id: string; day: string; campaign_id: string; campaign_name: string; spend: number | string; clicks: number; impressions: number }>((a, z) =>
      scoped(loose.from("ad_spend_daily").select("ad_account_id, day, campaign_id, campaign_name, spend, clicks, impressions"))
        .gte("day", range.start).lt("day", range.end)
        .order("ad_account_id", { ascending: true }).order("day", { ascending: true }).order("campaign_id", { ascending: true })
        .range(a, z) as PageQuery<{ ad_account_id: string; day: string; campaign_id: string; campaign_name: string; spend: number | string; clicks: number; impressions: number }>),
    fetchAllRows<SalesCampaignDef>((a, z) => scoped(loose.from("marketing_campaigns").select("id, code, name"))
      .order("id", { ascending: true }).range(a, z) as PageQuery<SalesCampaignDef>),
    fetchAllRows<SalesCampaignExpense>((a, z) => scoped(loose.from("expenses").select("id, campaign_id, amount, channel"))
      .not("campaign_id", "is", null).gte("expense_date", range.start).lt("expense_date", range.end)
      .order("id", { ascending: true }).range(a, z) as PageQuery<SalesCampaignExpense>),
  ]);
  const platformOf = new Map(accounts.map((a) => [a.id, a.platform]));
  const spendDays: SalesSpendDay[] = days.flatMap((d) => {
    const platform = platformOf.get(d.ad_account_id);
    return platform ? [{ platform, day: d.day, campaign_id: d.campaign_id, campaign_name: d.campaign_name,
      spend: Number(d.spend) || 0, clicks: d.clicks ?? 0, impressions: d.impressions ?? 0 }] : [];
  });

  return {
    range: { start: range.start, end: range.end },
    campaigns, leads: [...leads.values()], quotes, invoices: [...invoices.values()],
    billings, subscriptions, payments, spendDays,
    campaignExpenses: expenses.map((e) => ({ campaign_id: e.campaign_id, amount: Number(e.amount) || 0, channel: e.channel })),
  };
}

export async function fetchCampaignSales(db: Db, range: DateRange, tenantId?: string | null): Promise<CampaignSalesReport & { range: DateRange }> {
  return { ...campaignSalesReport(await fetchCampaignSalesInput(db, range, tenantId)), range };
}

/** Sales by campaign for a range of the Marketing → Reports page. */
export function useCampaignSales(rangeKey: RangeKey, tenantId: string | null | undefined) {
  const range = resolveRange(rangeKey);
  return useQuery({
    queryKey: ["marketing-campaign-sales", rangeKey, tenantId ?? null],
    queryFn: () => fetchCampaignSales(createClient(), range, tenantId),
    staleTime: 60_000,
  });
}

/** utm_campaign code (lower case) → campaign name, for the Online Orders Source cell. */
export function useCampaignNames(tenantId: string | null | undefined) {
  return useQuery({
    queryKey: ["marketing-campaign-names", tenantId ?? null],
    queryFn: async (): Promise<Map<string, string>> => {
      const loose = createClient() as Loose;
      const rows = await fetchAllRows<SalesCampaignDef>((a, z) => {
        let q = loose.from("marketing_campaigns").select("id, code, name");
        if (tenantId) q = q.eq("tenant_id", tenantId);
        return q.order("id", { ascending: true }).range(a, z) as PageQuery<SalesCampaignDef>;
      });
      return new Map(rows.map((r) => [r.code.trim().toLowerCase(), r.name]));
    },
    staleTime: 5 * 60_000,
  });
}
