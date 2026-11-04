/**
 * R-2335: TDS on Bills → Pay — the same rules as Reconcile, through R-2320's planTds on the one
 * bill being paid:
 *   - services sections (194C / 194J …): tdsDecision on the bill's value before GST, counting the
 *     vendor's year so far; only while nothing is paid on the bill yet (its whole TDS goes with
 *     the first payment); below the threshold the owner may take it anyway with a reason;
 *   - 194Q: the database's own figure for the bill (R-1891, vendor_194q_open_bills).
 * The bank pays what is owed less the TDS; the server (pay_vendor_bill, 8 arguments) checks all of
 * it again.
 */
import { planTds, type Bill194q, type VendorOpenItem } from "@/lib/banking/debit-pay-for";

export interface BillForPay {
  id: string;
  bill_no: string | null;
  bill_date: string;
  due_date: string | null;
  category: string | null;
  subtotal: number | null;
  total: number;
  paid_amount: number | null;
  currency?: string | null;
}

export interface BillPayTds {
  tds: number;
  section: string | null;
  reason: string | null;
  /** The app found the TDS below the section's threshold — the owner may take it anyway. */
  belowThreshold: boolean;
  /** The owner's reason, when the TDS is taken below the threshold. */
  override: string | null;
  /** The bank amount that settles the rest of the bill with this TDS. */
  cash: number;
}

export function billPayTds(
  bill: BillForPay,
  opts: {
    section: string | null; pan: string | null; fyOthers: { base: number; baseWithoutTds: number } | null; off: boolean;
    q194?: ReadonlyMap<string, Bill194q> | null;
    override?: string | null;
  },
): BillPayTds {
  const owed = Math.max(0, bill.total - (bill.paid_amount ?? 0));
  const inr = (bill.currency ?? "INR").toUpperCase() === "INR";
  const item: VendorOpenItem = {
    source: "vendor_bill", doc_id: bill.id, bill_no: bill.bill_no, doc_date: bill.bill_date, due_date: bill.due_date,
    category: bill.category, total: bill.total, amount_due: owed, gst: bill.total - (bill.subtotal ?? 0),
    tds_base: inr ? Math.max(0, bill.subtotal ?? 0) : 0, tds_amount: 0, tds_section: null, can_part: true, in_run: null,
  };
  const none: BillPayTds = { tds: 0, section: null, reason: null, belowThreshold: false, override: null, cash: owed };
  if (!inr) return none;
  const [t] = planTds([item], { ...opts, section: opts.section || null });
  if (!t) return none;
  const tds = Math.min(t.tds, owed > 0 ? owed - 1 : 0);
  return {
    tds: Math.max(0, tds),
    section: tds > 0 ? t.section : null,
    reason: t.reason,
    belowThreshold: !!t.belowThreshold,
    override: tds > 0 ? t.override ?? null : null,
    cash: owed - Math.max(0, tds),
  };
}

/** The pay_vendor_bill RPC arguments (8-argument form, migration 20261101071500). */
export function payVendorBillArgs(i: {
  billId: string; amount: number; paidOn: string; bankAccountId: string; method?: string | null;
  tds: number; tdsSection: string | null; tdsOverride?: string | null;
}) {
  const tds = Math.max(0, Math.round(i.tds || 0));
  const reason = (i.tdsOverride ?? "").trim();
  return {
    p_bill_id: i.billId,
    p_amount: Math.round(i.amount),
    p_paid_on: i.paidOn,
    p_bank_account_id: i.bankAccountId,
    p_method: i.method ?? null,
    p_tds_amount: tds,
    p_tds_section: tds > 0 ? i.tdsSection : null,
    p_tds_override_reason: tds > 0 && reason ? reason : null,
  };
}
