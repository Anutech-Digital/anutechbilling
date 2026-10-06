/**
 * Status chips for one expense row (moved out of page.tsx in R-213 so the page stays
 * under the file-size limit; unchanged).
 */
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { expensePayStatus, type Expense } from "@/lib/queries/expenses";

/** Reconcile tag shown next to a Salaries expense's category. Salary expenses
 *  reflect their salary's paid-status (which supports PARTIAL payments); every
 *  other expense uses its own reconciled_txn_id. */
type SalMini = { paid_status: "unpaid" | "partial" | "paid"; paid_amount: number; net: number };
export function reconcileTag(e: Expense, sal?: SalMini):
  { tone: "emerald" | "amber"; label: string; title?: string } | null {
  if (e.category === "Salaries" && sal) {
    if (sal.paid_status === "paid") return { tone: "emerald", label: "✓ Paid" };
    if (sal.paid_status === "partial") {
      return {
        tone: "amber",
        label: `◐ Partial · ${rupee(sal.paid_amount)}/${rupee(sal.net)}`,
        title: `Partly paid — ${rupee(sal.net - sal.paid_amount)} still owed. Reconcile another bank line in Banking to clear it.`,
      };
    }
    return { tone: "amber", label: "To pay", title: "Salary not paid yet — pay it and reconcile in Banking." };
  }
  // Statutory / other payroll posting: reconciled bank line = Paid, else payable.
  if (e.reconciled_txn_id) return { tone: "emerald", label: "✓ Paid" };
  return { tone: "amber", label: "To pay", title: "Not settled yet — reconcile its bank line to confirm." };
}
export function ReconcileTag({ tone, label, title }: { tone: "emerald" | "amber"; label: string; title?: string }) {
  const cls = tone === "emerald" ? "bg-emerald/10 text-emerald" : "bg-amber-soft text-amber-ink";
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full ${cls} px-2 py-0.5 text-3xs font-medium align-middle`}>
      <Icon name={tone === "emerald" ? "check_circle" : "clock"} size={11} />
      {label}
    </span>
  );
}

/**
 * Status chip for a non-payroll expense. Two independent facts:
 *   • Paid vs To-pay — did the money leave (the operator's record)?
 *   • Reconciled — has it been matched to a bank/cash line (bank-verified)?
 * So a paid expense reads "Paid" straight away; once it reconciles it gains a
 * "✓ Paid" tick (bank-verified). An open bill reads "To pay" / "Overdue".
 */
export function PayBadge({ e, today }: { e: Expense; today: string }) {
  const base = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-3xs font-medium align-middle";
  if (!e.paid) {
    const overdue = expensePayStatus(e, today) === "overdue";
    return (
      <span
        title={overdue ? "Payable overdue — settle it and Mark paid." : "Payable — not paid yet."}
        className={`${base} ${overdue ? "bg-rose/10 text-rose" : "bg-amber-soft text-amber-ink"}`}
      >
        <Icon name={overdue ? "alert" : "clock"} size={11} />
        {overdue ? "Overdue" : "To pay"}
      </span>
    );
  }
  if (e.reconciled_txn_id) {
    return (
      <span title="Paid & bank-verified — matched to a bank/cash line." className={`${base} bg-emerald/10 text-emerald`}>
        <Icon name="check_circle" size={11} /> Paid
      </span>
    );
  }
  return (
    <span title="Payment recorded. Reconcile it against the bank line to bank-verify." className={`${base} border border-emerald/30 text-emerald`}>
      <Icon name="check" size={11} /> Paid
    </span>
  );
}

/** Bill-presence chip — makes "Missing bill" / kaccha clearly visible. */
export function BillChip({ tone, label, title }: { tone: "rose" | "amber"; label: string; title?: string }) {
  const cls = tone === "rose" ? "bg-rose/10 text-rose" : "bg-amber-soft/70 text-amber-ink";
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full ${cls} px-1.5 py-0.5 text-3xs uppercase tracking-wide font-semibold align-middle`}>
      <Icon name="alert" size={10} /> {label}
    </span>
  );
}

/** Payroll / statutory postings (salaries, employer ESI/PF, TDS) are generated
 *  by the Payroll module — they carry no bill or line items, so they get no
 *  items editor and clicking one jumps to Payroll (their real home) instead of
 *  the bill-style detail. */
export function isPayrollExpense(e: { category?: string | null; payment_method?: string | null }): boolean {
  const cat = e.category ?? "";
  return (
    cat === "Salaries" ||
    e.payment_method === "statutory" ||
    /\b(ESI|EPF|PF|Provident|Gratuity|Bonus|TDS)\b/i.test(cat)
  );
}
