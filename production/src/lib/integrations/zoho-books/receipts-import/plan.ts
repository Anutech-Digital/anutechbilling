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
 *
 * R-2703 (12 Nov 2026) — the reason for a line whose invoice is NOT an FY sale imported from Zoho says
 * what that invoice is. Nothing more is BOOKED than before, except that a ₹0 line no longer blocks:
 *   - a ₹0 line of a ₹ payment (paise only) books nothing and blocks nothing — on any invoice;
 *   - an opening invoice here: already paid → "in the books already"; money still due → by hand (its
 *     balance was taken when it was added — R-1739 stores what was due THAT day — so it may already
 *     leave this receipt out; the import cannot know, a person can);
 *   - this year's invoice that Zoho has (it is in the year's invoice scan) → "import FY sales first" —
 *     the only case that says so (and when the year's invoices were not read at all);
 *   - a credit / debit note; an EARLIER year's invoice (→ add it as an opening invoice); a LATER year's
 *     (→ record the payment on that invoice in the app); an invoice numbered in this year that is not
 *     among the year's Zoho invoices (→ check its date).
 *   The year is Zoho's invoice date when the facts carry it (read from R-2703 on), else the "24-25" in
 *   the number. import_zoho_fy_receipts (migration r2703) gives the same reasons.
 * Pure: no I/O.
 */
import { OLD_BANK_CHARGES_PROBLEM, foreignOf, inrAmountOf, isRazorpayPayment, type ZohoReceiptFacts } from "./normalise";
import { defaultCashAccountId, depositAccounts, type DepositAccount as AppBankAccount } from "@/lib/payments/deposit-accounts";
import { fyLabelOfYear, fyStartYear } from "@/lib/dates/ist";

export type { AppBankAccount };

export const RECEIPTS_IMPORT_ROLES = ["owner", "accountant"] as const;

/** The dialog's "Leave these out" choice for a Zoho deposit account (in place of an app account id) —
 *  the same marker as the purchase import's (purchase-import/plan.ts LEAVE_OUT). */
export const LEAVE_OUT = "none";
export const LEFT_OUT_REASON = "Left out by owner.";
/** R-2565: a booked Razorpay fee payment waits for its Razorpay settlement line (R-2099), not a line of its own. */
export const SETTLEMENT_WAIT_REASON = "Booked — waits for its Razorpay settlement (Banking → the settlement line → Reconcile).";

export interface AppZohoInvoice {
  id: string;
  zohoInvoiceId: string | null;
  externalNumber: string | null;
  documentKind: string;
  customerId: string | null;
  /** What is still due on it (net payable − paid). */
  due: number;
  /** R-2703: void here (its due is 0, but it is not "paid"). */
  voided?: boolean;
}

export interface ReceiptsPlanContext {
  fyStart: string;
  fyEnd: string;
  booksStart: string | null;
  lockedUntil: string | null;
  invoices: AppZohoInvoice[];
  bankAccounts: AppBankAccount[];
  /** Zoho payment ids already booked (zoho_fy_receipts), with whether a bank line is on them. */
  booked: Map<string, { banked: boolean; viaSettlement?: boolean }>;
  /** Zoho deposit account id → the app account the owner chose, LEAVE_OUT, or "" (chosen: none). */
  accountMap: Record<string, string>;
  /** R-2703: the Zoho invoice ids in this year's invoice scan (read from Zoho, imported or not).
   *  Absent / empty = the year's invoices were not read yet. */
  fyInvoiceIds?: ReadonlySet<string>;
}

export type ReceiptVerdict = "import" | "already" | "skip";

export interface PlannedReceipt {
  facts: ZohoReceiptFacts;
  verdict: ReceiptVerdict;
  reason: string | null;
  customerId: string | null;
  bankAccountId: string | null;
  /** App invoice id per Zoho line (same order as facts.lines); null = a ₹0 line (R-2703: books nothing). */
  invoiceIds: (string | null)[];
}

/** R-2693: amountUnknown = payments of this account whose ₹ is not known (a foreign-currency one read
 *  before R-2693 or with no Zoho rate) — not in `amount`. */
export interface ZohoDeposit { zohoAccountId: string; zohoName: string; count: number; amount: number; amountUnknown?: number; appAccountId: string | null; suggested: boolean; leftOut: boolean }

export interface ReceiptsPlan {
  rows: PlannedReceipt[];
  /** R-2565: withFee = payments to record whose Razorpay fee is booked as Bank Charges (its sum in totals.fee). */
  counts: { scanned: number; import: number; already: number; alreadyNotBanked: number; skip: number; withFee: number };
  totals: { cash: number; tds: number; excess: number; fee: number };
  deposits: ZohoDeposit[];
  skipReasons: { reason: string; count: number }[];
}

/** One skip reason per KIND (amounts, invoice numbers, names and dates taken out) — the "Left out, and
 *  why" counts. R-2693: exported so the check's refusals are grouped the same way; also takes out ISO
 *  dates ("Dated 2025-03-31, …") and Razorpay ids (pay_…), so one kind is one line with its count. */
export const skipReasonKey = (r: string) => r.replace(/₹[\d,.]+|[A-Z]*INV\S*|"[^"]*"|\d{1,2} \w{3} \d{4}|\d{4}-\d{2}-\d{2}|pay_[A-Za-z0-9]+/g, "…");
const digits = (s: string) => s.replace(/\D+/g, "");

/** R-2703: the financial year (its April's year) a Zoho invoice belongs to — Zoho's invoice date when
 *  the facts carry it, else the "24-25" in its number (two-digit years that follow each other); null =
 *  not known. A number can lie (INV/25-26/1979 is dated 28 Jan 2025) — so the date wins. */
export function invoiceYearOf(line: { invoiceNumber: string; invoiceDate?: string }): number | null {
  const on = line.invoiceDate ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(on)) return fyStartYear(on);
  for (const m of line.invoiceNumber.matchAll(/(?<!\d)(\d{2})-(\d{2})(?!\d)/g)) {
    if ((Number(m[1]) + 1) % 100 === Number(m[2])) return 2000 + Number(m[1]);
  }
  return null;
}

/** R-2703: Zoho's credit / debit note numbers (CDN-000004, CN-00012, DN-7). */
const isNoteNumber = (n: string) => /^(CDN|CN|DN)[-/ ]?\d/i.test(n.trim());

/** This year's invoice that is not in the app yet (Zoho has it; the sales import left it out or was not run). */
const notImported = (no: string) => `${no} is not an FY sale imported from Zoho here — import FY sales first (Invoices → FY 2025-26 sales from Zoho).`;

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
  const fyYear = fyStartYear(ctx.fyStart);
  const ownAccounts = new Set(depositAccounts(ctx.bankAccounts).map((a) => a.id));
  const customerOf = new Map(ctx.invoices.map((i) => [i.id, i.customerId ?? ""]));

  /* Deposit accounts: the owner's choice, else a suggestion. */
  const deposits = new Map<string, ZohoDeposit>();
  for (const f of facts) {
    const key = f.depositAccountId || "";
    const d = deposits.get(key) ?? { zohoAccountId: key, zohoName: f.depositAccountName || "(no account in Zoho)", count: 0, amount: 0, appAccountId: null, suggested: false, leftOut: false };
    d.count += 1;
    /* R-2693: a USD payment at Zoho's rate, never its dollars as ₹; one whose ₹ is not known is counted
       apart (the screen says so) — never silently added as ₹0. */
    const inr = inrAmountOf(f);
    if (inr === null) d.amountUnknown = (d.amountUnknown ?? 0) + 1;
    else d.amount += inr;
    deposits.set(key, d);
  }
  for (const d of deposits.values()) {
    const chosen = Object.prototype.hasOwnProperty.call(ctx.accountMap, d.zohoAccountId) ? ctx.accountMap[d.zohoAccountId] : undefined;
    if (chosen === LEAVE_OUT) d.leftOut = true;                       // never mapped, whatever the suggestion
    else if (chosen && ownAccounts.has(chosen)) d.appAccountId = chosen;
    /* "" = the owner chose none: no suggestion fills it. */
    else if (chosen !== "" && suggest) { d.appAccountId = suggestAccount(d.zohoName, ctx.bankAccounts); d.suggested = d.appAccountId !== null; }
  }

  /* What each invoice can still take, as this preview books the payments one after another. */
  const left = new Map(ctx.invoices.map((i) => [i.id, i.due]));

  const rows: PlannedReceipt[] = facts.map((f) => {
    const dep = deposits.get(f.depositAccountId || "");
    const bankAccountId = dep?.appAccountId ?? null;
    const fx = foreignOf(f);
    /* R-2703: a ₹0 line of a ₹ payment (paise only) books nothing — on any invoice, known or not. */
    const zeroLine = (l: ZohoReceiptFacts["lines"][number]) => !fx && l.settle === 0 && l.tds === 0;
    const invoiceIds = f.lines.map((l) => (zeroLine(l) ? null : byZoho.get(l.zohoInvoiceId)?.id ?? null));
    const row = (verdict: ReceiptVerdict, reason: string | null, customerId: string | null = null): PlannedReceipt =>
      ({ facts: f, verdict, reason, customerId, bankAccountId, invoiceIds });

    const done = ctx.booked.get(f.zohoId);
    /* Left out: never a pick — not booked, and an earlier booking is not bank-matched from here either. */
    if (dep?.leftOut) return row("skip", done ? "Left out by owner — recorded by an earlier import (Remove import takes it out)." : LEFT_OUT_REASON);
    /* R-2565: a Razorpay fee payment reaches the bank inside a Razorpay settlement — matched there
       (Banking → the settlement line → Reconcile, R-2099), never one by one from here. */
    if (done && !done.banked && done.viaSettlement) return row("already", SETTLEMENT_WAIT_REASON);
    if (done) return row("already", done.banked ? null : "Booked — its bank line is not matched yet (Import again matches it once the statement is in).");
    /* R-2565: read before Razorpay's fee could be booked — the fee is in the facts only after a new read. */
    if (f.problems[0] === OLD_BANK_CHARGES_PROBLEM) {
      return row("skip", isRazorpayPayment(f.zohoMode, f.depositAccountName)
        ? "Read from Zoho again — a Razorpay fee payment can be imported now (fee booked as Bank Charges)."
        : "Zoho took bank charges off this payment and it is not a Razorpay payment — book it by hand.");
    }
    /* R-2694: a foreign payment read before it could be imported (no per-invoice foreign amounts) —
       Read again fetches only these (fy-import receiptFactsIncomplete). */
    if (fx && !f.foreignLines && f.fxRate) {
      return row("skip", `Read from Zoho again — a ${fx.currency} payment can be imported now (₹ at the invoice's rate, exchange gain / loss booked).`);
    }
    if (f.problems.length) return row("skip", f.problems[0]);
    if (!f.date || f.date < ctx.fyStart || f.date > ctx.fyEnd) return row("skip", `Dated ${f.date || "?"}, outside the year.`);
    if (!ctx.booksStart) return row("skip", "The books start date is not set (Accounting → Overview → Books start).");
    if (f.date < ctx.booksStart) return row("skip", `Dated ${f.date}, before the books start (${ctx.booksStart}).`);
    if (ctx.lockedUntil && f.date <= ctx.lockedUntil) return row("skip", `Dated ${f.date}, inside the books lock (till ${ctx.lockedUntil}). Unlock the books first.`);
    if (!f.lines.length) return row("skip", "Not applied to any invoice in Zoho (an advance) — record it by hand on the right customer.");
    for (let k = 0; k < f.lines.length; k++) {
      if (invoiceIds[k]) continue;
      const l = f.lines[k];
      if (zeroLine(l)) continue;
      /* R-2703: what the invoice is, and what to do — never booked from here (the header says why). */
      const no = l.invoiceNumber;
      const other = byNumber.get(no.trim().toUpperCase());
      if (other?.documentKind === "opening_invoice") {
        if (other.voided) return row("skip", `${no} is an opening invoice that is void here — book this payment by hand.`);
        if (other.due <= 0) return row("skip", `${no} is an opening invoice that is already paid here — this receipt is in the books already.`);
        return row("skip", `${no} is an opening invoice here with ₹${other.due} still due — its balance was taken when it was added and may already leave this receipt out. If it does not, record this payment on it by hand (Invoices → ${no} → Record payment).`);
      }
      if (ctx.fyInvoiceIds?.has(l.zohoInvoiceId)) return row("skip", notImported(no));
      if (isNoteNumber(no)) return row("skip", `${no} is a credit / debit note in Zoho, not an invoice — book this payment by hand.`);
      const year = invoiceYearOf(l);
      if (year !== null && year < fyYear) {
        return row("skip", fx
          ? `${no} is an invoice of FY ${fyLabelOfYear(year)} and this payment is in ${fx.currency} — book it by hand.`
          : `${no} is an invoice of FY ${fyLabelOfYear(year)} — add it as an opening invoice, then record this payment on it.`);
      }
      if (year !== null && year > fyYear) {
        return row("skip", `${no} is an invoice of FY ${fyLabelOfYear(year)} — record this payment on that invoice in the app.`);
      }
      if (ctx.fyInvoiceIds?.size) {
        return row("skip", `${no} is not among the FY ${fyLabelOfYear(fyYear)} invoices read from Zoho — check its date in Zoho: an earlier year's invoice is added as an opening invoice, a later year's is paid in the app.`);
      }
      return row("skip", notImported(no));
    }
    const booking = invoiceIds.filter((id): id is string => id !== null);
    if (!booking.length) return row("skip", "Zoho applies no whole rupee of this payment to an invoice — record it by hand.");
    const custs = new Set(booking.map((id) => customerOf.get(id) ?? ""));
    if (custs.size !== 1 || custs.has("")) return row("skip", "Its invoices belong to different customers here.");
    const customerId = [...custs][0];
    /* R-2694: a foreign payment's lines are in its currency — the ₹ (at each invoice's own rate) and the
       "more than due" refusal are the import's (SQL knows the invoice's rate); here only ₹ lines. */
    const inrSettle = (k: number) => (fx ? Math.round((f.foreignLines?.[k]?.foreign ?? 0) * (f.fxRate ?? 0)) : f.lines[k].settle);
    for (let k = 0; !fx && k < f.lines.length; k++) {
      const id = invoiceIds[k];
      if (!id) continue;
      const due = left.get(id) ?? 0;
      if (f.lines[k].settle > due + 1) return row("skip", `${f.lines[k].invoiceNumber} has only ₹${due} due here, but Zoho settles ₹${f.lines[k].settle} with this payment.`, customerId);
    }
    if (!bankAccountId) return row("skip", `Choose the app account for Zoho's "${f.depositAccountName || "no account"}".`, customerId);
    for (let k = 0; k < f.lines.length; k++) {
      const id = invoiceIds[k];
      if (id) left.set(id, Math.max(0, (left.get(id) ?? 0) - inrSettle(k)));
    }
    return row("import", null, customerId);
  });

  const counts = { scanned: rows.length, import: 0, already: 0, alreadyNotBanked: 0, skip: 0, withFee: 0 };
  const totals = { cash: 0, tds: 0, excess: 0, fee: 0 };
  const why = new Map<string, number>();
  for (const r of rows) {
    counts[r.verdict] += 1;
    if (r.verdict === "already" && r.reason && r.reason !== SETTLEMENT_WAIT_REASON) counts.alreadyNotBanked += 1;
    if (r.verdict === "import") {
      totals.cash += r.facts.amount; totals.tds += r.facts.tds; totals.excess += r.facts.excess;
      const fee = r.facts.fee ?? 0;   // facts read before R-2565 carry no fee
      if (fee > 0) { counts.withFee += 1; totals.fee += fee; }
    }
    if (r.verdict === "skip" && r.reason) why.set(skipReasonKey(r.reason), (why.get(skipReasonKey(r.reason)) ?? 0) + 1);
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
