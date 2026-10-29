/**
 * R-2073 — the draft quote "Upgrade plan" makes for a support subscription, built in ONE
 * place so the dialog's preview and the quote the server saves cannot differ (R-803 rule).
 *
 * The quote reuses the extension path rather than inventing one: it is linked through
 * subscriptions.renewal_quote_id (what createExtensionQuote does), carries
 * extension_months = 0 (it buys no time — the renewal date stays) and one line whose
 * item_id is the new tier's catalogue row. record_payment recognises exactly that shape
 * (migration 20261029005703_r2073_support_upgrade_pro_rata) and, once paid in full, moves
 * the subscription to the new plan with the same renewal date.
 *
 * The line names its dates "(pro-rata from X to Y)" like an add-seats line, so the PDF,
 * accept page and invoice print the period it pays for (lib/quotes/service-period.ts).
 */
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { isSplitBilled } from "@/lib/billing/instalments";
import { seatTermEnd, seatTermStart } from "@/lib/subscriptions/seat-charge-window";
import { addDaysISO } from "@/lib/billing/schedule";
import { formatIstDate } from "@/lib/dates/ist";
import { composeQuoteNotes } from "@/lib/quotes/customer-notes";
import { rupee } from "@/lib/utils";
import { findSupportSku, isSupportSkuId, supportTier, type SupportTierId } from "./tiers";
import { supportLineRate } from "./catalog-row";
import {
  parseSupportTierSku, proRataUpgrade, proRataUpgradeNote, upgradeTargets,
  type ProRataUpgrade, type SupportTerm,
} from "./pro-rata-upgrade";

export interface UpgradeSub {
  id: string;
  item_id: string | null;
  status: string;
  billing_cycle: string | null;
  term_months: number;
  start_date: string | null;
  renewal_date: string | null;
  renewal_quote_id: string | null;
}

export interface UpgradeCatalogRow {
  id: string;
  name: string;
  msrp: number;
  prices: unknown;
}

/** Is this a support subscription on a tier plan that has a dearer tier to move to? */
export function supportUpgradeFrom(sub: Pick<UpgradeSub, "item_id" | "status">): { tier: SupportTierId; term: SupportTerm } | null {
  if (sub.status !== "active" || !isSupportSkuId(sub.item_id)) return null;
  const parsed = parseSupportTierSku(sub.item_id);
  return parsed && upgradeTargets(parsed.tier).length > 0 ? parsed : null;
}

export interface SupportUpgradePlan {
  fromTier:  SupportTierId;
  toTier:    SupportTierId;
  term:      SupportTerm;
  toRow:     UpgradeCatalogRow;
  calc:      ProRataUpgrade;
  /** First and last day the charge covers (inclusive). */
  from:      string;
  to:        string;
  line:      QuoteLineItem;
  notes:     string;
}

const fmt = (n: number) => rupee(n, { decimals: Number.isInteger(n) ? 0 : 2 });

export function buildSupportUpgrade(args: {
  sub:     UpgradeSub;
  items:   readonly UpgradeCatalogRow[];
  toTier:  SupportTierId;
  today:   string;
}): { ok: true; plan: SupportUpgradePlan } | { ok: false; reason: string } {
  const { sub, items, toTier, today } = args;
  if (sub.status !== "active") return { ok: false, reason: `This subscription is ${sub.status}. Only an active plan can be upgraded.` };
  const from = parseSupportTierSku(sub.item_id);
  if (!from) return { ok: false, reason: "Only a Standard or Enterprise support plan can be upgraded here." };
  if (isSplitBilled(sub.billing_cycle as never)) {
    return { ok: false, reason: "This plan is billed in instalments. Change the plan at renewal." };
  }
  if (sub.renewal_quote_id) {
    return { ok: false, reason: `This subscription already has an open quote (${sub.renewal_quote_id}). Finish or delete it first.` };
  }
  const termStart = seatTermStart(sub);
  const termEnd = seatTermEnd(sub);
  if (!termStart || !termEnd || !sub.renewal_date) return { ok: false, reason: "The subscription has no renewal date." };

  const fromRow = findSupportSku(items, from.tier, from.term);
  const toRow = findSupportSku(items, toTier, from.term);
  const toLabel = supportTier(toTier).label;
  if (!toRow) {
    return { ok: false, reason: `${toLabel} support (${from.term}) is not in your catalogue yet. Add it under Products first.` };
  }
  const r = proRataUpgrade({
    fromTier: from.tier, toTier, term: from.term, termStart, renewalDate: termEnd, today,
    fromPrice: supportLineRate(fromRow as never, supportTier(from.tier), from.term),
    toPrice: supportLineRate(toRow as never, supportTier(toTier), from.term),
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  const { ok: _ok, ...calc } = r;

  const lastDay = addDaysISO(termEnd, -1);
  const fromLabel = supportTier(from.tier).label;
  const calcText = proRataUpgradeNote({
    fromLabel, toLabel, r: calc, renewalDateText: formatIstDate(sub.renewal_date.slice(0, 10)), fmt,
  });
  const line: QuoteLineItem = {
    id:         "upgrade-1",
    item_id:    toRow.id,
    name:       `${toRow.name} · upgrade from ${fromLabel} (pro-rata from ${today} to ${lastDay})`,
    qty:        1,
    rate:       calc.amountExGst,
    cost:       0,
    commitment: from.term === "yearly" ? "annual_yearly" : "monthly",
  };
  return {
    ok: true,
    plan: {
      fromTier: from.tier, toTier, term: from.term, toRow, calc,
      from: today, to: lastDay, line,
      notes: composeQuoteNotes(calcText, `Raised from Upgrade plan for subscription ${sub.id}.`),
    },
  };
}
