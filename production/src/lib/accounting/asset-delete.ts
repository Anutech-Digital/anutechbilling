/**
 * R-1650 — what removing a fixed asset does to the books, said before it is done.
 *
 * report_pnl leaves out an expense only while a fixed asset points at it (migration
 * 20261018180232_r1578); its cost reaches the P&L as depreciation from the register. So removing
 * the asset is undoing a capitalisation: the expense is a cost of its own month again, and every
 * rupee of depreciation charged on the asset is reversed with it — never both, never neither.
 * That is a correction, allowed only while those months are open (trigger
 * trg_fixed_asset_expense_lock + trg_books_lock). An asset that left the business is
 * "Sold / scrap", which keeps the depreciation already charged.
 */
import { rupee, formatDate } from "@/lib/utils";
import { accumulatedDepreciation, type AssetLike } from "./depreciation";

export interface AssetForDelete extends AssetLike {
  expense_id?: string | null;
  emi_purchase_id?: string | null;
  /** The linked expense, when this login can read it. */
  source_expense?: { amount: number; expense_date: string } | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

export function assetDeleteConfirm(a: AssetForDelete, today: string): {
  body: string;
  /** ₹ that becomes a cost again in the expense's month; null when there is no readable expense. */
  expenseBack: number | null;
  /** ₹ of depreciation charged up to today that is reversed. */
  depreciationReversed: number;
} {
  const depreciationReversed = accumulatedDepreciation(a, today);
  const dep = depreciationReversed > 0
    ? `the depreciation charged on it (${rupee(depreciationReversed)} so far) is reversed`
    : "no depreciation has been charged on it yet";
  const sold = 'If it was sold or scrapped, use "Sold / scrap" instead — that keeps the depreciation already charged.';

  if (a.expense_id) {
    const e = a.source_expense ?? null;
    const back = e
      ? `The ${rupee(e.amount)} expense of ${formatDate(e.expense_date)} it came from counts as a cost in ${monthLabel(e.expense_date)}'s P&L again`
      : "The expense it came from counts as a cost in its own month's P&L again";
    return { body: `${a.name}: ${back}, and ${dep}. ${sold}`, expenseBack: e ? e.amount : null, depreciationReversed };
  }
  const emi = a.emi_purchase_id ? " The EMI purchase it came from stays as it is." : "";
  return {
    body: `${a.name}: removed from the register — ${dep}, and it leaves the Balance Sheet.${emi} ${sold}`,
    expenseBack: null,
    depreciationReversed,
  };
}
