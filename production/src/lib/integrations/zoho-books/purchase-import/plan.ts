/**
 * R-2502 (G-FY2526) — the preview of an FY purchase import (Zoho bills + expenses, then vendor
 * payments), pure. The SQL import (import_zoho_fy_purchases / import_zoho_fy_vendor_payments) makes
 * the same decisions and is the last word; its dry run shows its own refusals.
 *
 * Where a Zoho document goes — the app's existing tables, no new formula:
 *   - every line's Zoho account → an app category (the company's saved map, zoho_account_category_map;
 *     none saved → "Unmapped — review", listed so the owner can map it);
 *   - all lines COGS-* (and no reverse charge, no blocked GST) → ONE COGS bill (vendor_bills, unpaid);
 *     TDS on it goes with its first payment (pay_vendor_bill), as on the Bills page;
 *   - otherwise → expense rows (expenses), one per category (as Add expense splits a bill), unpaid for a
 *     Zoho bill (paid by the vendor-payment import), paid for a Zoho expense (banked later by Reconcile's
 *     "recorded payment" match on the 4523 debit). GST: claimable GST in gst_paid (heads kept when the
 *     document is one category); Zoho's ineligible ITC stays in the cost (amount), as lib/gst/itc.ts
 *     treats blocked credit; RCM → rcm + rcm_tax. TDS (section from Zoho) on the first row.
 *   - a bill with COGS and non-COGS lines, or a Zoho expense on a COGS account → left out (by hand).
 * Left out, with the reason: void / draft, a normaliser problem, outside the FY, no books start /
 * before it, inside the books lock, two vendors with that name. Already (same Zoho id) → "already".
 * Vendor: Zoho contact id → GSTIN → the one vendor with that exact name → else created from Zoho.
 */
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";
import { isGstin, normalizeGstin } from "@/lib/gst/itc";
import type { PurchaseFacts, VendorPaymentFacts } from "./normalise";
import { suggestAccount, type AppBankAccount } from "../receipts-import/plan";
import { depositAccounts } from "@/lib/payments/deposit-accounts";

export const PURCHASE_IMPORT_ROLES = ["owner", "accountant"] as const;
export function canImportFyPurchases(role: string | null | undefined): boolean {
  return (PURCHASE_IMPORT_ROLES as readonly string[]).includes(role ?? "");
}

/** The category an unmapped Zoho account's lines get (safe default — the owner maps and reviews). */
export const UNMAPPED_CATEGORY = "Unmapped — review";
export const COGS_CATEGORIES = ["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"] as const;
/** What a Zoho account may be mapped to. Salaries are booked by Payroll, never from a Zoho bill. */
export const CATEGORY_CHOICES: readonly string[] = [
  ...EXPENSE_CATEGORIES.filter((c) => c !== "Salaries"),
  ...COGS_CATEGORIES,
];
export const isCogs = (c: string) => c.startsWith("COGS-");

export interface VendorRef { id: string; name: string; gstin: string | null; zohoContactId: string | null }

export interface PurchasePlanContext {
  fyStart: string;
  fyEnd: string;
  booksStart: string | null;
  lockedUntil: string | null;
  vendors: VendorRef[];
  /** Zoho account id → app category. */
  categoryMap: Record<string, string>;
  /** "<kind>:<zoho id>" already in the app (vendor_bills / expenses zoho_doc_id). */
  imported: Set<string>;
  /** This company's bank / cash / card accounts (Zoho's paid-through account maps to one). */
  bankAccounts: AppBankAccount[];
  /** Zoho paid-through account name → the app account the owner chose. */
  accountMap: Record<string, string>;
}

/** One Zoho paid-through account and the app account it maps to (the owner's choice, else a suggestion). */
export interface PaidThroughAccount { zohoName: string; count: number; amount: number; appAccountId: string | null; suggested: boolean }

const NO_ACCOUNT = "(no account in Zoho)";
/**
 * R-2502c (coordinator decision): a payment is booked against the app account Zoho's paid-through
 * account maps to — petty cash → the cash account, a card → that card account, a director's /
 * own account → that account. The owner's choice wins; else the same rule as the receipts import
 * (R-2501 suggestAccount: last 4 digits, same name, cash → the company's cash account); else none,
 * and the document is left out (listed) — never a blank payment method.
 */
export function resolveAccounts(names: Iterable<{ name: string; amount: number }>, bankAccounts: AppBankAccount[], accountMap: Record<string, string>) {
  const own = new Set((bankAccounts ?? []).filter((a) => a.is_active !== false).map((a) => a.id));
  const out = new Map<string, PaidThroughAccount>();
  for (const { name, amount } of names) {
    const key = name || NO_ACCOUNT;
    const t = out.get(key) ?? (() => {
      const chosen = accountMap[key];
      if (chosen && own.has(chosen)) return { zohoName: key, count: 0, amount: 0, appAccountId: chosen, suggested: false };
      const s = name ? suggestAccountAny(name, bankAccounts) : null;
      return { zohoName: key, count: 0, amount: 0, appAccountId: s, suggested: s !== null };
    })();
    t.count += 1; t.amount += amount;
    out.set(key, t);
  }
  return out;
}
/** suggestAccount covers deposit accounts (no credit card); a card account is matched by its last 4 digits or name too. */
function suggestAccountAny(name: string, accounts: AppBankAccount[]): string | null {
  const s = suggestAccount(name, accounts);
  if (s) return s;
  const n = name.toLowerCase();
  const cards = (accounts ?? []).filter((a) => a.is_active !== false && !depositAccounts([a]).length);
  const hit = cards.filter((a) => (a.account_number_last4 && n.replace(/\D/g, "").endsWith(a.account_number_last4)) || a.name.toLowerCase() === n);
  return hit.length === 1 ? hit[0].id : null;
}

export interface Leg {
  category: string;
  taxable: number;
  /** Claimable GST (expenses.gst_paid). */
  gst: number;
  /** Zoho's ineligible ITC — part of the cost. */
  costGst: number;
  rcmTax: number;
  heads: { igst: number; cgst: number; sgst: number } | null;
}

export function categoryOf(accountId: string, map: Record<string, string>): string {
  return map[accountId] ?? UNMAPPED_CATEGORY;
}

/** One leg per category, in first-seen order. */
export function legsOf(f: PurchaseFacts, map: Record<string, string>): Leg[] {
  const legs = new Map<string, Leg>();
  for (const l of f.lines) {
    const c = categoryOf(l.accountId, map);
    const g = legs.get(c) ?? { category: c, taxable: 0, gst: 0, costGst: 0, rcmTax: 0, heads: null };
    g.taxable += l.taxable;
    if (f.rcm) g.rcmTax += l.tax;
    else if (l.itcEligible) g.gst += l.tax;
    else g.costGst += l.tax;
    legs.set(c, g);
  }
  const out = [...legs.values()];
  if (f.rcm) return out;
  /* The heads of each row's claimable GST: the document's own when it is one row with all GST
     claimable; else the document's head (IGST, or CGST + SGST halves). A document with both kinds
     of head gets none (the report then says "assumed"). */
  if (out.length === 1 && out[0].costGst === 0) { out[0].heads = { igst: f.igst, cgst: f.cgst, sgst: f.sgst }; return out; }
  const inter = f.igst > 0 && f.cgst + f.sgst === 0;
  const intra = f.igst === 0;
  if (!inter && !intra) return out;
  for (const l of out) {
    const half = Math.round(l.gst / 2);
    l.heads = inter ? { igst: l.gst, cgst: 0, sgst: 0 } : { igst: 0, cgst: half, sgst: l.gst - half };
  }
  return out;
}

export interface MonthTotals {
  month: string; count: number; taxable: number; igst: number; cgst: number; sgst: number;
  /** Claimable GST. */
  itc: number; rcmTax: number; tds: number;
}

export interface PurchasePlanRow {
  facts: PurchaseFacts;
  verdict: "import" | "already" | "skip";
  reason: string | null;
  target: "vendor_bill" | "expense" | null;
  vendorId: string | null;
  createVendor: boolean;
  legs: Leg[];
  /** Zoho expenses: the app account it was paid from (null for a bill — paid later). */
  accountId: string | null;
}

export interface PurchasePlan {
  rows: PurchasePlanRow[];
  counts: { scanned: number; import: number; already: number; skip: number; voidOrDraft: number; newVendors: number };
  zohoByMonth: MonthTotals[];
  importByMonth: MonthTotals[];
  skipReasons: { reason: string; count: number }[];
  unmapped: { accountId: string; accountName: string; count: number; taxable: number }[];
  tdsBySection: { section: string; amount: number; count: number }[];
  /** Zoho expenses' paid-through accounts and the app account each maps to. */
  accounts: PaidThroughAccount[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

function addMonth(m: Map<string, MonthTotals>, f: PurchaseFacts, legs: Leg[]) {
  const month = f.date.slice(0, 7);
  const t = m.get(month) ?? { month, count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, itc: 0, rcmTax: 0, tds: 0 };
  t.count += 1; t.taxable += f.taxable; t.igst += f.igst; t.cgst += f.cgst; t.sgst += f.sgst;
  t.itc += legs.reduce((a, l) => a + l.gst, 0); t.rcmTax += f.rcmTax; t.tds += f.tdsAmount;
  m.set(month, t);
}
const sorted = (m: Map<string, MonthTotals>) => [...m.values()].sort((a, b) => a.month.localeCompare(b.month));

export function matchVendor(f: { vendorZohoId: string; vendorName: string; gstin: string }, vendors: VendorRef[]): { id: string | null; create: boolean; problem: string | null } {
  if (f.vendorZohoId) {
    const z = vendors.find((v) => v.zohoContactId === f.vendorZohoId);
    if (z) return { id: z.id, create: false, problem: null };
  }
  const g = normalizeGstin(f.gstin);
  if (isGstin(g)) {
    const byG = vendors.filter((v) => normalizeGstin(v.gstin) === g);
    if (byG.length === 1) return { id: byG[0].id, create: false, problem: null };
  }
  /* R-2502c: a name match only when that vendor has no GSTIN or the same one — never a supplier
     with another GSTIN (its ITC would sit under the wrong GSTIN); such a bill gets its own vendor. */
  const byName = vendors.filter((v) => norm(v.name) === norm(f.vendorName)
    && (!isGstin(g) || !normalizeGstin(v.gstin) || normalizeGstin(v.gstin) === g));
  if (byName.length === 1) return { id: byName[0].id, create: false, problem: null };
  if (byName.length > 1) return { id: null, create: false, problem: `${byName.length} vendors are named "${f.vendorName}" — add the GSTIN to the right one (Vendors), then preview again.` };
  if (!f.vendorName.trim()) return { id: null, create: false, problem: "It has no vendor in Zoho." };
  return { id: null, create: true, problem: null };
}

/** Why a dated document cannot come in (FY, books start, lock); null when it can. */
export function dateRefusal(date: string, c: { fyStart: string; fyEnd: string; booksStart: string | null; lockedUntil: string | null }): string | null {
  if (!date || date < c.fyStart || date > c.fyEnd) return `Dated ${date || "?"}, outside the financial year.`;
  if (!c.booksStart) return "The books start date is not set (Accounting → Overview → Books start).";
  if (date < c.booksStart) return `Dated ${fmt(date)}, before the books start (${fmt(c.booksStart)}).`;
  if (c.lockedUntil && date <= c.lockedUntil) return `Dated ${fmt(date)}, inside the books lock (till ${fmt(c.lockedUntil)}). Unlock the books first.`;
  return null;
}

export function buildPurchasePlan(facts: readonly PurchaseFacts[], ctx: PurchasePlanContext): PurchasePlan {
  const rows: PurchasePlanRow[] = [];
  const zoho = new Map<string, MonthTotals>();
  const imp = new Map<string, MonthTotals>();
  const reasons = new Map<string, number>();
  const unmapped = new Map<string, { accountId: string; accountName: string; count: number; taxable: number }>();
  const tds = new Map<string, { section: string; amount: number; count: number }>();
  const counts = { scanned: facts.length, import: 0, already: 0, skip: 0, voidOrDraft: 0, newVendors: 0 };
  const newVendorKeys = new Set<string>();
  const accounts = resolveAccounts(
    facts.filter((f) => f.kind === "expenses" && f.status !== "void" && f.status !== "draft").map((f) => ({ name: f.paidThrough, amount: f.total })),
    ctx.bankAccounts, ctx.accountMap);

  for (const f of facts) {
    const legs = legsOf(f, ctx.categoryMap);
    const live = f.status !== "void" && f.status !== "draft";
    if (live) {
      addMonth(zoho, f, legs);
      for (const l of f.lines) {
        if (ctx.categoryMap[l.accountId]) continue;
        const u = unmapped.get(l.accountId) ?? { accountId: l.accountId, accountName: l.accountName, count: 0, taxable: 0 };
        u.count += 1; u.taxable += l.taxable;
        unmapped.set(l.accountId, u);
      }
    }
    let reason: string | null = null;
    let target: PurchasePlanRow["target"] = null;
    let vendor: ReturnType<typeof matchVendor> = { id: null, create: false, problem: null };
    if (f.status === "void") { reason = "Void in Zoho — not a purchase, not in the P&L or ITC."; counts.voidOrDraft++; }
    else if (f.status === "draft") { reason = "Draft in Zoho — never booked there."; counts.voidOrDraft++; }
    else if (f.problems.length) reason = f.problems[0];
    else reason = dateRefusal(f.date, ctx);

    const already = ctx.imported.has(`${f.kind}:${f.zohoId}`);
    if (!reason && !already) {
      const cogs = legs.filter((l) => isCogs(l.category));
      if (cogs.length && cogs.length < legs.length) reason = "It has COGS and expense lines — add it by hand, or map its accounts to one kind.";
      else if (cogs.length && f.kind === "expenses") reason = "A Zoho expense on a COGS account — add it as a COGS bill by hand.";
      else if (cogs.length && f.rcm) reason = "A COGS bill under reverse charge — add it by hand.";
      else if (cogs.length && legs.some((l) => l.costGst > 0)) reason = "A COGS bill with ineligible ITC — add it by hand.";
      else target = cogs.length ? "vendor_bill" : "expense";
    }
    if (!reason && !already) {
      vendor = matchVendor(f, ctx.vendors);
      if (vendor.problem) { reason = vendor.problem; target = null; }
    }
    const accountId = f.kind === "expenses" ? accounts.get(f.paidThrough || NO_ACCOUNT)?.appAccountId ?? null : null;
    if (!reason && !already && f.kind === "expenses" && !accountId) {
      reason = `Choose the app account for Zoho's "${f.paidThrough || NO_ACCOUNT}" (paid from) — petty cash, card or bank.`;
      target = null;
    }

    let verdict: PurchasePlanRow["verdict"];
    if (reason) {
      verdict = "skip"; counts.skip++;
      const k = reason.replace(/\d{2} \w{3} \d{4}/g, "…").replace(/₹[\d,.]+/g, "₹…");
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
    else if (already) { verdict = "already"; counts.already++; }
    else {
      verdict = "import"; counts.import++;
      addMonth(imp, f, legs);
      if (vendor.create) {
        const k = f.vendorZohoId || norm(f.vendorName);
        if (!newVendorKeys.has(k)) { newVendorKeys.add(k); counts.newVendors++; }
      }
    }
    if (live && f.tdsAmount > 0 && f.tdsSection) {
      const t = tds.get(f.tdsSection) ?? { section: f.tdsSection, amount: 0, count: 0 };
      t.amount += f.tdsAmount; t.count += 1;
      tds.set(f.tdsSection, t);
    }
    rows.push({ facts: f, verdict, reason, target: verdict === "skip" ? null : target, vendorId: vendor.id, createVendor: vendor.create, legs, accountId: verdict === "skip" ? null : accountId });
  }

  return {
    rows, counts,
    zohoByMonth: sorted(zoho), importByMonth: sorted(imp),
    skipReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    unmapped: [...unmapped.values()].sort((a, b) => b.taxable - a.taxable),
    tdsBySection: [...tds.values()].sort((a, b) => a.section.localeCompare(b.section)),
    accounts: [...accounts.values()].sort((a, b) => b.amount - a.amount),
  };
}

/** What the SQL import is told: Zoho id + the vendor the preview matched (null = create from Zoho). No money. */
export function toPurchasePick(r: PurchasePlanRow) {
  return { kind: r.facts.kind, zoho_id: r.facts.zohoId, vendor_id: r.vendorId, ...(r.accountId ? { account_id: r.accountId } : {}) };
}

// ── vendor payments ────────────────────────────────────────────────────────────────────────

export interface PaymentPlanContext {
  fyStart: string; fyEnd: string; booksStart: string | null; lockedUntil: string | null;
  /** Zoho bill id → where it was imported. */
  targets: Map<string, { type: "vendor_bill" | "expense" }>;
  /** Zoho payment ids already imported. */
  importedPayments: Set<string>;
  /** Zoho bill id → its total (what the vendor billed), Zoho TDS and section (from the bills scan). */
  bills: Map<string, { total: number; tds: number; tdsSection: string | null }>;
  bankAccounts: AppBankAccount[];
  /** Zoho paid-through account name → the app account the owner chose. */
  accountMap: Record<string, string>;
}

export interface PaymentPlanRow {
  facts: VendorPaymentFacts;
  verdict: "import" | "already" | "skip";
  reason: string | null;
  /** The app account Zoho's paid-through account maps to (an expense bill marked paid from it). */
  accountId: string | null;
}

/**
 * A Zoho payment the import does NOT book — paid in Banking → Reconcile on its own bank debit, with
 * the bill's Zoho TDS on the bill's first payment:
 *   cogs  — on a COGS bill (no "paid outside the bank" state for a COGS bill; R-2502b);
 *   parts — on an expense bill Zoho paid in 2+ payments, or one payment that does not cover it:
 *           each debit is one part in Reconcile (R-1915 expense part payment), never "paid" with one date.
 */
export interface PaymentToReconcile {
  why: "cogs" | "parts"; number: string; date: string; vendor: string; bill: string; amount: number; tds: number; tdsSection: string | null;
}

export interface PaymentPlan {
  rows: PaymentPlanRow[];
  counts: { scanned: number; import: number; already: number; skip: number; advanceAmount: number; amount: number; cogsAmount: number; partsAmount: number };
  accounts: PaidThroughAccount[];
  skipReasons: { reason: string; count: number }[];
  toReconcile: PaymentToReconcile[];
}

export const COGS_PAYMENT_REASON = "Pays a COGS bill — pay it in Banking → Reconcile on its bank debit (with the bill's Zoho TDS), so the cash is counted once.";

export function buildPaymentPlan(facts: readonly VendorPaymentFacts[], ctx: PaymentPlanContext): PaymentPlan {
  const rows: PaymentPlanRow[] = [];
  const counts = { scanned: facts.length, import: 0, already: 0, skip: 0, advanceAmount: 0, amount: 0, cogsAmount: 0, partsAmount: 0 };
  const reasons = new Map<string, number>();
  const toReconcile: PaymentToReconcile[] = [];
  const live = facts.filter((f) => f.status !== "void");
  /* Every Zoho payment on each bill, oldest first — the TDS goes with the bill's first payment. */
  const byBill = new Map<string, Array<{ zohoId: string; date: string; amount: number }>>();
  for (const f of live) for (const a of f.applied) {
    const l = byBill.get(a.billZohoId) ?? [];
    l.push({ zohoId: f.zohoId, date: f.date, amount: a.amount });
    byBill.set(a.billZohoId, l);
  }
  for (const l of byBill.values()) l.sort((a, b) => a.date.localeCompare(b.date) || a.zohoId.localeCompare(b.zohoId));
  const firstOf = (bill: string, zohoId: string) => byBill.get(bill)?.[0]?.zohoId === zohoId;
  const accounts = resolveAccounts(live.map((f) => ({ name: f.paidThrough, amount: f.amount - f.unapplied })), ctx.bankAccounts, ctx.accountMap);

  for (const f of [...facts].sort((a, b) => a.date.localeCompare(b.date) || a.zohoId.localeCompare(b.zohoId))) {
    let reason: string | null = f.status === "void" ? "Void in Zoho." : f.problems[0] ?? dateRefusal(f.date, ctx);
    if (!reason && !f.applied.length) reason = "An advance — not applied to any bill in Zoho; book it as an advance (Prepaid) by hand.";
    const missing = f.applied.find((a) => !ctx.targets.has(a.billZohoId));
    if (!reason && missing) reason = `Bill ${missing.billNumber || missing.billZohoId} is not in the app yet — Import the bills first, then preview again.`;
    /* Book only an expense bill paid by exactly ONE Zoho payment that covers it (with its TDS) — that
       one payment matches one bank debit. Anything else is listed for Reconcile. */
    const listed: PaymentToReconcile[] = [];
    let booked = 0;
    if (!reason) {
      for (const a of f.applied) {
        const bill = ctx.bills.get(a.billZohoId) ?? { total: 0, tds: 0, tdsSection: null };
        const first = firstOf(a.billZohoId, f.zohoId);
        const item = { number: f.number, date: f.date, vendor: f.vendorName, bill: a.billNumber || a.billZohoId, amount: a.amount,
          tds: first ? bill.tds : 0, tdsSection: first && bill.tds > 0 ? bill.tdsSection : null };
        const pays = byBill.get(a.billZohoId) ?? [];
        if (ctx.targets.get(a.billZohoId)?.type === "vendor_bill") listed.push({ why: "cogs", ...item });
        else if (pays.length > 1 || a.amount + bill.tds < bill.total) listed.push({ why: "parts", ...item });
        else booked += a.amount;
      }
      if (listed.length === f.applied.length) {
        reason = listed.every((l) => l.why === "cogs") ? COGS_PAYMENT_REASON
          : `Pays ${listed[0].bill} in ${Math.max(2, (byBill.get(f.applied[0].billZohoId) ?? []).length)} payments (or part of it) in Zoho — pay each part in Banking → Reconcile on its bank debit.`;
      }
    }
    const accountId = accounts.get(f.paidThrough || NO_ACCOUNT)?.appAccountId ?? null;
    if (!reason && booked > 0 && !accountId) reason = `Choose the app account for Zoho's "${f.paidThrough || NO_ACCOUNT}" (paid from) — petty cash, card or bank.`;
    if (reason && (reason === COGS_PAYMENT_REASON || reason.startsWith("Pays ")) || !reason) {
      for (const l of listed) {
        toReconcile.push(l);
        if (l.why === "cogs") counts.cogsAmount += l.amount; else counts.partsAmount += l.amount;
      }
    }
    let verdict: PaymentPlanRow["verdict"];
    if (reason) {
      verdict = "skip"; counts.skip++;
      const k = reason.replace(/Bill \S+ /, "A bill ").replace(/Pays \S+ in \d+/, "Pays a bill in 2+").replace(/"[^"]*"/, "…");
      reasons.set(k, (reasons.get(k) ?? 0) + 1);
    }
    else if (ctx.importedPayments.has(f.zohoId)) { verdict = "already"; counts.already++; }
    else { verdict = "import"; counts.import++; counts.amount += booked; }
    /* Advances to book by hand: what is unapplied on a payment that comes in or is listed, or an advance-only one — never a void / refused one. */
    if (verdict === "import" || reason === COGS_PAYMENT_REASON || reason?.startsWith("Pays ") || reason?.startsWith("An advance")) counts.advanceAmount += f.unapplied;
    rows.push({ facts: f, verdict, reason, accountId: verdict === "skip" ? null : accountId });
  }
  return {
    rows, counts, toReconcile,
    accounts: [...accounts.values()].sort((a, b) => b.amount - a.amount),
    skipReasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

/** What the SQL import is told: the Zoho payment id + the app account it was paid from. No money. */
export function toPaymentPick(r: PaymentPlanRow) {
  return { zoho_id: r.facts.zohoId, ...(r.accountId ? { account_id: r.accountId } : {}) };
}
