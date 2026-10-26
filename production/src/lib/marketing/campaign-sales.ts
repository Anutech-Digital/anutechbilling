/**
 * R-1980 — Sales by campaign: what each ad campaign brought in as MONEY, not as lead value.
 *
 * The ROAS & CAC report (lib/queries/marketing.ts) divides won LEAD value by channel spend;
 * the campaigns page counts a lead's own value as "won". Neither says how much was actually
 * paid because of an ad. This module does, from the rows the query layer reads
 * (lib/queries/marketing-sales.ts):
 *
 *   payment ─► its quote (payment.quote_id, else the invoice's quote_id, else — a monthly
 *              flex invoice raised by subscription billing has quote_id NULL — the
 *              invoice's subscription_billings row → subscription.quote_id)
 *           ─► the ad fields: the quote's own (utm_* columns arrive with R-1978) when it has
 *              a source or campaign, else the lead's (quote.lead_id → leads.utm_*).
 *
 * Revenue = payments received in the range, EXCLUDING GST (the invoice's taxable share,
 * else the quote's GST rate), minus payments refunded in the range (same share). That is
 * money in the bank, net of tax we only collect for the government.
 *
 * Spend per campaign = what the ad account reported (ad_spend_daily, matched by the
 * platform's campaign name / id = utm_campaign code or the campaign's name, case-insensitive
 * — same rule as the Ad accounts page) PLUS other costs booked against the campaign
 * (expenses.campaign_id), EXCEPT a booked ad-platform invoice (channel google-ads / meta-ads /
 * linkedin-ads) when the platform's own rows exist: that bill is the same money again. With
 * no platform rows the booked expenses are the spend, ad invoice included.
 *
 * Pure: the page and its tests agree. Every amount in rupees.
 */
import { channelFor, EMPTY_UTM } from "@/lib/marketing/utm";
import { AD_CHANNELS } from "@/lib/marketing/ad-channels";

/** "meta-ads" → "Facebook / Instagram Ads"; an unknown key is shown as it is. */
export function adChannelLabel(key: string | null): string | null {
  if (!key) return null;
  return AD_CHANNELS.find((c) => c.value === key)?.label ?? key;
}

/** Row key for paid orders that no campaign brought. */
export const NO_CAMPAIGN = "__none__";

/** Booked expense channels that are an ad platform's own invoice. */
const PLATFORM_EXPENSE_CHANNELS = new Set(["google-ads", "meta-ads", "linkedin-ads"]);

/** GST rate assumed only when neither invoice nor quote carries one (quotes.tax_rate defaults to 18). */
const DEFAULT_GST_RATE = 18;

export interface AdFields {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  /** Ad set (Meta's {{adset.name}}) — R-1978. */
  utm_term?: string | null;
  /** Ad (Meta's {{ad.name}}) — R-1978. */
  utm_content?: string | null;
}

export interface SalesLead extends AdFields {
  id: string;
  created_at: string;
  source: string | null;
  referrer_url: string | null;
}
export interface SalesQuote extends AdFields {
  id: string;
  lead_id: string | null;
  invoice_id: string | null;
  tax_rate: number | null;
}
export interface SalesInvoice { id: string; quote_id: string | null; amount: number | null; taxable_value: number | null }
export interface SalesBilling { invoice_id: string; subscription_id: string }
export interface SalesSubscription { id: string; quote_id: string | null }
export interface SalesPayment {
  id: string;
  quote_id: string | null;
  invoice_id: string | null;
  amount: number;
  status: string;               // 'received' | 'refunded'
  received_at: string | null;
  refunded_at: string | null;
}
export interface SalesSpendDay {
  platform: string;
  day: string;
  campaign_id: string;
  campaign_name: string;
  spend: number;
  clicks: number;
  impressions: number;
}
export interface SalesCampaignExpense { campaign_id: string; amount: number; channel: string | null }
export interface SalesCampaignDef { id: string; code: string; name: string }

export interface CampaignSalesInput {
  /** [start, end) — yyyy-mm-dd. */
  range: { start: string; end: string };
  campaigns: SalesCampaignDef[];
  /** Leads CREATED in the range (the leads column) plus any lead a paid quote points to. */
  leads: SalesLead[];
  quotes: SalesQuote[];
  invoices: SalesInvoice[];
  billings: SalesBilling[];
  subscriptions: SalesSubscription[];
  /** Payments received OR refunded in the range. */
  payments: SalesPayment[];
  spendDays: SalesSpendDay[];
  /** Expenses in the range booked against a campaign (expenses.campaign_id). */
  campaignExpenses: SalesCampaignExpense[];
}

export interface Attribution {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  term: string | null;
  content: string | null;
  referrer: string | null;
  formSource: string | null;
}

export interface CampaignChild {
  adSet: string | null;
  ad: string | null;
  paidOrders: number;
  revenue: number;
}

export interface CampaignSalesRow {
  /** Normalised utm_campaign (lower case, trimmed), or NO_CAMPAIGN. */
  key: string;
  name: string;
  /** channelFor() key of the campaign's traffic ("meta-ads", "google-ads", …), or the ad platform. */
  channel: string | null;
  spend: number;
  clicks: number;
  impressions: number;
  leads: number;
  paidOrders: number;
  /** Received in the range, ex GST. */
  received: number;
  /** Refunded in the range, ex GST. */
  refunded: number;
  /** received − refunded. */
  revenue: number;
  /** revenue ÷ spend, 2 decimals — null with no spend. */
  roas: number | null;
  /** spend ÷ paid orders — null with no paid order or no spend. */
  cac: number | null;
  /** Ad set → ad split, only when some order carries utm_term / utm_content. */
  children: CampaignChild[];
}

export interface CampaignSalesReport {
  rows: CampaignSalesRow[];
  totals: {
    spend: number; clicks: number; impressions: number; leads: number; paidOrders: number;
    received: number; refunded: number; revenue: number;
    /** Revenue of the campaign rows only — what the ads brought. */
    adRevenue: number;
    /** adRevenue ÷ spend — the no-campaign row never inflates it. */
    roas: number | null;
  };
  /** Platform spend whose campaign matches no utm code (shown as its own rows, counted here too). */
  unmatchedSpend: number;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const blank = (s: string | null | undefined) => (s && s.trim() ? s : null);
const inRange = (iso: string | null, r: { start: string; end: string }) =>
  !!iso && iso.slice(0, 10) >= r.start && iso.slice(0, 10) < r.end;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** A payment's amount without GST: the invoice's taxable share, else the quote's rate. */
export function paymentExGst(
  amount: number,
  invoice: Pick<SalesInvoice, "amount" | "taxable_value"> | null | undefined,
  quote: Pick<SalesQuote, "tax_rate"> | null | undefined,
): number {
  if (invoice && invoice.amount && invoice.amount > 0 && invoice.taxable_value != null) {
    return Math.round((amount * invoice.taxable_value) / invoice.amount);
  }
  const rate = quote?.tax_rate ?? DEFAULT_GST_RATE;
  return Math.round((amount * 100) / (100 + Math.max(0, rate)));
}

export interface SalesIndex {
  quotes: ReadonlyMap<string, SalesQuote>;
  invoices: ReadonlyMap<string, SalesInvoice>;
  billings: ReadonlyMap<string, SalesBilling>;
  subscriptions: ReadonlyMap<string, SalesSubscription>;
  leads: ReadonlyMap<string, SalesLead>;
}

export interface ResolvedOrder {
  quote: SalesQuote | null;
  invoice: SalesInvoice | null;
  lead: SalesLead | null;
  attribution: Attribution;
  /** One order = one lead (else one quote, else one invoice) — instalments are one order. */
  orderKey: string;
}

/** The quote a payment belongs to: its own, its invoice's, or (monthly flex) its subscription's. */
export function resolvePaymentOrder(p: SalesPayment, ix: SalesIndex): ResolvedOrder {
  const invoice = (p.invoice_id && ix.invoices.get(p.invoice_id)) || null;
  let quoteId = p.quote_id ?? invoice?.quote_id ?? null;
  if (!quoteId && p.invoice_id) {
    const b = ix.billings.get(p.invoice_id);
    const s = b ? ix.subscriptions.get(b.subscription_id) : undefined;
    quoteId = s?.quote_id ?? null;
  }
  const quote = (quoteId && ix.quotes.get(quoteId)) || null;
  const lead = (quote?.lead_id && ix.leads.get(quote.lead_id)) || null;
  const inv = invoice ?? ((quote?.invoice_id && ix.invoices.get(quote.invoice_id)) || null);

  /* The quote's own ad fields (R-1978) are one visit; the lead's are another. Mixing a quote's
     campaign with the lead's source would invent a visit that never happened — so the quote's
     set wins as a whole when it names a source or campaign. */
  const qOwn = !!quote && !!(blank(quote.utm_source) || blank(quote.utm_campaign));
  const from: AdFields = qOwn ? quote! : (lead ?? {});
  const attribution: Attribution = {
    source: blank(from.utm_source),
    medium: blank(from.utm_medium),
    campaign: blank(from.utm_campaign),
    term: blank(qOwn ? quote!.utm_term : (quote?.utm_term ?? lead?.utm_term)),
    content: blank(qOwn ? quote!.utm_content : (quote?.utm_content ?? lead?.utm_content)),
    referrer: qOwn ? null : (lead?.referrer_url ?? null),
    formSource: lead?.source ?? null,
  };
  const orderKey = lead ? `lead:${lead.id}` : quote ? `quote:${quote.id}` : `invoice:${p.invoice_id ?? p.id}`;
  return { quote, invoice: inv, lead, attribution, orderKey };
}

/** channelFor() over an Attribution — "meta-ads", "google-ads", or null when nothing is known. */
function channelOf(a: Pick<Attribution, "source" | "medium" | "campaign" | "referrer">): string | null {
  if (!a.source && !a.referrer && !a.campaign) return null;
  const c = channelFor({ ...EMPTY_UTM, utm_source: a.source, utm_medium: a.medium, utm_campaign: a.campaign, referrer_url: a.referrer });
  return c === "unknown" ? null : c;
}

/** The Online Orders "Source" cell: channel key + campaign name, or null when the order carries no ad data. */
export function adSourceText(
  l: Pick<SalesLead, "utm_source" | "utm_medium" | "utm_campaign" | "referrer_url">,
  campaignNames: ReadonlyMap<string, string>,
): { channel: string | null; campaign: string | null } | null {
  const campaign = blank(l.utm_campaign);
  const channel = channelOf({ source: blank(l.utm_source), medium: blank(l.utm_medium), campaign, referrer: blank(l.referrer_url) });
  if (!channel && !campaign) return null;
  return { channel, campaign: campaign ? (campaignNames.get(norm(campaign)) ?? campaign.trim()) : null };
}

interface Acc {
  key: string; name: string; channel: string | null;
  platformSpend: number; bookedOther: number; bookedPlatform: number; hasPlatform: boolean;
  clicks: number; impressions: number; leads: number;
  orders: Map<string, number>; received: number; refunded: number;
  kids: Map<string, { adSet: string | null; ad: string | null; orders: Map<string, number>; revenue: number }>;
  channelVotes: Map<string, number>;
}

export function campaignSalesReport(input: CampaignSalesInput): CampaignSalesReport {
  const { range } = input;
  const byCode = new Map<string, SalesCampaignDef>();
  const byName = new Map<string, SalesCampaignDef>();
  for (const c of input.campaigns) { byCode.set(norm(c.code), c); byName.set(norm(c.name), c); }
  const defById = new Map(input.campaigns.map((c) => [c.id, c]));

  const acc = new Map<string, Acc>();
  const touch = (key: string, name: string): Acc => {
    let a = acc.get(key);
    if (!a) {
      a = { key, name, channel: null, platformSpend: 0, bookedOther: 0, bookedPlatform: 0, hasPlatform: false,
        clicks: 0, impressions: 0, leads: 0, orders: new Map(), received: 0, refunded: 0, kids: new Map(), channelVotes: new Map() };
      acc.set(key, a);
    }
    return a;
  };
  const campaignKey = (code: string | null): { key: string; name: string } => {
    if (!code || !norm(code)) return { key: NO_CAMPAIGN, name: "Not from an ad campaign" };
    const k = norm(code);
    return { key: k, name: byCode.get(k)?.name ?? code.trim() };
  };

  // ── platform spend ────────────────────────────────────────────────────
  let unmatchedSpend = 0;
  for (const d of input.spendDays) {
    if (!inRange(d.day, range)) continue;
    const def = byCode.get(norm(d.campaign_name)) ?? byCode.get(norm(d.campaign_id)) ?? byName.get(norm(d.campaign_name));
    const key = def ? norm(def.code) : norm(d.campaign_name) || norm(d.campaign_id);
    const a = touch(key, def?.name ?? d.campaign_name);
    if (!def && !byCode.has(key)) unmatchedSpend += Number(d.spend) || 0;
    a.platformSpend += Number(d.spend) || 0;
    a.clicks += d.clicks || 0;
    a.impressions += d.impressions || 0;
    a.hasPlatform = true;
    a.channelVotes.set(d.platform, (a.channelVotes.get(d.platform) ?? 0) + 1);
  }

  // ── costs booked against a campaign ───────────────────────────────────
  for (const e of input.campaignExpenses) {
    const def = defById.get(e.campaign_id);
    if (!def) continue;
    const a = touch(norm(def.code), def.name);
    if (PLATFORM_EXPENSE_CHANNELS.has(norm(e.channel))) a.bookedPlatform += e.amount || 0;
    else a.bookedOther += e.amount || 0;
  }

  // ── leads created in the range ────────────────────────────────────────
  for (const l of input.leads) {
    if (!inRange(l.created_at, range)) continue;
    const { key, name } = campaignKey(blank(l.utm_campaign));
    touch(key, name).leads += 1;
  }

  // ── money: received in range (+), refunded in range (−) ───────────────
  const ix: SalesIndex = {
    quotes: new Map(input.quotes.map((q) => [q.id, q])),
    invoices: new Map(input.invoices.map((i) => [i.id, i])),
    billings: new Map(input.billings.map((b) => [b.invoice_id, b])),
    subscriptions: new Map(input.subscriptions.map((s) => [s.id, s])),
    leads: new Map(input.leads.map((l) => [l.id, l])),
  };
  for (const p of input.payments) {
    const got = inRange(p.received_at, range);
    const back = p.status === "refunded" && inRange(p.refunded_at, range);
    if (!got && !back) continue;
    const o = resolvePaymentOrder(p, ix);
    const ex = paymentExGst(p.amount, o.invoice, o.quote);
    const { key, name } = campaignKey(o.attribution.campaign);
    const a = touch(key, name);
    const ch = channelOf(o.attribution);
    if (ch) a.channelVotes.set(ch, (a.channelVotes.get(ch) ?? 0) + 1);
    const net = (got ? ex : 0) - (back ? ex : 0);
    if (got) a.received += ex;
    if (back) a.refunded += ex;
    a.orders.set(o.orderKey, (a.orders.get(o.orderKey) ?? 0) + net);
    const kidKey = `${o.attribution.term ?? ""}\u0000${o.attribution.content ?? ""}`;
    let kid = a.kids.get(kidKey);
    if (!kid) { kid = { adSet: o.attribution.term, ad: o.attribution.content, orders: new Map(), revenue: 0 }; a.kids.set(kidKey, kid); }
    kid.revenue += net;
    kid.orders.set(o.orderKey, (kid.orders.get(o.orderKey) ?? 0) + net);
  }

  // ── rows ──────────────────────────────────────────────────────────────
  const paidCount = (m: Map<string, number>) => [...m.values()].filter((v) => v > 0).length;
  const rows: CampaignSalesRow[] = [...acc.values()].map((a) => {
    const spend = a.platformSpend + a.bookedOther + (a.hasPlatform ? 0 : a.bookedPlatform);
    const revenue = a.received - a.refunded;
    const paidOrders = paidCount(a.orders);
    const kids = [...a.kids.values()];
    const split = kids.some((k) => k.adSet || k.ad);
    const channel = [...a.channelVotes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    return {
      key: a.key, name: a.name, channel,
      spend: r2(spend), clicks: a.clicks, impressions: a.impressions, leads: a.leads,
      paidOrders, received: a.received, refunded: a.refunded, revenue,
      roas: spend > 0 ? r2(revenue / spend) : null,
      cac: spend > 0 && paidOrders > 0 ? Math.round(spend / paidOrders) : null,
      children: split
        ? kids
          .map((k) => ({ adSet: k.adSet, ad: k.ad, paidOrders: paidCount(k.orders), revenue: k.revenue }))
          .sort((x, y) => Number(!x.adSet && !x.ad) - Number(!y.adSet && !y.ad) || y.revenue - x.revenue)
        : [],
    };
  }).sort((x, y) => Number(x.key === NO_CAMPAIGN) - Number(y.key === NO_CAMPAIGN) || y.revenue - x.revenue || y.spend - x.spend);

  const sum = (f: (r: CampaignSalesRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const spend = r2(sum((r) => r.spend));
  const revenue = sum((r) => r.revenue);
  /* The ads' return counts only money a campaign brought. Dividing ALL revenue (orders no ad
     brought too) by ad spend read 38× on localhost for ads that returned 3.1× (26 Oct). */
  const adRevenue = rows.filter((r) => r.key !== NO_CAMPAIGN).reduce((s, r) => s + r.revenue, 0);
  return {
    rows,
    totals: {
      spend, clicks: sum((r) => r.clicks), impressions: sum((r) => r.impressions), leads: sum((r) => r.leads),
      paidOrders: sum((r) => r.paidOrders), received: sum((r) => r.received), refunded: sum((r) => r.refunded), revenue,
      adRevenue,
      roas: spend > 0 ? r2(adRevenue / spend) : null,
    },
    unmatchedSpend: r2(unmatchedSpend),
  };
}
