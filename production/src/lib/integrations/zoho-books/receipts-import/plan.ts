/**
 * R-2501 (G-FY2526) — which scanned Zoho customer payments become FY 2025-26 receipts on the imported
 * Zoho invoices (R-2499), and why the others do not. The preview: the SQL import
 * (import_zoho_fy_receipts) checks every rule again and takes every amount from the scan.
 *
 * Safe defaults (card needsDecision):
 *   - every invoice the payment applies to must be an FY sale imported from Zoho (invoices.zoho_invoice_id);
 *     one that is not (last year's opening invoice, a skipped import) → the WHOLE payment is skipped and
 *     reported — a receipt is never split between "booked" and "left out";
 *   - an opening invoice (R-1739) is never paid from here: its balance was taken after these receipts,
 *     so paying it again would count them twice — R-2504 re-states those first;
 *   - a payment with no invoice at all (pure advance) → skipped (book it by hand: which customer is it?);
 *   - Zoho's deposit account must be mapped to one of the company's bank / cash accounts — or the owner
 *     LEAVES IT OUT (R-2501 fix, 6 Nov: Pardeep left out Kachha Khata + Petty Cash): its payments are
 *     listed as skipped "Left out by owner." and never mapped automatically. A suggestion is only made
 *     for the PREVIEW (shown in the dialog, changeable); the import uses only what the dialog sent.
 * Pure: no I/O.
 */
import type { ZohoReceiptFacts } from "./normalise";
import { defaultCashAccountId, depositAccounts, type DepositAccount as AppBankAccount } from "@/lib/payments/deposit-accounts";

export type { AppBankAccount };

export const RECEIPTS_IMPORT_ROLES = ["owner", "accountant"] as const;

/** The dialog's "Leave out" choice for a Zoho deposit account (in place of an app account id). */
export const LEAVE_OUT = "leave-out";
export const LEFT_OUT_REASON = "Left out by owner.";

export interface AppZohoInvoice {
  id: string;
  zohoInvoiceId: string | null;
  externalNumber: string | null;
  documentKind: string;
  customerId: string | null;
  /** What is still due on it (net payable − paid). */
  due: number;
}

export interface ReceiptsPlanContext {
  fyStart: string;
  fyEnd: string;
  booksStart: string | null;
  lockedUntil: string | null;
  invoices: AppZohoInvoice[];
  bankAccounts: AppBankAccount[];
  /** Zoho payment ids already booked (zoho_fy_receipts), with whether a bank line is on them. */
  booked: Map<string, { banked: boolean }>;
  /** Zoho deposit account id → the app account the owner chose, LEAVE_OUT, or "" (chosen: none). */
  accountMap: Record<string, string>;
}

export type ReceiptVerdict = "import" | "already" | "skip";

export interface PlannedReceipt {
  facts: ZohoReceiptFacts;
  verdict: ReceiptVerdict;
  reason: string | null;
  customerId: string | null;
  bankAccountId: string | null;
  /** App invoice id per Zoho line (same order as facts.lines). */
  invoiceIds: (string | null)[];
}

export interface ZohoDeposit { zohoAccountId: string; zohoName: string; count: number; amount: number; appAccountId: string | null; suggested: boolean; leftOut: boolean }

export interface ReceiptsPlan {
  rows: PlannedReceipt[];
  counts: { scanned: number; import: number; already: number; alreadyNotBanked: number; skip: number };
  totals: { cash: number; tds: number; excess: number };
  deposits: ZohoDeposit[];
  skipReasons: { reason: string; count: number }[];
}

const reasonKey = (r: string) => r.replace(/₹[\d,.]+|INV\S*|"[^"]*"|\d{1,2} \w{3} \d{4}/g, "…");
const digits = (s: string) => s.replace(/\D+/g, "");

/**
 * The app account Zoho's deposit account most likely is — among the accounts Record payment offers
 * (depositAccounts: active, no credit card): same last 4 digits, else the same name, else (a cash
 * account in Zoho) the company's cash account (defaultCashAccountId). Otherwise none: a guess is
 * worse than asking.
 */
export function suggestAccount(zohoName: string, accounts: readonly AppBankAccount[]): string | null {
  const live = depositAccounts(accounts);
  const d = digits(zohoName);
  if (d.length >= 4) {
    const hit = live.filter((a) => a.account_number_last4 && d.endsWith(a.account_number_last4));
    if (hit.length === 1) return hit[0].id;
  }
  const n = zohoName.trim().toLowerCase();
  if (!n) return null;
  const byName = live.filter((a) => a.name.trim().toLowerCase() === n || `${a.bank_name ?? ""} ${a.name}`.trim().toLowerCase() === n);
  if (byName.length === 1) return byName[0].id;
  if (/petty|cash/.test(n)) return defaultCashAccountId(accounts) || null;
  return null;
}

/**
 * `suggest`: true for the preview (the dialog shows each suggestion and sends it back as the owner's
 * choice); false for the import — a Zoho account the dialog did not send gets no account (skipped).
 */
export function buildReceiptsPlan(facts: readonly ZohoReceiptFacts[], ctx: ReceiptsPlanContext, opts: { suggest?: boolean } = {}): ReceiptsPlan {
  const suggest = opts.suggest ?? true;
  const byZoho = new Map<string, AppZohoInvoice>();
  const byNumber = new Map<string, AppZohoInvoice>();
  for (const i of ctx.invoices) {
    if (i.zohoInvoiceId) byZoho.set(i.zohoInvoiceId, i);
    if (i.externalNumber) byNumber.set(i.externalNumber.trim().toUpperCase(), i);
  }
  const ownAccounts = new Set(depositAccounts(ctx.bankAccounts).map((a) => a.id));
  const customerOf = new Map(ctx.invoices.map((i) => [i.id, i.customerId ?? ""]));

  /* Deposit accounts: the owner's choice, else a suggestion. */
  const deposits = new Map<string, ZohoDeposit>();
  for (const f of facts) {
    const key = f.depositAccountId || "";
    const d = deposits.get(key) ?? { zohoAccountId: key, zohoName: f.depositAccountName || "(no account in Zoho)", count: 0, amount: 0, appAccountId: null, suggested: false, leftOut: false };
    d.count += 1;
    d.amount += f.amount;
    deposits.set(key, d);
  }
  for (const d of deposits.values()) {
    const chosen = Object.prototype.hasOwnProperty.call(ctx.accountMap, d.zohoAccountId) ? ctx.accountMap[d.zohoAccountId] : undefined;
    if (chosen === LEAVE_OUT) d.leftOut = true;                       // never mapped, whatever the suggestion
    else if (chosen && ownAccounts.has(chosen)) d.appAccountId = chosen;
    else if (chosen === "") d.appAccountId = null;                    // the owner chose none: no suggestion fills it
    else if (suggest) { d.appAccountId = suggestAccount(d.zohoName, ctx.bankAccounts); d.suggested = d.appAccountId !== null; }
  }

  /* What each invoice can still take, as this preview books the payments one after another. */
  const left = new Map(ctx.invoices.map((i) => [i.id, i.due]));

  const rows: PlannedReceipt[] = facts.map((f) => {
    const dep = deposits.get(f.depositAccountId || "");
    const bankAccountId = dep?.appAccountId ?? null;
    const invoiceIds = f.lines.map((l) => byZoho.get(l.zohoInvoiceId)?.id ?? null);
    const row = (verdict: ReceiptVerdict, reason: string | null, customerId: string | null = null): PlannedReceipt =>
      ({ facts: f, verdict, reason, customerId, bankAccountId, invoiceIds });

    const done = ctx.booked.get(f.zohoId);
    if (done) return row("already", done.banked ? null : "Booked — its bank line is not matched yet (Import again matches it once the statement is in).");
    if (dep?.leftOut) return row("skip", LEFT_OUT_REASON);
    if (f.problems.length) return row("skip", f.problems[0]);
    if (!f.date || f.date < ctx.fyStart || f.date > ctx.fyEnd) return row("skip", `Dated ${f.date || "?"}, outside the year.`);
    if (!ctx.booksStart) return row("skip", "The books start date is not set (Accounting → Overview → Books start).");
    if (f.date < ctx.booksStart) return row("skip", `Dated ${f.date}, before the books start (${ctx.booksStart}).`);
    if (ctx.lockedUntil && f.date <= ctx.lockedUntil) return row("skip", `Dated ${f.date}, inside the books lock (till ${ctx.lockedUntil}). Unlock the books first.`);
    if (!f.lines.length) return row("skip", "Not applied to any invoice in Zoho (an advance) — record it by hand on the right customer.");
    for (let k = 0; k < f.lines.length; k++) {
      if (invoiceIds[k]) continue;
      const l = f.lines[k];
      const other = byNumber.get(l.invoiceNumber.trim().toUpperCase());
      if (other?.documentKind === "opening_invoice") {
        return row("skip", `${l.invoiceNumber} is an opening invoice here — its balance already leaves this receipt out (re-stated by R-2504 first).`);
      }
      return row("skip", `${l.invoiceNumber} is not an FY sale imported from Zoho here — import FY sales first (Invoices → FY 2025-26 sales from Zoho).`);
    }
    const custs = new Set(invoiceIds.map((id) => customerOf.get(id!) ?? ""));
    if (custs.size !== 1 || custs.has("")) return row("skip", "Its invoices belong to different customers here.");
    const customerId = [...custs][0];
    for (let k = 0; k < f.lines.length; k++) {
      const id = invoiceIds[k]!;
      const due = left.get(id) ?? 0;
      if (f.lines[k].settle > due + 1) return row("skip", `${f.lines[k].invoiceNumber} has only ₹${due} due here, but Zoho settles ₹${f.lines[k].settle} with this payment.`, customerId);
    }
    if (!bankAccountId) return row("skip", `Choose the app account for Zoho's "${f.depositAccountName || "no account"}".`, customerId);
    for (let k = 0; k < f.lines.length; k++) {
      const id = invoiceIds[k]!;
      left.set(id, Math.max(0, (left.get(id) ?? 0) - f.lines[k].settle));
    }
    return row("import", null, customerId);
  });

  const counts = { scanned: rows.length, import: 0, already: 0, alreadyNotBanked: 0, skip: 0 };
  const totals = { cash: 0, tds: 0, excess: 0 };
  const why = new Map<string, number>();
  for (const r of rows) {
    counts[r.verdict] += 1;
    if (r.verdict === "already" && r.reason) counts.alreadyNotBanked += 1;
    if (r.verdict === "import") { totals.cash += r.facts.amount; totals.tds += r.facts.tds; totals.excess += r.facts.excess; }
    if (r.verdict === "skip" && r.reason) why.set(reasonKey(r.reason), (why.get(reasonKey(r.reason)) ?? 0) + 1);
  }
  return {
    rows, counts, totals,
    deposits: [...deposits.values()].sort((a, b) => b.count - a.count),
    skipReasons: [...why.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

/** What the browser's import names per payment — no money (the SQL reads it from the scan). */
export function toReceiptPick(r: PlannedReceipt) {
  return { zoho_payment_id: r.facts.zohoId, bank_account_id: r.bankAccountId };
}
