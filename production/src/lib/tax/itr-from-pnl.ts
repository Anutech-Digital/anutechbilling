/**
 * R-1579 — ITR pack ke "books" wale aankde P&L se, ek hi jagah se.
 *
 * Pehle ITR (queries/itr.ts) apna profit khud jodta tha aur ek hi FY par P&L se alag aata
 * tha: COGS purchase_orders se (P&L: vendor bills), kharchon se saara gst_paid ghata kar
 * (P&L: sirf claimable ITC), commissions aur settlement bank charges ke bina, aur invoices /
 * expenses bina paging (1000 row par chup-chaap kat-te). CA ko do "profit".
 *
 * Ab: `report_pnl` (FY range) → `assemblePnl` → ye function. Jo P&L page ginta hai wahi
 * yahan aata hai; ITR sirf apni cheezein (TDS, advance tax, darein, gaps) upar jodta hai.
 * Ek farq jaan-boojh kar: P&L page bina bill ke COGS ka andaza (subscription book) dikhata
 * hai; tax me andaza nahi — isliye flat `netProfit` (darj vendor bills) liya jaata hai.
 *
 * Pure — itr-from-pnl.test.ts parity pin karta hai: book profit === P&L net profit.
 */
import type { PnLNumbers, PnlRpcRow } from "@/lib/accounting/pnl-assemble";
import { splitItc } from "@/lib/gst/itc";
import type { ExpenseCategoryLine, ItrSources } from "@/lib/tax/itr";

/** assemblePnl ka category naam — `category || "Uncategorised"` (wahi niyam). */
const catKey = (c: string | null | undefined): string => c || "Uncategorised";

export type ItrBooks = Pick<
  ItrSources,
  "revenueExGst" | "invoiceCount" | "cogs" | "cogsCount" | "expenses" | "commissions" | "commissionsCount"
  | "depreciation" | "pnlNetProfit"
>;

/**
 * P&L ke aankde ITR ke source me. `rpc` sirf category-war claimable ITC ke liye — P&L ek
 * hi jod deta hai, ITR har category ki line dikhata hai. Category-war jod = P&L ka jod
 * (splitItc har group alag ginta hai), isliye book profit rupaye tak milta hai.
 */
export function itrBooksFromPnl(pnl: PnLNumbers, rpc: Pick<PnlRpcRow, "itc_groups">): ItrBooks {
  const itcByCat = new Map<string, PnlRpcRow["itc_groups"]>();
  for (const g of rpc.itc_groups) {
    const k = catKey(g.category);
    itcByCat.set(k, [...(itcByCat.get(k) ?? []), g]);
  }

  const expenses: ExpenseCategoryLine[] = pnl.expensesByCategory.map((c) => ({
    category: c.category,
    amount: c.total,
    itc: splitItc(itcByCat.get(c.category) ?? []).eligible,
    count: c.count,
  }));
  /* ITC wala group jiski category expense groups me nahi (ek hi CTE se aate hain, isliye
     hona nahi chahiye) — chhoda nahi jaata, apni line banta hai, taaki jod P&L se mile. */
  const seen = new Set(expenses.map((e) => e.category));
  for (const [category, groups] of itcByCat) {
    if (seen.has(category)) continue;
    const itc = splitItc(groups).eligible;
    if (itc !== 0) expenses.push({ category, amount: 0, itc, count: 0 });
  }

  return {
    revenueExGst: pnl.revenue,
    invoiceCount: pnl.revenueCount,
    cogs: pnl.cogs,
    cogsCount: pnl.cogsCount,
    expenses,
    commissions: pnl.commissions,
    commissionsCount: pnl.commissionsCount,
    depreciation: pnl.depreciation,
    pnlNetProfit: pnl.netProfit,
  };
}
