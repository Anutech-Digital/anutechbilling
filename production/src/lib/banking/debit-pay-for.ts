/**
 * R-1866 — "This payment is for:" on a money-OUT bank line (the vendor side of R-1838).
 *
 * Pardeep (24 Oct): "vendor ki payment ka bhi poora system banao logical aur user friendly jab
 * reconcile se entry karte hai". A bank debit to a vendor now says WHAT it pays — that vendor's
 * open bills (several, oldest first, part, net of TDS), a bill recorded on the spot, an advance,
 * a bank charge — and one server transaction books it (reconcile_bank_debit_to_vendor, migration
 * 20261024160000).
 *
 * This module is the pure part of the sheet. It never settles a bill or computes a balance: the
 * amounts due come from the database (bank_debit_vendor_open_items) and the server re-checks
 * every rupee (the parts must equal the bank debit, or nothing is written). TDS comes from the
 * app's own TDS config — the section's rate in tds-rates.ts and the thresholds in tdsDecision
 * (tds-deductor.ts) — never from numbers here.
 *
 *   guessVendor        — the payee: UPI id → account no (or its masked tail) → Category Rule → learned alias → name words (R-1919)
 *   planTds            — TDS per selected expense bill (the rows' own TDS, else the section's)
 *   allocateOldestFirst— the bank amount spread over the picked bills, oldest first
 *   preselect          — the bill(s) the debit pays exactly (or exactly after TDS)
 *   summarise          — bills + new bill + advance + charge vs the bank amount
 *   payArgs            — the RPC arguments
 *   resultLines        — what happened, in the owner's words, after the save
 */
import { customerNameTokens, narrationNames } from "@/lib/accounting/credit-match";
import { tdsDecision, panFromGstin } from "@/lib/accounting/tds-deductor";
import { rupee, formatDate } from "@/lib/utils";
import { cleanAccountNo, cleanIfsc } from "@/lib/banking/bank-details";
import { categoriseByRules, type CategoryRule } from "@/lib/banking/categorise";
import { narrationKey } from "@/lib/banking/narration-key";
import { bankDetailsFromNarration } from "@/lib/banking/narration-bank-details";

/* ─── Vendors ────────────────────────────────────────────────────────────────────────── */

export interface VendorLite {
  id: string;
  name: string;
  gstin?: string | null;
  pan?: string | null;
  upi_id?: string | null;
  bank_account_no?: string | null;
  default_tds_section?: string | null;
  default_category?: string | null;
}

export type VendorGuessStep = "upi" | "account" | "account_tail" | "rule" | "alias" | "name";
export interface VendorGuess { vendorId: string; reason: string; step: VendorGuessStep }

/** R-1919: a learned "narration key → vendor" (vendor_narration_aliases, written by the database on
 *  every vendor-payment save from a bank line). */
export interface VendorAlias { narration_key: string; vendor_id: string }

export interface GuessExtras {
  /** The company's Category Rules (txn_category_rules). */
  rules?: readonly CategoryRule[];
  /** The company's learned aliases. */
  aliases?: readonly VendorAlias[];
}

const letters = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[^A-Z]/g, "");

/** R-1919: the vendors a Category Rule's pattern names — "FACEBK" → "Facebook…" (the first five
 *  letters start the name, as the expense form always read it), or "PAYUFACEBOOK" → a vendor
 *  whose first name word (4+ letters) is inside the pattern. */
export function vendorsForRule(pattern: string, vendors: readonly VendorLite[]): VendorLite[] {
  const p = letters(pattern);
  if (p.length < 4) return [];
  const key = p.slice(0, 5);
  return vendors.filter((v) => {
    if (letters(v.name).startsWith(key)) return true;
    const first = customerNameTokens(v.name)[0];
    return !!first && first.length >= 4 && p.includes(first.toUpperCase());
  });
}

/**
 * Who was paid — R-1919: ONE order, the same as the database's bank_debit_vendor_guess (which
 * auto-reconcile uses), so the sheet and auto-reconcile can never disagree:
 *   1. the vendor's UPI id in the narration
 *   2. the vendor's bank account number in the narration — or, below it, the masked tail ("XXXX4521")
 *   3. the Category Rule that matches the line names the vendor
 *   4. learned alias — this narration key was matched to the vendor before
 *   5. a narration word shared with exactly ONE vendor's name (most shared words wins)
 * Each step answers only when exactly one vendor fits; two → that step says nothing and the next
 * one is asked. Nobody → no guess: paying the wrong vendor's bills is worse than asking.
 */
export function guessVendor(
  txn: { description: string | null; reference?: string | null; debit?: number | null },
  vendors: readonly VendorLite[],
  extras: GuessExtras = {},
): VendorGuess | null {
  const text = `${txn.description ?? ""} ${txn.reference ?? ""}`;
  const lower = text.toLowerCase();
  const digits = text.replace(/[^0-9]/g, " ");

  const byUpi = vendors.filter((v) => v.upi_id && v.upi_id.trim() && lower.includes(v.upi_id.trim().toLowerCase()));
  if (byUpi.length === 1) return { vendorId: byUpi[0].id, reason: `the bank line has their UPI id ${byUpi[0].upi_id}`, step: "upi" };

  const byAcct = vendors.filter((v) => {
    const a = (v.bank_account_no ?? "").replace(/[^0-9]/g, "");
    return a.length >= 6 && digits.split(/\s+/).some((d) => d.length >= 6 && (a.endsWith(d) || d.endsWith(a)));
  });
  if (byAcct.length === 1) return { vendorId: byAcct[0].id, reason: "the bank line has their account number", step: "account" };

  /* R-1919: a masked account ("XXXXXX4521") shows only its last digits — R-1918's parser reads
     them; one vendor whose saved account ends with them (4+ digits) is a match. */
  const tail = bankDetailsFromNarration(txn.description).accountTail;
  if (tail && tail.length >= 4) {
    const byTail = vendors.filter((v) => {
      const a = (v.bank_account_no ?? "").replace(/[^0-9]/g, "");
      return a.length >= 6 && a.endsWith(tail);
    });
    if (byTail.length === 1) return { vendorId: byTail[0].id, reason: `the bank line shows their account ending ${tail}`, step: "account_tail" };
  }

  const rule = categoriseByRules({ description: txn.description, debit: Math.max(1, txn.debit ?? 1), credit: 0 }, extras.rules ?? []);
  if (rule) {
    const byRule = vendorsForRule(rule.rule.pattern, vendors);
    if (byRule.length === 1) return { vendorId: byRule[0].id, reason: `your Category Rule “${rule.rule.pattern.trim()}”`, step: "rule" };
  }

  const key = narrationKey(txn.description);
  if (key) {
    const known = new Set(vendors.map((v) => v.id));
    const byAlias = [...new Set((extras.aliases ?? []).filter((a) => a.narration_key === key && known.has(a.vendor_id)).map((a) => a.vendor_id))];
    if (byAlias.length === 1) return { vendorId: byAlias[0], reason: "your last payment to this vendor", step: "alias" };
  }

  /* Name words: the vendor sharing the MOST distinctive words wins, only when no other vendor
     shares as many ("Kapoor Legal Associates" over "Kapoor Stationers" for "KAPOOR LEGAL…"). */
  const words = new Set(narrationNames(txn.description));
  const hits = vendors
    .map((v) => ({ v, shared: [...new Set(customerNameTokens(v.name))].filter((t) => words.has(t)) }))
    .filter((h) => h.shared.length > 0)
    .sort((a, b) => b.shared.length - a.shared.length);
  if (hits.length > 0 && (hits.length === 1 || hits[0].shared.length > hits[1].shared.length)) {
    return { vendorId: hits[0].v.id, reason: `the bank line says “${hits[0].shared.join(" ")}”`, step: "name" };
  }
  return null;
}

/** PAN for the TDS rule: the vendor's own, else the one inside its GSTIN. */
export function vendorPan(v: Pick<VendorLite, "pan" | "gstin"> | null | undefined): string | null {
  return (v?.pan ?? "").trim() || panFromGstin(v?.gstin) || null;
}

/* ─── Open bills (rows of bank_debit_vendor_open_items) ──────────────────────────────── */

/** R-1911: "recorded_payment" = a payment already recorded outside the bank (Bills page Pay,
 *  payment run, Expenses → Mark paid) that this bank line MATCHES — it is never paid again. */
export type PaySource = "vendor_bill" | "expense" | "recorded_payment";

export interface VendorOpenItem {
  source: PaySource;
  doc_id: string;
  bill_no: string | null;
  doc_date: string;
  due_date: string | null;
  category: string | null;
  total: number;
  /** Gross still owed — from the database, never recomputed here. */
  amount_due: number;
  gst: number;
  /** Value before GST — the TDS base. R-1915: 0 on an expense bill already part-paid (its TDS
   *  went with the first part — nothing left to deduct on). */
  tds_base: number;
  /** TDS already on the expense row (0 = none yet, or already withheld with an earlier part). */
  tds_amount: number;
  tds_section: string | null;
  /** R-1915: COGS bills and expense bills can both be part-paid. */
  can_part: boolean;
  /** An open payment run holding it — pay it there. */
  in_run: string | null;
  /** R-1911 recorded_payment: when it was recorded as paid, and the bill / expense it paid. */
  paid_on?: string | null;
  pays_source?: "vendor_bill" | "expense" | null;
  pays_doc_id?: string | null;
}

/** R-1911: a payment already recorded outside the bank — the line is matched to it, not paid again. */
export const isRecorded = (i: Pick<VendorOpenItem, "source">) => i.source === "recorded_payment";

/** Where the recorded payment was entered, in the owner's words. */
export const recordedWhere = (i: Pick<VendorOpenItem, "pays_source">) =>
  i.pays_source === "expense" ? "the Expenses page" : "the Bills page";

export const itemKey = (i: Pick<VendorOpenItem, "source" | "doc_id">) => `${i.source}:${i.doc_id}`;

export function itemLabel(i: VendorOpenItem): string {
  if (isRecorded(i)) {
    return `Already paid on ${formatDate(i.paid_on ?? i.doc_date)} from ${recordedWhere(i)}${i.bill_no ? ` · Bill ${i.bill_no}` : ""}`;
  }
  return `${i.bill_no ? `Bill ${i.bill_no}` : i.source === "vendor_bill" ? "COGS bill" : "Expense bill"} · ${formatDate(i.doc_date)}`;
}

/* ─── TDS ───────────────────────────────────────────────────────────────────────────── */

export interface TdsLine { key: string; tds: number; section: string | null; reason: string | null; fixed: boolean }

/**
 * TDS on each selected EXPENSE bill (a COGS bill takes none here — R-1868). A bill that already
 * carries TDS keeps it (fixed). The rest are ONE payment: with a section picked, tdsDecision
 * decides on their combined value before GST — the section's rate (tds-rates.ts) and its yearly /
 * single-payment thresholds (tds-deductor.ts), counting this vendor's other payments this year
 * (`fyOthers`, plus the fixed bills) — and the TDS is shared over the bills by their base (the
 * last bill takes the rounding). `off` = the operator said "no TDS".
 */
/**
 * R-1891: 194Q on one open COGS bill, as the database works it out (vendor_194q_open_bills →
 * vendor_bill_194q_calc, migration 20261024230000). `buyer` = the company said its business
 * turnover last FY was above ₹10 crore (null = not answered).
 */
export interface Bill194q {
  doc_id: string;
  fy_start: string;
  /** Value without GST of this vendor's goods bills earlier in the FY. */
  fy_before: number;
  /** The part of this bill above ₹50 lakh (without GST). */
  base: number;
  rate_pct: number;
  no_pan: boolean;
  tds_total: number;
  tds_already: number;
  tds_due: number;
  buyer: boolean | null;
}

/** The why of a COGS bill's 194Q, in one line. */
export function reason194q(q: Bill194q): string {
  const rate = `${q.rate_pct}%${q.no_pan ? " (no PAN)" : ""}`;
  if (q.tds_due === 0 && q.tds_already > 0) return `194Q: ${rupee(q.tds_already)} TDS already deducted on this bill.`;
  if (q.base === 0) return `194Q: bought ${rupee(q.fy_before)} from this vendor this year before this bill — this bill stays within ₹50 lakh, no TDS.`;
  return `194Q: bought ${rupee(q.fy_before)} from this vendor this year before this bill — ${rate} on ${rupee(q.base)} above ₹50 lakh = ${rupee(q.tds_due)}.`;
}

export function planTds(
  items: readonly VendorOpenItem[],
  opts: {
    section: string | null; pan: string | null; fyOthers: { base: number; baseWithoutTds: number } | null; off: boolean;
    /** R-1891: 194Q figures per open COGS bill (doc_id → row). */
    q194?: ReadonlyMap<string, Bill194q> | null;
  },
): TdsLine[] {
  const sec = (opts.section ?? "").trim().toUpperCase();
  const goods = (i: VendorOpenItem): TdsLine | null => {
    const q = opts.q194?.get(i.doc_id);
    if (opts.off || sec !== "194Q" || !q || q.buyer !== true || !(q.tds_due > 0)) return null;
    return { key: itemKey(i), tds: q.tds_due, section: "194Q", reason: reason194q(q), fixed: true };
  };
  /* R-1915: a part-paid expense bill (tds_base 0) takes no TDS — it went with its first part. */
  const free = items.filter((i) => i.source === "expense" && !(i.tds_amount > 0) && i.tds_base > 0);
  const fixedBase = items.filter((i) => i.source === "expense" && i.tds_amount > 0).reduce((s, i) => s + i.tds_base, 0);
  const base = free.reduce((s, i) => s + i.tds_base, 0);
  const d = !opts.off && sec && base > 0
    ? tdsDecision({ section: sec, base, fyBaseSoFar: Math.max(0, opts.fyOthers?.base ?? 0) + fixedBase, fyBaseWithoutTds: Math.max(0, opts.fyOthers?.baseWithoutTds ?? 0), pan: opts.pan })
    : null;
  const total = d?.applies ? d.tds : 0;
  let given = 0;
  const lastFree = free.length ? itemKey(free[free.length - 1]) : "";
  return items.map((i) => {
    const key = itemKey(i);
    if (i.source !== "expense") return goods(i) ?? { key, tds: 0, section: null, reason: null, fixed: false };
    if (i.tds_amount > 0) return { key, tds: i.tds_amount, section: i.tds_section, reason: "TDS already on this bill", fixed: true };
    if (!(i.tds_base > 0)) return { key, tds: 0, section: null, reason: null, fixed: false };
    if (!d) return { key, tds: 0, section: null, reason: null, fixed: false };
    const share = key === lastFree ? total - given : Math.round((total * i.tds_base) / base);
    given += share;
    return { key, tds: share, section: d.applies ? sec : null, reason: d.reason, fixed: false };
  });
}

/** TDS on a new bill typed on the spot (same rule, its value before GST). */
export function newBillTds(
  base: number,
  opts: { section: string | null; pan: string | null; fyOthers: { base: number; baseWithoutTds: number } | null; off: boolean },
): { tds: number; section: string | null; reason: string | null } {
  const sec = (opts.section ?? "").trim().toUpperCase();
  if (opts.off || !sec || !(base > 0)) return { tds: 0, section: null, reason: null };
  const d = tdsDecision({ section: sec, base, fyBaseSoFar: opts.fyOthers?.base ?? 0, fyBaseWithoutTds: opts.fyOthers?.baseWithoutTds ?? 0, pan: opts.pan });
  return { tds: d.applies ? d.tds : 0, section: d.applies ? sec : null, reason: d.reason };
}

/* ─── Allocation ─────────────────────────────────────────────────────────────────────── */

/** Cash a bill still needs: what is due less the TDS withheld on it. */
export const cashDue = (i: VendorOpenItem, tds: number) => Math.max(0, i.amount_due - tds);

/**
 * The bank amount over the picked bills, oldest first: each takes what it still needs; a COGS
 * bill (and, R-1915, an expense bill) can take a part; an item that cannot gets all or nothing (the rest stays
 * unallocated). Returns the cash per bill and what is left over.
 */
export function allocateOldestFirst(
  picked: readonly VendorOpenItem[],
  cash: number,
  tdsByKey: ReadonlyMap<string, number>,
): { cashByKey: Map<string, number>; left: number } {
  /* R-1911: a recorded payment is matched first (whole), then the bills oldest first. */
  const order = [...picked].sort((a, b) => Number(isRecorded(b)) - Number(isRecorded(a)) || a.doc_date.localeCompare(b.doc_date) || a.doc_id.localeCompare(b.doc_id));
  const cashByKey = new Map<string, number>();
  let left = Math.max(0, Math.round(cash));
  for (const i of order) {
    const need = cashDue(i, tdsByKey.get(itemKey(i)) ?? 0);
    const take = i.can_part ? Math.min(need, left) : (left >= need ? need : 0);
    cashByKey.set(itemKey(i), take);
    left -= take;
  }
  return { cashByKey, left };
}

/**
 * Bills to tick for the operator. R-1911 first: a payment of exactly this amount already recorded
 * outside the bank (Bills page / Mark paid) IS this line — it is ticked, and the bill it paid is
 * never offered as a second payment (QuickBooks "match, don't add again"); with several, the one
 * recorded nearest the bank date. Else the ONE bill whose cash due (after its planned TDS) equals
 * the debit; else ALL open bills when together they equal it. Anything else → none (the operator picks).
 */
export function preselect(
  items: readonly VendorOpenItem[],
  debit: number,
  /** TDS per bill when exactly these bills are paid together (planTds). */
  tdsFor: (bills: readonly VendorOpenItem[]) => ReadonlyMap<string, number>,
  /** The bank line's date — picks the nearest of several same-amount recorded payments. */
  txnDate?: string,
): { keys: string[]; noTds: boolean } {
  const recorded = items.filter((i) => isRecorded(i) && i.amount_due === debit);
  if (recorded.length) {
    const t = txnDate ? Date.parse(txnDate) : NaN;
    const gap = (i: VendorOpenItem) => (Number.isNaN(t) ? 0 : Math.abs(Date.parse(i.paid_on ?? i.doc_date) - t));
    const best = [...recorded].sort((a, b) => gap(a) - gap(b) || a.doc_id.localeCompare(b.doc_id))[0];
    return { keys: [itemKey(best)], noTds: false };
  }
  const open = items.filter((i) => !i.in_run);
  const net = (bills: readonly VendorOpenItem[]) => {
    const t = tdsFor(bills);
    return bills.reduce((s, i) => s + cashDue(i, t.get(itemKey(i)) ?? 0), 0);
  };
  /* Without new TDS: only the TDS already on a bill comes off. */
  const gross = (bills: readonly VendorOpenItem[]) => bills.reduce((s, i) => s + cashDue(i, i.tds_amount), 0);
  const tries: Array<[(b: readonly VendorOpenItem[]) => number, boolean]> = [[net, false], [gross, true]];
  for (const [cash, noTds] of tries) {
    const one = open.filter((i) => cash([i]) === debit);
    if (one.length === 1) return { keys: [itemKey(one[0])], noTds };
  }
  for (const [cash, noTds] of tries) {
    if (open.length > 1 && cash(open) === debit) return { keys: open.map(itemKey), noTds };
  }
  return { keys: [], noTds: false };
}

/** planTds as a key → TDS map. */
export function tdsMap(lines: readonly TdsLine[]): Map<string, number> {
  return new Map(lines.map((t) => [t.key, t.tds]));
}

/* ─── Amount check ──────────────────────────────────────────────────────────────────── */

export interface PaySummary {
  bills: number;      // cash to the picked bills
  newBill: number;    // cash to the new bill
  advance: number;
  charge: number;
  total: number;
  /** debit − total: > 0 money not yet placed, < 0 more placed than the bank paid. */
  diff: number;
}

export function summarise(debit: number, parts: { bills: number; newBill: number; advance: number; charge: number }): PaySummary {
  const r = (n: number) => Math.max(0, Math.round(n || 0));
  const bills = r(parts.bills), newBill = r(parts.newBill), advance = r(parts.advance), charge = r(parts.charge);
  const total = bills + newBill + advance + charge;
  return { bills, newBill, advance, charge, total, diff: debit - total };
}

/* ─── New bill on the spot ──────────────────────────────────────────────────────────── */

export interface NewBillDraft {
  kind: "cogs" | "expense";
  billNo: string;
  billDate: string;
  category: string;
  taxable: number;
  gst: number;
  itc: boolean;
  /** Gross settled now (COGS may be part; an expense bill is paid in full). */
  pay: number;
}

export const newBillTotal = (b: Pick<NewBillDraft, "taxable" | "gst">) => Math.max(0, Math.round(b.taxable || 0)) + Math.max(0, Math.round(b.gst || 0));

/* ─── RPC arguments ─────────────────────────────────────────────────────────────────── */

export interface PayInput {
  transactionId: string;
  vendorId: string | null;
  /** R-1918: accountNo / ifsc / upi — pre-filled from the bank narration, saved on the vendor so
   *  the next line from it is guessed. */
  newVendor: {
    name: string; gstin: string | null; pan: string | null; tdsSection: string | null;
    accountNo?: string | null; ifsc?: string | null; upi?: string | null;
  } | null;
  /** Bills: gross settled (cash + TDS) and the TDS on it. */
  items: ReadonlyArray<{ item: VendorOpenItem; cash: number; tds: number; section: string | null }>;
  newBill: (NewBillDraft & { tds: number; tdsSection: string | null }) | null;
  advance: number;
  advanceCategory: string | null;
  bankCharge: number;
  note: string | null;
}

/** R-1918: the new vendor's bank details for the server. The IFSC goes only with an account
 *  number (R-1905: they are a pair; a payment run needs both). */
function newVendorBank(v: NonNullable<PayInput["newVendor"]>) {
  const acc = cleanAccountNo(v.accountNo ?? "") || null;
  return {
    bank_account_no: acc,
    bank_ifsc: acc ? cleanIfsc(v.ifsc ?? "") || null : null,
    upi_id: (v.upi ?? "").trim().toLowerCase() || null,
  };
}

/** The arguments of reconcile_bank_debit_to_vendor — exported so the tests pin what reaches the server. */
export function payArgs(i: PayInput) {
  const n = (x: number) => Math.max(0, Math.round(x || 0));
  return {
    p_txn_id: i.transactionId,
    p_vendor_id: i.vendorId,
    p_new_vendor: i.vendorId ? null : i.newVendor && {
      name: i.newVendor.name.trim(),
      gstin: i.newVendor.gstin?.trim().toUpperCase() || null,
      pan: i.newVendor.pan?.trim().toUpperCase() || null,
      tds_section: i.newVendor.tdsSection || null,
      ...newVendorBank(i.newVendor),
    },
    p_items: i.items.filter((x) => x.cash > 0).map((x) => ({
      source: x.item.source,
      doc_id: x.item.doc_id,
      amount: n(x.cash) + n(x.tds),
      tds_amount: n(x.tds),
      tds_section: x.tds > 0 ? x.section : null,
    })),
    p_new_bill: i.newBill && {
      kind: i.newBill.kind,
      bill_no: i.newBill.billNo.trim() || null,
      bill_date: i.newBill.billDate,
      category: i.newBill.category,
      taxable: n(i.newBill.taxable),
      gst: n(i.newBill.gst),
      itc: i.newBill.itc,
      tds_amount: n(i.newBill.tds),
      tds_section: i.newBill.tds > 0 ? i.newBill.tdsSection : null,
      pay: n(i.newBill.pay),
    },
    p_advance: n(i.advance),
    p_advance_category: i.advance > 0 ? i.advanceCategory : null,
    p_bank_charge: n(i.bankCharge),
    p_note: i.note,
  };
}

/* ─── After the save ────────────────────────────────────────────────────────────────── */

export interface PaidDoc {
  source: PaySource; doc_id: string; bill_no: string | null;
  settled: number; cash: number; tds: number; tds_section: string | null; status: string; still_due: number; total?: number;
  /** R-1911 recorded_payment: what the matched payment had paid, and when it was recorded. */
  pays_source?: "vendor_bill" | "expense"; paid_on?: string;
}

export interface VendorPayResult {
  vendor_id: string;
  vendor_name: string;
  vendor_created: boolean;
  bank_amount: number;
  paid: PaidDoc[];
  new_bill: PaidDoc | null;
  advance: { id: string; amount: number; category: string } | null;
  bank_charge: { expense_id: string; amount: number } | null;
  tds_total: number;
  tds_section: string | null;
}

export interface ResultLine { text: string; href?: string; tone?: "warn" }

const docHref = (d: Pick<PaidDoc, "source" | "doc_id" | "pays_source">) =>
  d.source === "expense" || (d.source === "recorded_payment" && d.pays_source === "expense")
    ? `/accounting/expenses?edit=${encodeURIComponent(d.doc_id)}` : "/accounting/bills";

const statusWord = (d: PaidDoc) => (d.status === "paid" ? "Paid" : `part paid, ${rupee(d.still_due)} still due`);

function docLine(d: PaidDoc, vendor: string, isNew: boolean): ResultLine {
  if (d.source === "recorded_payment") {
    const what = d.bill_no ? `Bill #${d.bill_no}` : d.pays_source === "expense" ? "the expense" : "the bill";
    const where = d.pays_source === "expense" ? "the Expenses page" : "the Bills page";
    return {
      text: `Matched to the ${rupee(d.settled)} already paid to ${vendor} on ${d.paid_on ? formatDate(d.paid_on) : "an earlier date"} from ${where} for ${what} — counted once, not paid again · ${d.status === "paid" ? "Paid" : `Bill now ${statusWord(d)}`}`,
      href: docHref(d),
    };
  }
  const name = d.bill_no ? `Bill #${d.bill_no}` : d.source === "expense" ? "Expense bill" : "COGS bill";
  const tds = d.tds > 0 ? ` · TDS ${rupee(d.tds)} deducted (${d.tds_section})` : "";
  return {
    text: `${isNew ? "Recorded and paid" : "Paid"} ${name} (${rupee(d.settled)}) to ${vendor}${tds} · ${isNew && d.status === "paid" ? "Paid" : `Bill now ${statusWord(d)}`}`,
    href: docHref(d),
  };
}

export function resultLines(r: VendorPayResult): ResultLine[] {
  const out: ResultLine[] = [];
  if (r.vendor_created) out.push({ text: `New vendor ${r.vendor_name} added`, href: "/accounting/vendors" });
  for (const d of r.paid) out.push(docLine(d, r.vendor_name, false));
  if (r.new_bill) out.push(docLine(r.new_bill, r.vendor_name, true));
  if (r.advance) out.push({ text: `${rupee(r.advance.amount)} kept as an advance to ${r.vendor_name} (${r.advance.category}) — adjust a later bill on Prepaid`, href: "/accounting/prepaid" });
  if (r.bank_charge) out.push({ text: `Bank charge ${rupee(r.bank_charge.amount)} booked as an expense`, href: `/accounting/expenses?edit=${encodeURIComponent(r.bank_charge.expense_id)}` });
  if (r.tds_total > 0) out.push({ text: `TDS ${rupee(r.tds_total)} (${r.tds_section}) withheld — now in TDS payable and the 26Q list`, href: "/accounting/balance-sheet" });
  out.push({ text: `${r.vendor_name}: see bills and payments`, href: "/accounting/vendors" });
  return out;
}
