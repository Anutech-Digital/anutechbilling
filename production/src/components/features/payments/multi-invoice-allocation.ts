/**
 * R-1525 — one receipt spread over several of a customer's open invoices.
 *
 * Pure maths for the "Record payment — multiple invoices" sheet. The server
 * (record_multi_invoice_payment) re-checks every rule here and is the one that decides;
 * this file only fills the form the way the server will accept it and says out loud what
 * the operator's numbers will do. Whole rupees throughout (§13).
 *
 * Rules mirrored from the RPC:
 *   · a line's cash + TDS may not exceed that invoice's due;
 *   · lines (cash only) add up to at most the amount received; the rest becomes advance
 *     credit — only when at least one line pays its invoice in full.
 */
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { matchTdsShortfall, type TdsShortfallMatch } from "@/lib/accounting/tds-match";

/** An invoice the receipt can be applied to — what the sheet lists. */
export interface OpenInvoice {
  id: string;
  invoice_date: string;
  due_date: string | null;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
  status: string;
  tax_rate: number | null;
  /** Rupees still owed (invoiceAmountDue). */
  due: number;
}

/** One line of the form. */
export interface AllocationLine {
  invoiceId: string;
  amount: number;
  tds: number;
  tdsSection?: string;
  tdsRatePct?: number;
}

/** Rows → invoices with a due, oldest first (invoice date, then id), paid/void dropped. */
export function openInvoicesOldestFirst<T extends Omit<OpenInvoice, "due">>(rows: readonly T[]): Array<T & { due: number }> {
  return rows
    .map((r) => ({ ...r, due: invoiceAmountDue(r) }))
    .filter((r) => r.due > 0)
    .sort((a, b) => (a.invoice_date < b.invoice_date ? -1 : a.invoice_date > b.invoice_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Oldest first: each invoice takes as much of the received amount as it can until the
 * money runs out. Invoices that get nothing are still returned with 0 so the form keeps a
 * row for each (the operator can type into any of them). TDS is never guessed here.
 */
export function fifoAllocate(received: number, invoices: readonly Pick<OpenInvoice, "id" | "due">[]): AllocationLine[] {
  let left = Math.max(0, Math.floor(received || 0));
  return invoices.map((inv) => {
    const take = Math.min(left, Math.max(0, inv.due));
    left -= take;
    return { invoiceId: inv.id, amount: take, tds: 0 };
  });
}

export interface AllocationSummary {
  /** Sum of the lines' cash. */
  allocated: number;
  /** received − allocated; negative = lines add up to more than came in. */
  remaining: number;
  /** Invoice ids whose cash + TDS is more than their due. */
  overDue: string[];
  /** Lines carrying any money. */
  used: AllocationLine[];
  /** True when at least one used line settles its invoice in full. */
  anyFull: boolean;
  /** The one thing stopping a save, in words with the fix — or null when it can be saved. */
  problem: string | null;
}

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

export function summarise(received: number, lines: readonly AllocationLine[], invoices: readonly Pick<OpenInvoice, "id" | "due">[]): AllocationSummary {
  const dueOf = new Map(invoices.map((i) => [i.id, i.due]));
  const used = lines.filter((l) => (l.amount || 0) + (l.tds || 0) > 0);
  const allocated = used.reduce((s, l) => s + (l.amount || 0), 0);
  const remaining = Math.floor(received || 0) - allocated;
  const overDue = used.filter((l) => (l.amount || 0) + (l.tds || 0) > (dueOf.get(l.invoiceId) ?? 0)).map((l) => l.invoiceId);
  const anyFull = used.some((l) => (l.amount || 0) + (l.tds || 0) === (dueOf.get(l.invoiceId) ?? -1));

  let problem: string | null = null;
  if (!(received > 0)) problem = "Enter the amount received.";
  else if (used.length === 0) problem = "Apply the payment to at least one invoice (Auto-fill does it oldest first).";
  else if (overDue.length) problem = `${overDue[0]} gets more than its due — lower that line; the rest can stay as advance credit.`;
  else if (remaining < 0) problem = `The lines add up to ${inr(allocated)} but only ${inr(received)} came in — lower a line.`;
  else if (remaining > 0 && !anyFull) problem = `${inr(remaining)} would be kept as advance while every invoice is still part-paid — pay the oldest one in full first.`;
  return { allocated, remaining, overDue, used, anyFull, problem };
}

/**
 * R-1520 hint per line: is what is left on this invoice after this line exactly a common
 * TDS? Only when the line pays something and leaves something.
 */
export function lineTdsHint(inv: Pick<OpenInvoice, "amount" | "net_payable" | "paid_amount" | "tax_rate">, line: Pick<AllocationLine, "amount" | "tds">, preferredSection?: string | null): TdsShortfallMatch | null {
  if ((line.tds || 0) > 0 || !(line.amount > 0)) return null;
  const total = inv.net_payable ?? inv.amount;
  return matchTdsShortfall({
    totalInclGst: total,
    received: (inv.paid_amount ?? 0) + line.amount,
    gstRatePct: inv.tax_rate,
    preferredSection,
  });
}

/** The RPC's p_allocations. */
export function toRpcAllocations(lines: readonly AllocationLine[]): Array<{ invoice_id: string; amount: number; tds_amount?: number; tds_section?: string; tds_rate_pct?: number }> {
  return lines
    .filter((l) => (l.amount || 0) + (l.tds || 0) > 0)
    .map((l) => ({
      invoice_id: l.invoiceId,
      amount: Math.floor(l.amount || 0),
      ...(l.tds > 0 ? { tds_amount: Math.floor(l.tds), tds_section: l.tdsSection ?? "194J", tds_rate_pct: l.tdsRatePct } : {}),
    }));
}
