/**
 * Kharche ki categories — ek hi jagah, aur ye file JAAN-BOOJHKAR khaali hai.
 *
 * Ye `lib/queries/expenses.ts` me thi, jo Supabase aur react-query import karti hai. 30 Aug
 * 2026 ko bill-extractor ke sanitiser ko ye list chahiye thi, aur us file ke sir par likha
 * hai: "Pure, dependency-free helpers … so they can be unit-tested without pulling in
 * server-only Supabase/Gemini imports". Us waade ko todne se behtar tha list ko us jagah
 * rakhna jahan se dono le sakein.
 *
 * `expenses.ts` ise aage bhi export karti hai, isliye maujooda 11 call site waise hi chalte
 * hain — kisi ko badalne ki zaroorat nahi.
 */
export const EXPENSE_CATEGORIES = [
  "Hosting",
  "Software",
  "Salaries",
  /* Paid to a director — shown apart from Salaries because the accounts disclose it
     separately. An employee-director's salary still goes through Payroll (TDS u/s 192);
     this is for remuneration / commission / sitting fees booked as an expense. */
  "Director's Remuneration",
  "Office Rent",
  "Marketing",
  "Advertising",
  "Business Promotion",
  "Staff Welfare",
  "Travel",
  "Professional Services",
  /* Commission paid to someone OUTSIDE the payroll — an agent, broker, referral partner or
     dealer who brought a deal (TDS u/s 194H). An EMPLOYEE's commission / incentive is salary:
     it goes through Payroll's incentive field (TDS u/s 192), not here. Tagged to a project, it
     counts as that project's cost (the cost of winning it). */
  "Commission / Incentive (agents)",
  "Bank Charges",
  "Internet & Phone",
  "Utilities",
  "Office Supplies",
  "Equipment",
  "Repairs & Maintenance",
  "Insurance",
  /* Taxes that ARE expenses — late fees, interest on late tax, penalties, professional /
     property tax, ROC fees. NOT GST or income tax themselves: those settle a liability or
     sit as an asset, and are booked from the bank line as a tax payment instead. */
  "Rates & Taxes",
  /* R-2374: interest on a business loan, OD or flexi line — FINANCE COST, shown apart on the
     P&L (lib/accounting/credit-line.ts). Booked by Banking → Reconcile → Loan / EMI → Credit line
     / loan repayment; the principal part reduces the loan and is never an expense. */
  "Interest on loans / OD",
  /* R-2427: the exchange difference when an export invoice is paid at another rate than it was
     issued at (AS-11) — booked by Reconcile from Zoho on the bank line; a gain is a negative amount.
     R-1678: renamed from "Foreign Exchange Gain / Loss" to the owner's ledger name (CA to confirm); a ₹
     receipt settling a foreign invoice (reconcile_bank_credit_split p_rest 'fx') books here too. */
  "Exchange gain / loss (realised)",
  "Other",
] as const;
