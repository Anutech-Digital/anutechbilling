/**
 * R-2378 — what a "manual" bank line really booked.
 *
 * OD / loan audit, 2 Nov 2026: 8 Bajaj / Tata lines booked through Reconcile → Loan / EMI → "Loan /
 * advance with a person" (book_bank_advance — a balance-sheet liability) read back as "reconciled
 * manually, no entry", so the audit took them for unbooked lines. Those RPCs (and every flow that
 * writes its own cash line — staff loans, loans given, business loans, asset EMIs, staff advances,
 * statutory challans) store matched_to_type = 'manual' and keep the link on their own table.
 * bank_line_bookings(account) (migration 20261107151806) finds that link; this file turns it into
 * the words the line shows — "Loan received · Bajaj Finance" — and the page that holds the booking.
 * A 'manual' line with no booking (a real "Mark reconciled manually", with its reason) is not in the
 * map and keeps reading "Reconciled".
 * R-2570: those flows now store their own type + id (bs_item, employee_loan, reimbursement, loan_given,
 * business_loan, loan_repayment, emi, statutory); bank_line_bookings() reads those lines too
 * (BOOKING_LOOKUP_TYPES in bank-filters), so old and new lines show the same words.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { lineBookingText, type MatchGroup } from "@/lib/banking/bank-filters";

export { lineBookingText };

/** One row of bank_line_bookings(). */
export interface LineBookingRow {
  txn_id: string;
  source: string;
  sub: string | null;
  party: string | null;
  amount: number | string | null;
}

/** What a booked 'manual' line shows: the kind, the party, and where the booking lives. */
export interface LineBooking {
  /** "Loan received", "Advance given", "Staff loan given", … — the line's badge. */
  label: string;
  /** "Bajaj Finance" — null when the booking names nobody. */
  party: string | null;
  /** The page that lists this booking (the party's loan / advance / balance-sheet line). */
  href: string;
  /** The page's name, for the link's title. */
  hrefLabel: string;
  /** The "Matched to" filter group the line belongs to. */
  group: MatchGroup;
}

/* The words book_bank_advance / book_bank_credit put in front of the party in balance_sheet_items.label. */
const BS_PREFIXES = ["Advance/loan given", "Advance/loan returned", "Loan received", "Loan repaid"];
const BS_DEFAULT_LABELS = new Set(["Owner's capital", "Director's loan"]);

/** "Loan received · Bajaj Finance" → "Bajaj Finance"; a bare default label → null; a typed label stays. */
export function bsItemParty(label: string | null): string | null {
  const l = (label ?? "").trim();
  if (!l) return null;
  for (const p of BS_PREFIXES) {
    if (l === p) return null;
    if (l.startsWith(`${p} · `)) return l.slice(p.length + 3).trim() || null;
  }
  return BS_DEFAULT_LABELS.has(l) ? null : l;
}

const clean = (s: string | null | undefined): string | null => (s ?? "").trim() || null;

/**
 * A typed label (book_bank_credit) that already says the kind is not repeated after it:
 * "Loan received from HDFC" → "HDFC", "Loan from Pardeep" / "Director's loan from Pardeep" → "Pardeep".
 * Anything else stays as typed ("HDFC OD").
 */
export function typedParty(label: string | null, kind: string): string | null {
  if (!label) return null;
  const k = kind.toLowerCase();
  const l = label.toLowerCase();
  const rest = l.startsWith(k) ? label.slice(kind.length)
    : /^(director'?s\s+)?(loan|capital|advance)\b/i.test(label) ? label.replace(/^(director'?s\s+)?(loan|capital|advance)\b/i, "")
    : null;
  if (rest === null) return label;
  return rest.replace(/^[\s·:,-]*((from|to|by)\s+)?/i, "").trim() || null;
}

const BS = { href: "/accounting/balance-sheet", hrefLabel: "Balance Sheet" };
const STAFF_LOANS = { href: "/accounting/loans", hrefLabel: "Employee Loans" };
const ADVANCES = { href: "/accounting/advances", hrefLabel: "Expense Advances" };
const REIMBURSEMENTS = { href: "/accounting/reimbursements", hrefLabel: "Reimbursements" };
const LOANS_GIVEN = { href: "/accounting/loans-given", hrefLabel: "Loans given" };
const BUSINESS_LOANS = { href: "/accounting/business-loans", hrefLabel: "Business Loans" };
const ASSETS = { href: "/accounting/assets", hrefLabel: "Assets & EMI" };
const STATUTORY = { href: "/accounting/salary-register", hrefLabel: "Salary Register" };

/** The words + link for one bank_line_bookings() row. */
export function lineBookingOf(r: LineBookingRow): LineBooking {
  const amount = Number(r.amount ?? 0);
  const party = clean(r.party);
  switch (r.source) {
    case "bs_item": {
      const p0 = bsItemParty(r.party);
      const kind = r.sub === "liability" ? (amount < 0 ? "Loan repaid" : "Loan received")
        : r.sub === "asset" ? (amount < 0 ? "Advance returned" : "Advance given")
        : r.sub === "equity" ? (amount < 0 ? "Owner's drawings" : "Owner's capital") : "Balance sheet entry";
      const p = typedParty(p0, kind);
      if (r.sub === "liability") return { label: kind, party: p, ...BS, group: "loan" };
      if (r.sub === "asset") return { label: kind, party: p, ...BS, group: "loan" };
      if (r.sub === "equity") return { label: kind, party: p, ...BS, group: "owner" };
      return { label: kind, party: p, ...BS, group: "other" };
    }
    case "employee_loan":
      if (r.sub === "expense_advance") return { label: "Expense advance given", party, ...ADVANCES, group: "expense" };
      return { label: r.sub === "salary_advance" ? "Salary advance given" : "Staff loan given", party, ...STAFF_LOANS, group: "loan" };
    case "employee_loan_reversal":
      return { label: "Staff loan reversed", party, ...STAFF_LOANS, group: "loan" };
    case "employee_loan_repayment":
      return { label: "Staff loan repaid", party, ...STAFF_LOANS, group: "loan" };
    case "employee_advance_returned":
      return { label: "Advance returned", party, ...ADVANCES, group: "expense" };
    case "loan_given":
      return { label: "Loan given", party, ...LOANS_GIVEN, group: "loan" };
    case "loan_given_repayment":
      return { label: "Loan repayment received", party, ...LOANS_GIVEN, group: "loan" };
    case "business_loan":
      return { label: r.sub === "credit_line" ? "Credit line opened" : "Loan received", party, ...BUSINESS_LOANS, group: "loan" };
    case "business_loan_payment":
      return { label: "Loan repayment", party, ...BUSINESS_LOANS, group: "loan" };
    case "business_loan_drawdown":
      return { label: "Credit line drawdown", party, ...BUSINESS_LOANS, group: "loan" };
    case "emi_payment":
      return { label: r.sub === "prepayment" ? "Loan prepayment" : r.sub === "foreclosure" ? "Loan foreclosure" : "EMI paid", party, ...ASSETS, group: "loan" };
    case "emi_down_payment":
      return { label: "Down payment", party, ...ASSETS, group: "loan" };
    case "emi_loan_received":
      return { label: "Loan received", party, ...ASSETS, group: "loan" };
    case "staff_advance":
      if (r.sub === "reimburse") return { label: "Reimbursement paid", party, ...REIMBURSEMENTS, group: "expense" };
      /* Money in the company owes back to the employee — a payable, not an expense. */
      if (r.sub === "owed_back") return { label: "Owed back by staff", party, ...REIMBURSEMENTS, group: "other" };
      return { label: r.sub === "return" ? "Advance returned" : "Advance given", party, ...ADVANCES, group: "expense" };
    case "statutory": {
      const k = (r.sub ?? "").toLowerCase();
      const label = k === "tds" || k === "pf" || k === "esi" ? `${k.toUpperCase()} paid` : "Statutory dues paid";
      return { label, party: party ? `Challan ${party}` : null, ...STATUTORY, group: "tax" };
    }
    default:
      return { label: "Booked", party, ...BS, group: "other" };
  }
}

/** rows → map by line id. */
export function lineBookingMap(rows: readonly LineBookingRow[]): Map<string, LineBooking> {
  return new Map(rows.map((r) => [r.txn_id, lineBookingOf(r)]));
}

/* The RPC is newer than the generated DB types — the same untyped client lib/banking/manual-reconcile uses. */
const untyped = () => createClient() as unknown as SupabaseClient;

/** The bookings behind this account's 'manual' lines (empty when it has none). */
export function useLineBookings(accountId: string | null | undefined, enabled = true) {
  return useQuery({
    /* Under ["bank_transactions", accountId] so every booking's invalidate (e.g. useBookBankAdvance) refreshes it too. */
    queryKey: ["bank_transactions", accountId ?? null, "line-bookings"],
    enabled: enabled && Boolean(accountId),
    queryFn: async (): Promise<Map<string, LineBooking>> => {
      const { data, error } = await untyped().rpc("bank_line_bookings", { p_bank_account_id: accountId as string });
      if (error) throw error;
      return lineBookingMap((data ?? []) as LineBookingRow[]);
    },
    staleTime: 30_000,
  });
}
