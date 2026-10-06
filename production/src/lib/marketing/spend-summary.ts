/**
 * Marketing & Advertising spend — what went where, from the expense rows themselves.
 *
 * Pardeep, 26 Sep 2026: "is page se main dono area ko complete manage kar saku — marketing
 * par kitna kharcha hua, advertising par kitna". The ROAS page answers "did it pay"; this
 * answers the question before that one: how much, on what, to whom, through which channel.
 *
 * The two heads, as the app already tells them apart (expenses.ts keyword rules):
 *   Advertising — money to a medium to show an ad: Google / Meta / LinkedIn ads, print,
 *                 hoardings.
 *   Marketing   — everything else that builds the brand: SEO, branding, campaign tools,
 *                 content.
 * A row in any other marketing-sounding category (a custom "Digital marketing", say) is
 * kept, under "Other", rather than dropped — dropping it would make the total lie.
 */
import { AD_CHANNELS, isMarketingCategory } from "./ad-channels";

export type SpendHead = "Marketing" | "Advertising" | "Other";

export interface SpendRow {
  id: string;
  expense_date: string;          // YYYY-MM-DD
  category: string | null;
  channel: string | null;
  vendor_name: string | null;
  amount: number | null;         // ₹, GST included (what left the bank)
}

export interface SpendSummary {
  total: number;
  byHead: Record<SpendHead, number>;
  /** Oldest month first; one point per month that has any spend. */
  monthly: { month: string; Marketing: number; Advertising: number; Other: number }[];
  /** Biggest first. `channel` null = not tagged. */
  byChannel: { channel: string | null; label: string; Marketing: number; Advertising: number; Other: number; total: number; count: number }[];
  /** Biggest first. */
  byVendor: { vendor: string; total: number; count: number }[];
  untagged: { count: number; amount: number };
}

export function headOf(category: string | null | undefined): SpendHead {
  const c = (category ?? "").trim().toLowerCase();
  if (c === "marketing") return "Marketing";
  if (c === "advertising") return "Advertising";
  return "Other";
}

export function channelLabel(channel: string | null | undefined): string {
  if (!channel) return "No channel";
  return AD_CHANNELS.find((c) => c.value === channel)?.label ?? channel;
}

export function summariseSpend(rows: SpendRow[]): SpendSummary {
  const byHead: Record<SpendHead, number> = { Marketing: 0, Advertising: 0, Other: 0 };
  const months = new Map<string, { month: string; Marketing: number; Advertising: number; Other: number }>();
  const channels = new Map<string, SpendSummary["byChannel"][number]>();
  const vendors = new Map<string, { vendor: string; total: number; count: number }>();
  const untagged = { count: 0, amount: 0 };
  let total = 0;

  for (const r of rows) {
    if (!isMarketingCategory(r.category)) continue;
    const amt = Math.round(r.amount ?? 0);
    const head = headOf(r.category);
    total += amt;
    byHead[head] += amt;

    const month = (r.expense_date ?? "").slice(0, 7);
    if (month) {
      const m = months.get(month) ?? { month, Marketing: 0, Advertising: 0, Other: 0 };
      m[head] += amt;
      months.set(month, m);
    }

    const key = r.channel ?? "";
    const ch = channels.get(key) ?? {
      channel: r.channel ?? null, label: channelLabel(r.channel),
      Marketing: 0, Advertising: 0, Other: 0, total: 0, count: 0,
    };
    ch[head] += amt; ch.total += amt; ch.count++;
    channels.set(key, ch);
    if (!r.channel) { untagged.count++; untagged.amount += amt; }

    /* Vendors are grouped on a trimmed, case-folded name so "Google India" and
       "google india " are one line; the first spelling seen is the one shown. */
    const vName = (r.vendor_name ?? "").trim() || "No name";
    const vKey = vName.toLowerCase();
    const v = vendors.get(vKey) ?? { vendor: vName, total: 0, count: 0 };
    v.total += amt; v.count++;
    vendors.set(vKey, v);
  }

  return {
    total,
    byHead,
    monthly: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    byChannel: [...channels.values()].sort((a, b) => b.total - a.total),
    byVendor: [...vendors.values()].sort((a, b) => b.total - a.total),
    untagged,
  };
}
