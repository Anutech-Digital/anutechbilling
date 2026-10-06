/**
 * Expenses — Phase 1 accounting queries.
 *
 * Operating expenses (NON-COGS) — hosting, salaries, software, office, etc.
 * Used on /accounting/expenses, /accounting/pnl, /accounting/gst/input.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { Database, ExpenseRow } from "@/lib/supabase/database.types";
import { localDateISO } from "@/lib/leads/outcomes";

type ExpenseInsert = Database["public"]["Tables"]["expenses"]["Insert"];
type ExpenseUpdate = Database["public"]["Tables"]["expenses"]["Update"];

export type Expense = ExpenseRow;

/** Common Indian SME expense categories — surface as a Select default. */
// Marketing = broad strategy (market research, PR, branding, CRM software,
// website upkeep, email-automation tools). Advertising = paid outreach only
// (social/TV ads, billboards, PPC). Kept as separate categories so the P&L can
// tell brand-building spend apart from direct paid campaigns.
// Business Promotion = spend on CLIENTS/customers (gifts, entertainment); Staff
// Welfare = spend on your own TEAM (birthday cake, staff lunch, Diwali gift to staff).
// Note: GST ITC on gifts + food is blocked (CGST s.17(5)) — record such bills
// with GST paid = 0.
export { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";
import { EXPENSE_CATEGORIES } from "@/lib/accounting/expense-categories";
import { COMMISSION_CATEGORY, fyStartOf } from "@/lib/accounting/commission-tds";

/**
 * Guess an expense category from the free-text "what was this for?" note.
 * First keyword match wins (more specific patterns first). Returns null when
 * nothing matches — so we never override with a wrong guess. The operator can
 * always change the picked category. 'Salaries' is intentionally never guessed
 * (those belong in Payroll).
 */
// Keywords are English + Hinglish/Hindi (Roman) — operators here write notes
// like "client ke pass jane ke liye" (travel) or "team ke liye khana" (food).
const CATEGORY_KEYWORDS: [RegExp, (typeof EXPENSE_CATEGORIES)[number]][] = [
  // Taxes that are an EXPENSE — FIRST, because "trade licence" would otherwise be taken by
  // Software's "licence" and "professional tax" by nothing at all. Deliberately not bare
  // "gst" / "tax" / "tds": a GST or income-tax payment is not an expense and must not be
  // filed as one by a keyword.
  [/\b(late ?fee|penalty|penal ?interest|interest on (?:gst|tds|tax)|professional ?tax|prof ?tax|property ?tax|house ?tax|roc ?fee|mca ?fee|stamp ?duty|trade ?licen[cs]e|shop ?act)\b/i, "Rates & Taxes"],
  // A director's pay, as an operator writes it. Unlike "Salaries" this IS suggested:
  // it is not a Payroll entry when booked as an expense.
  [/\b(directors?'? ?(?:remuneration|salary|commission|fees?)|sitting ?fees?|managerial ?remuneration)\b/i, "Director's Remuneration"],
  // Commission to an outside agent / broker / referral partner (TDS 194H). After the director
  // rule, so "director commission" stays Director's Remuneration. Bare "incentive" is NOT a
  // keyword: a staff incentive is salary and belongs in Payroll.
  [/\b(commission|brokerage|referral ?(?:fee|payout|bonus|commission)|finder'?s? ?fee|agent ?fee|dealer ?incentive|channel ?partner ?(?:incentive|payout))\b/i, "Commission / Incentive (agents)"],
  [/\b(rent|lease|kiraya|kiraaya)\b/i, "Office Rent"],
  [/\b(cab|taxi|uber|ola|rapido|flight|air ?fare|train|irctc|hotel|stay|travel|petrol|diesel|fuel|toll|parking|mileage|conveyance|jaana|jaane|jana|jane|aana|aane|safar|yatra|gaadi|gadi|rickshaw|riksha|\bbus\b|\btel\b|luggage|suitcase|trolley|backpack|travel ?bag)\b/i, "Travel"],
  [/\b(internet|wi-?fi|broadband|phone|mobile|airtel|jio|vodafone|\bvi\b|bsnl|recharge|data ?pack|\bsim\b|net ?pack)\b/i, "Internet & Phone"],
  [/(electric|bijli|power ?bill|water ?bill|paani|utilit|gas ?bill|generator|\bdg\b)/i, "Utilities"],
  [/\b(hosting|domain|server|cloud|aws|gcp|azure|vps|cpanel|\bssl\b|render|vercel|netlify)\b/i, "Hosting"],
  [/\b(software|saas|subscription|licen[cs]e|zoom|slack|figma|adobe|github|notion|canva|chatgpt|openai|anthropic|claude|gemini)\b/i, "Software"],
  [/\b(stationery|stationary|paper|kagaz|kaagaz|printer ?ink|toner|cartridge|\bpen\b|register|copy|folder|envelope|supplies)\b/i, "Office Supplies"],
  [/\b(laptop|computer|desktop|monitor|keyboard|mouse|furniture|chair|kursi|\btable\b|hardware|equipment|air ?condition|\bac\b|ups\b)\b/i, "Equipment"],
  [/\b(repair|maintenance|\bamc\b|servicing|service ?charge|marammat|mistri)\b/i, "Repairs & Maintenance"],
  [/\b(insurance|premium|policy|mediclaim|bima)\b/i, "Insurance"],
  [/\b(advertis|\bads?\b|\bppc\b|google ?ads|facebook ?ads|meta ?ads|billboard|hoarding|banner ?ad|vigyapan)\b/i, "Advertising"],
  [/\b(marketing|branding|\bseo\b|campaign|newsletter|email ?tool|\bcrm\b)\b/i, "Marketing"],
  // Staff Welfare BEFORE Business Promotion: own-team spend (cake, team lunch,
  // staff gift) wins over the generic food/gift → Business Promotion fallback.
  // 'staff'/'employee' + a welfare noun in EITHER order (so "staff lunch" and
  // "Diwali gift to staff" both catch); 'team' only for the unambiguous ones
  // ('team lunch' could be a client meal, so it stays out).
  [/\b(cake|birthday|b'?day|janam ?din|janamdin|karmchari|(?:staff|employee)[ -]?(?:welfare|gift|party|lunch|dinner|outing|sweets|mithai)|team[ -]?(?:gift|outing)|(?:welfare|gift|party|lunch|dinner|outing|sweets|mithai) ?(?:for |to |ke liye )?(?:staff|employee))\b/i, "Staff Welfare"],
  [/\b(lunch|dinner|breakfast|food|snack|tea|coffee|chai|chaay|khana|khaana|khane|nashta|naashta|mithai|bhojan|restaurant|swiggy|zomato|catering|refreshment|sweets?|gift|party)\b/i, "Business Promotion"],
  [/\b(\bca\b|chartered|accountant|audit|lawyer|legal|advocate|vakil|consultant|professional ?fee|retainer|notary)\b/i, "Professional Services"],
  [/\b(bank ?charge|bank ?fee|processing ?fee|neft|rtgs|imps ?charge|transaction ?fee|convenience ?fee)\b/i, "Bank Charges"],
];

/**
 * Wo aam angrezi shabd jo kisi PRODUCT ke naam me aa jate hain bina us kharche ke baare me
 * kuch kahe.
 *
 * ─── YE KYUN BANI (29 Aug 2026) ─────────────────────────────────────────────
 * Pardeep ne screen par pakda: ek gadde ki category "Travel" chuni gayi thi. Product ka
 * poora naam tha —
 *
 *     "NEXTGO Single Bed Cotton Mattress 2.5 x 6.5 Feet | Foldable Lightweight Tufted
 *      Ruyi Gadi with 1 Pillow & Zipper Cover | Guest Bachelor TRAVEL Floor Sleeping
 *      Mattress | Blend Pink Multi Color"
 *
 * Travel wala rule table me DOOSRE number par hai, aur pehla match jeet jata hai. Us 180+
 * akshar ke naam me kahin "Travel" aaya, aur gadda safar ka kharcha ban gaya — jo seedha
 * P&L me galat khaate me jata.
 *
 * Is file ka apna test pehle se kehta hai: "suggestCategory's patterns are \b-anchored
 * because it was written for text an OPERATOR TYPES". Wo sach hai, aur wahi jad hai —
 * ab ise wo text bhi khilaya jaata hai jo Amazon ke bill se nikalta hai, aur wo alag kism
 * ka text hai. Operator likhta hai "cab to client" (16 akshar); Amazon likhta hai 180.
 *
 * Isliye ye shabd sirf CHHOTE text me ginte hain. Lambe product naam me ye product ka
 * varnan kar rahe hote hain, kharche ka nahi.
 */
const WEAK_IN_PRODUCT_NAMES =
  /\b(travel|stay|bus|table|cover|copy|register|party|gift|supplies|service ?charge|power|data|gadi|gaadi)\b/i;

/* `gadi` ka yahan hona "travel" se bhi behtar samjhata hai ki ye list kyun chahiye.
   Us gadde ka poora naam tha "… Foldable Lightweight Tufted **Ruyi Gadi** with 1 Pillow …"
   Hindi me "gaddi/gadi" ek gadda hi hota hai. Par CATEGORY_KEYWORDS me `gadi` isliye likha
   gaya tha ki Hinglish note me "gaadi" = vehicle ("gaadi ka petrol"). Ek hi shabd, do
   bilkul alag cheezein — aur us bill par galat wala jeet gaya.

   Pehle maine maana ki "Travel" shabd hi jad hai. Test ne wo galat sabit kiya: "travel"
   hataane ke baad bhi row Travel hi rahi, kyunki asli match `gadi` par tha. */

/** Isse lamba text ek note nahi, ek product ka naam hai. */
const NOTE_MAX_CHARS = 60;

/**
 * @param opts.source `"product"` = ye text kisi bill ki item-line se aaya hai (product ka
 *   naam), operator ne likha nahi hai. Aise text me kamzor shabd anadekhe kar diye jate
 *   hain. Chhoda gaya to purana vyavhaar waisa hi rehta hai — banking wala layer aur baaki
 *   sab call site bina badle chalte hain.
 */
export function suggestCategory(
  text: string,
  opts?: { source?: "note" | "product" },
): (typeof EXPENSE_CATEGORIES)[number] | null {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return null;

  /* Kamzor shabd sirf tab anadekhe jab text product ka naam HO — chhota note likhne wale
     ka "travel to client" pehle jaisa hi chalta rahe. */
  const ignoreWeak = opts?.source === "product" || t.length > NOTE_MAX_CHARS;

  for (const [re, cat] of CATEGORY_KEYWORDS) {
    if (!re.test(t)) continue;
    if (!ignoreWeak) return cat;
    /* Ye rule match to hua — par kya sirf kisi kamzor shabd ki wajah se? Agar us rule ka
       koi aur (pakka) shabd bhi mila, to wo bharose layak hai. */
    const withoutWeak = t.replace(new RegExp(WEAK_IN_PRODUCT_NAMES.source, "gi"), " ");
    if (re.test(withoutWeak)) return cat;
  }
  return null;
}

/**
 * Split one invoice's lines into per-category groups — so a mixed bill (e.g.
 * laptop=Equipment + paper=Office Supplies) becomes one expense per category,
 * all sharing the invoice. Amounts stay in the input unit (bill currency); the
 * total GST is apportioned by each group's amount share, with the LAST group
 * absorbing any rounding remainder so the parts sum EXACTLY to the whole.
 * Groups are returned in first-seen order.
 */
export type CatLine = { name: string; amount: number; category: string; qty?: number; rate?: number };
type CatItem = { name: string; qty?: number; rate?: number; amount: number };
export function splitLinesByCategory(
  lines: CatLine[],
  totalGst: number,
): { category: string; amount: number; gst: number; items: CatItem[] }[] {
  const order: string[] = [];
  const byCat = new Map<string, { amount: number; items: CatItem[] }>();
  for (const l of lines) {
    const cat = l.category;
    if (!byCat.has(cat)) { byCat.set(cat, { amount: 0, items: [] }); order.push(cat); }
    const g = byCat.get(cat)!;
    g.amount += l.amount;
    g.items.push({ name: l.name, qty: l.qty, rate: l.rate, amount: l.amount });
  }
  const total = Array.from(byCat.values()).reduce((s, g) => s + g.amount, 0);
  const groups = order.map((cat) => ({ category: cat, ...byCat.get(cat)! }));
  // Apportion GST by amount share; last group takes the remainder.
  let gstAssigned = 0;
  return groups.map((g, i) => {
    const gst = i === groups.length - 1
      ? Math.round((totalGst - gstAssigned) * 100) / 100
      : (total > 0 ? Math.round((totalGst * g.amount / total) * 100) / 100 : 0);
    gstAssigned += gst;
    return { category: g.category, amount: g.amount, gst, items: g.items };
  });
}

export const PAYMENT_METHODS = [
  "bank_transfer",
  "upi",
  "card",
  "cheque",
  "cash",
] as const;

// ────────────────────────────────────────────────────────────────
// Paid vs payable (migration 0183)
// ────────────────────────────────────────────────────────────────

export type ExpensePayStatus = "paid" | "due" | "overdue";

/**
 * An expense is `paid`, or a payable that's `overdue` (due date passed) or just
 * `due`. Pure — pass today (YYYY-MM-DD) so it's deterministic/testable.
 */
export function expensePayStatus(
  e: { paid: boolean; due_date?: string | null },
  today: string,
): ExpensePayStatus {
  if (e.paid) return "paid";
  if (e.due_date && e.due_date < today) return "overdue";
  return "due";
}

// ────────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────────

export function useExpenses(opts?: {
  from?: string;
  to?:   string;
  category?: string;
}) {
  const { from, to, category } = opts ?? {};
  return useQuery({
    queryKey: ["expenses", { from, to, category }],
    queryFn: async (): Promise<Expense[]> => {
      const supabase = createClient();
      // Newest first: by bill date, then most-recently-added (created_at) so a
      // freshly-entered expense always lands at the top even on a shared date.
      // R-264: paged past the silent 1000-row cap; id last makes the order total.
      return await fetchAllRows<Expense>((rFrom, rTo) => {
        let q = supabase
          .from("expenses")
          .select("*")
          .order("expense_date", { ascending: false })
          .order("created_at", { ascending: false })
          .order("id", { ascending: true });
        if (from)     q = q.gte("expense_date", from);
        if (to)       q = q.lte("expense_date", to);
        if (category) q = q.eq("category", category);
        return q.range(rFrom, rTo);
      });
    },
  });
}

/** Expenses not yet reconciled to a bank line — candidates for a split match. */
export function useUnreconciledExpenses() {
  return useQuery({
    queryKey: ["expenses", "unreconciled"],
    queryFn: async (): Promise<Expense[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .select("*")
        .is("reconciled_txn_id", null)
        // Only PAID expenses moved money, so only they can match a bank line.
        // An unpaid payable has no cash movement yet — keep it out.
        .eq("paid", true)
        // 'statutory' (employer-ESI accrual) and 'advance' (funded from a prepaid
        // advance — the bank line was the advance payment) expenses have no bank
        // line of their own, so keep them out of the reconcile candidate list.
        // (.or keeps NULL payment_method rows, which a bare .neq would drop.)
        .or("payment_method.is.null,and(payment_method.neq.statutory,payment_method.neq.advance)")
        .order("expense_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Expense[];
    },
  });
}

export function useExpensesTotals(opts: { from: string; to: string }) {
  return useQuery({
    queryKey: ["expenses", "totals", opts],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .select("amount, gst_paid, category")
        .gte("expense_date", opts.from)
        .lte("expense_date", opts.to);
      if (error) throw error;

      const rows = data ?? [];
      const totals = {
        count:    rows.length,
        amount:   0,
        gstPaid:  0,
        byCategory: {} as Record<string, number>,
      };
      for (const r of rows) {
        totals.amount  += r.amount   ?? 0;
        totals.gstPaid += r.gst_paid ?? 0;
        const cat = r.category ?? "Other";
        totals.byCategory[cat] = (totals.byCategory[cat] ?? 0) + (r.amount ?? 0);
      }
      return totals;
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Duplicate detection — catch the same bill entered twice.
// ────────────────────────────────────────────────────────────────

/** Minimal shape used to detect a duplicate bill. */
export type DupCandidate = {
  vendorId?: string | null;
  vendorName?: string | null;
  billNo?: string | null;
  billDate?: string | null;
  amountInr?: number | null;   // ₹ — only known once currency is converted
  category?: string | null;    // same bill no. + DIFFERENT category = a split, not a dup
};

/** Recent expenses (light columns) to check a new bill against. */
export function useExpenseDupList() {
  return useQuery({
    queryKey: ["expenses", "dupList"],
    queryFn: async (): Promise<Pick<Expense, "id" | "vendor_id" | "vendor_name" | "bill_no" | "expense_date" | "amount" | "currency" | "category">[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .select("id, vendor_id, vendor_name, bill_no, expense_date, amount, currency, category")
        .order("expense_date", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as never;
    },
    staleTime: 30_000,
  });
}

/**
 * Pure duplicate finder. A match is:
 *   - same vendor AND same bill number (the natural key), OR
 *   - (no bill number) same vendor + same date + same ₹ amount.
 * `selfId` excludes the row being edited. Returns the first match, else null.
 */
export function findDuplicateExpense(
  c: DupCandidate,
  list: { id: string; vendor_id: string | null; vendor_name: string | null; bill_no: string | null; expense_date: string; amount: number; category?: string | null }[],
  selfId?: string,
): { id: string; expense_date: string; amount: number; bill_no: string | null } | null {
  const name = (c.vendorName ?? "").trim().toLowerCase();
  const billNo = (c.billNo ?? "").trim().toLowerCase();
  for (const e of list) {
    if (selfId && e.id === selfId) continue;
    const sameVendor =
      (!!c.vendorId && e.vendor_id === c.vendorId) ||
      (!!name && (e.vendor_name ?? "").trim().toLowerCase() === name);
    if (!sameVendor) continue;
    if (billNo && (e.bill_no ?? "").trim().toLowerCase() === billNo) {
      // Same vendor + same bill no. → a real duplicate ONLY if the category also
      // matches. A different category under the same invoice is a legitimate
      // split (multi-head purchase), not a duplicate. If no category was given
      // (e.g. the pre-confirm review), fall back to a bill-no match.
      if (!c.category || (e.category ?? "") === c.category) return e;
      continue;
    }
    if (!billNo && !e.bill_no && c.billDate && e.expense_date === c.billDate &&
        c.amountInr != null && Math.abs(e.amount - c.amountInr) <= 1) return e;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Mutations
// ────────────────────────────────────────────────────────────────

function newExpenseId(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase();
  return `EXP-${stamp}-${rand}`;
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    // `pettyCashAccountId` (optional): when a cash expense is paid out of a
    // petty-cash account, we also drop a matching DEBIT on that account so its
    // "cash in hand" balance stays live. Not part of the expenses table.
    mutationFn: async (
      input: Omit<ExpenseInsert, "id" | "tenant_id"> & { pettyCashAccountId?: string | null },
    ) => {
      const { pettyCashAccountId, ...expenseInput } = input;
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");

      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const { data, error } = await supabase
        .from("expenses")
        .insert({
          ...expenseInput,
          id:        newExpenseId(),
          tenant_id: me.tenant_id,
        })
        .select()
        .single();
      if (error) throw error;
      const expense = data as Expense;

      // Petty-cash out-flow — best-effort. If it fails the expense is still
      // saved; the operator can add the cash movement manually.
      if (pettyCashAccountId && expense.amount > 0) {
        const { data: txn, error: txnErr } = await supabase.from("bank_transactions").insert({
          tenant_id:        me.tenant_id,
          bank_account_id:  pettyCashAccountId,
          txn_date:         expense.expense_date,
          description:      `Petty cash: ${expense.category}${expense.vendor_name ? ` · ${expense.vendor_name}` : ""}`,
          debit:            expense.amount,
          credit:           0,
          source:           "manual",
          matched_to_type:  "expense",
          matched_to_id:    expense.id,
          match_confidence: "manual",
        }).select("id").single();
        if (txnErr) console.error("[create-expense] petty-cash debit failed (expense still saved):", txnErr);
        // The cash-ledger line IS the reconciliation for a petty-cash spend, so
        // link it back — the expense reads "Paid" (confirmed), not "Unreconciled".
        else if (txn) await supabase.from("expenses").update({ reconciled_txn_id: txn.id }).eq("id", expense.id);
      }

      return expense;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] }); // R-101: a spend / delete moves an advance balance
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["project_sales"] });   // project cost → refresh project P&L
      toast.success("Expense added");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/**
 * The true TOTAL OWED right now (any date), matching the per-row "To pay" chips:
 *   A) operating payables  — non-payroll expenses marked unpaid (paid = false)
 *   B) salaries not settled — remaining net (net − paid_amount) for unpaid/partial
 *   C) employer statutory   — ESI/PF/etc. postings not yet reconciled to a bank line
 * These three never overlap (payroll rows are paid = true, so they're not in A).
 */
export function useOutstandingPayable() {
  return useQuery({
    queryKey: ["expenses", "outstanding"],
    queryFn: async (): Promise<{ count: number; amount: number }> => {
      const supabase = createClient();
      const [op, sal, stat] = await Promise.all([
        supabase.from("expenses").select("amount").eq("paid", false),
        supabase.from("salary_payments").select("net, paid_amount, paid_status").neq("paid_status", "paid"),
        supabase.from("expenses").select("amount").eq("payment_method", "statutory").is("reconciled_txn_id", null),
      ]);
      if (op.error) throw op.error;
      if (sal.error) throw sal.error;
      if (stat.error) throw stat.error;

      let amount = 0, count = 0;
      for (const r of op.data ?? [])   { amount += r.amount ?? 0; count++; }
      for (const s of sal.data ?? [])  { const rem = (s.net ?? 0) - (s.paid_amount ?? 0); if (rem > 0) { amount += rem; count++; } }
      for (const r of stat.data ?? []) { amount += r.amount ?? 0; count++; }
      return { count, amount };
    },
    staleTime: 15_000,
  });
}

/**
 * Unpaid bills WITH their due dates — so "is anything actually late?" can be answered.
 *
 * ─── WHY NOT JUST REUSE useOutstandingPayable ───────────────────────────────
 * That hook returns `{ count, amount }` and nothing else, which is right for a KPI tile
 * and useless for urgency. Feeding the money inbox an aggregate would have meant passing
 * `daysOverdue: 0` for every bill — and a folder that reports "not urgent" because it was
 * handed a zero, rather than because nothing is late, is the failure this codebase keeps
 * producing: an unknown converted into a confident answer.
 *
 * Salary and statutory payables are deliberately NOT included. They are in the KPI's
 * total because they are money owed, but they are not "vendor bills due" — a salary run
 * has its own screen, its own approvals, and putting it in a folder headed with Google
 * and Microsoft would bury it.
 *
 * A bill with no due date is returned with `daysOverdue: null`, never 0. Nobody agreed a
 * deadline, so it cannot be late — the same rule dunning.ts applies to invoices.
 */
export function useUnpaidBillsDue() {
  return useQuery({
    queryKey: ["expenses", "unpaid-with-dates"],
    queryFn: async (): Promise<{
      id: string; vendor: string | null; amount: number;
      due_date: string | null; daysOverdue: number | null;
    }[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .select("id, vendor_name, amount, due_date, expense_date")
        .eq("paid", false)
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(500);
      if (error) throw error;

      const today = localDateISO(new Date());
      const todayMs = Date.parse(`${today}T00:00:00+05:30`);
      return (data ?? []).map((r) => {
        const due = (r.due_date ?? null) as string | null;
        return {
          id: r.id as string,
          vendor: (r.vendor_name ?? null) as string | null,
          amount: (r.amount ?? 0) as number,
          due_date: due,
          daysOverdue: due
            ? Math.round((todayMs - Date.parse(`${due.slice(0, 10)}T00:00:00+05:30`)) / 86_400_000)
            : null,
        };
      });
    },
    staleTime: 15_000,
  });
}

/**
 * Settle a payable: flip paid → true, stamp the paid date + method. If it was
 * paid out of a petty-cash account, drop the matching cash debit NOW (not at
 * bill time) so cash-in-hand only moves when the money actually left.
 */
export function useMarkExpensePaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      paid_date: string;
      payment_method: string;
      pettyCashAccountId?: string | null;
    }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .update({ paid: true, paid_date: input.paid_date, payment_method: input.payment_method })
        .eq("id", input.id)
        .select()
        .single();
      if (error) throw error;
      const expense = data as Expense;

      if (input.pettyCashAccountId && expense.amount > 0) {
        const { data: txn, error: txnErr } = await supabase.from("bank_transactions").insert({
          tenant_id:        expense.tenant_id,
          bank_account_id:  input.pettyCashAccountId,
          txn_date:         input.paid_date,
          description:      `Petty cash: ${expense.category}${expense.vendor_name ? ` · ${expense.vendor_name}` : ""}`,
          debit:            expense.amount,
          credit:           0,
          source:           "manual",
          matched_to_type:  "expense",
          matched_to_id:    expense.id,
          match_confidence: "manual",
        }).select("id").single();
        if (txnErr) console.error("[mark-paid] petty-cash debit failed (still marked paid):", txnErr);
        // Cash-ledger line = the reconciliation → link it so it reads "Paid".
        else if (txn) await supabase.from("expenses").update({ reconciled_txn_id: txn.id }).eq("id", expense.id);
      }
      return expense;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] }); // R-101: a spend / delete moves an advance balance
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Marked paid");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/**
 * Bulk mark several operating expenses paid in one shot — the "clear my payables
 * for the month" flow. Non-cash only (bank/UPI/card/cheque): a single UPDATE ...
 * IN (ids) sets paid + date + method. Cash/petty-cash isn't bulk-able because
 * each needs its own petty-cash account, so those stay on the single dialog.
 * Payroll/statutory rows are never included by the caller.
 */
export function useBulkMarkExpensesPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { ids: string[]; paid_date: string; payment_method: string }) => {
      if (input.ids.length === 0) return 0;
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .update({ paid: true, paid_date: input.paid_date, payment_method: input.payment_method })
        .in("id", input.ids)
        .select("id");
      if (error) throw error;
      return (data ?? []).length;
    },
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] }); // R-101: a spend / delete moves an advance balance
      toast.success(`${count} ${count === 1 ? "expense" : "expenses"} marked paid`);
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: ExpenseUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as Expense;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] }); // R-101: a spend / delete moves an advance balance
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      toast.success("Expense updated");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("expenses").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["employee_expense_advances"] }); // R-101: a spend / delete moves an advance balance
      qc.invalidateQueries({ queryKey: ["project_sales"] });
      toast.success("Expense deleted");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}

/**
 * Commission already booked to one person this financial year — for the s.194H limit
 * (lib/accounting/commission-tds.ts). Matches the payee name case-insensitively; the entry
 * being edited is left out so it is not counted twice.
 */
/**
 * What this payee was paid this FY before the entry being typed — the TDS base (amount
 * less GST) of every earlier expense to the same vendor, and how much of it carried no
 * TDS. Feeds lib/accounting/tds-deductor.ts (thresholds are per payee per year).
 * Matched by vendor id when the row has one, else by name; rows under another section
 * are left out (a contractor's rent is not contract work).
 */
export function useVendorTdsThisFy(vendorId: string | null, vendorName: string, section: string, onDate: string, excludeId?: string | null) {
  const name = vendorName.trim();
  const sec = section.trim();
  return useQuery({
    queryKey: ["expenses", "vendor-tds-fy", vendorId ?? "", name.toLowerCase(), sec, onDate.slice(0, 10), excludeId ?? null],
    enabled: sec.length > 0,
    queryFn: async (): Promise<{ base: number; baseWithoutTds: number }> => {
      if (!vendorId && name.length < 2) return { base: 0, baseWithoutTds: 0 };
      const supabase = createClient();
      let q = supabase
        .from("expenses")
        .select("id, amount, gst_paid, tds_amount, tds_section")
        .gte("expense_date", fyStartOf(onDate))
        .lte("expense_date", onDate.slice(0, 10));
      q = vendorId ? q.eq("vendor_id", vendorId) : q.ilike("vendor_name", name.replace(/[%_\\]/g, (c) => "\\" + c));
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []).filter((r) => r.id !== excludeId && (!r.tds_section || r.tds_section === sec));
      const baseOf = (r: { amount: number | null; gst_paid: number | null }) => Math.max(0, (r.amount ?? 0) - (r.gst_paid ?? 0));
      return {
        base: rows.reduce((s, r) => s + baseOf(r), 0),
        baseWithoutTds: rows.filter((r) => !(r.tds_amount && r.tds_amount > 0)).reduce((s, r) => s + baseOf(r), 0),
      };
    },
    staleTime: 30_000,
  });
}

export function useCommissionToPayeeThisFy(payee: string, onDate: string, excludeId?: string | null) {
  const name = payee.trim();
  return useQuery({
    queryKey: ["expenses", "commission-fy", name.toLowerCase(), onDate.slice(0, 10), excludeId ?? null],
    enabled: name.length >= 2,
    queryFn: async (): Promise<{ earlier: number; earlierWithoutTds: number }> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("expenses")
        .select("id, amount, tds_amount")
        .eq("category", COMMISSION_CATEGORY)
        .ilike("vendor_name", name.replace(/[%_\\]/g, (c) => "\\" + c))
        .gte("expense_date", fyStartOf(onDate))
        .lte("expense_date", onDate.slice(0, 10));
      if (error) throw error;
      const rows = (data ?? []).filter((r) => r.id !== excludeId);
      return {
        earlier: rows.reduce((s, r) => s + (r.amount ?? 0), 0),
        earlierWithoutTds: rows.filter((r) => !(r.tds_amount && r.tds_amount > 0)).reduce((s, r) => s + (r.amount ?? 0), 0),
      };
    },
    staleTime: 30_000,
  });
}
