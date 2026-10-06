/**
 * The money inbox — four folders of work, not four slices of one list.
 *
 * ─── WHY THIS IS *NOT* THE LEADS FOLDER MODEL ───────────────────────────────
 * lib/leads/folders.ts partitions ONE set of rows, so its counts add up and that is the
 * property its tests protect. This does the opposite and the difference is the whole
 * design:
 *
 *   📥 Unpaid Invoices        — invoices     (money owed TO us)
 *   💳 Unmatched Bank Credits — bank lines   (money that ARRIVED, unexplained)
 *   🧾 Vendor Bills Due       — bills        (money owed BY us)
 *   🏛️ GST & Tax             — a net figure  (money owed to the government)
 *
 * Four different tables, four different units. `2 invoices + 1 deposit + 3 bills` is not
 * 6 of anything, and `₹56,000 receivable + ₹12,000 payable` is not ₹68,000 — it is two
 * numbers pointing in opposite directions.
 *
 * So this deliberately has NO "All" chip and NO grand total. Pardeep read
 * "All open 8 · Inbox 7 · Hot 2" on /leads and added 7+2, which was the right instinct
 * and the reason that row got redesigned. A row of money counts would invite exactly the
 * same addition, except here the sum would be meaningless rather than merely
 * double-counted — and on a money screen a meaningless total is one somebody reports.
 *
 * The folders are therefore rendered as four separate cards, each carrying its own noun
 * ("2 invoices", "₹12,000 across 3 bills"), and the `direction` field below exists so the
 * UI can never print an inbound and an outbound figure in the same colour.
 *
 * ─── ORDER IS BY WHAT MOVES CASH SOONEST ────────────────────────────────────
 * Receivables first: chasing them is the only one of the four that BRINGS money in, and
 * it is the one a reseller postpones because it is socially awkward. Unmatched credits
 * second — that is money already in the bank that the books cannot see. Bills third.
 * GST last, because its deadline is monthly and known, not daily and forgettable.
 */

export type MoneyFolderId = "receivables" | "unmatched_credits" | "bills_due" | "gst";

/** Which way the money is going. Drives colour; an inbound and an outbound total must
 *  never look alike. */
export type MoneyDirection = "in" | "out" | "government";

export interface MoneyFolderMeta {
  id:    MoneyFolderId;
  label: string;
  icon:  string;
  /** The noun being counted. Plural; the UI singularises. Never "items". */
  noun:  string;
  direction: MoneyDirection;
  /** What the operator should do here, in one line. */
  action: string;
  /** Shown when the folder is empty — and it says what "empty" MEANS. */
  emptyHint: string;
  /** Where the full feature lives. The inbox triages; these pages do the work. */
  href: string;
}

export const MONEY_FOLDERS: readonly MoneyFolderMeta[] = [
  {
    id: "receivables", label: "Unpaid Invoices", icon: "📥", noun: "invoices",
    direction: "in",
    action: "Chase it — a reminder now carries a UPI link the customer can tap.",
    /* Was "Nobody owes you money", and it had to change the moment it hit real data.
       Every one of ANUTECH's 8 invoices is paid, so this folder correctly read ₹0 —
       three inches under a KPI reading "OWED TO YOU ₹1,33,576". Both numbers were right
       and together they read as a contradiction, because "owed to you" also carries
       project receivables, TDS credits and employee loans, none of which are invoices.
       A folder's empty line may only claim what the folder actually counts. */
    emptyHint: "No unpaid invoices. Project milestones, TDS credits and staff advances are counted separately in “Owed to you”.",
    href: "/invoices",
  },
  {
    id: "unmatched_credits", label: "Unmatched Bank Credits", icon: "💳",
    direction: "in",
    noun: "deposits",
    action: "Money already in your account that the books cannot explain. Match it.",
    /* R-179: bina bank account / statement ke bhi ye "sab theek" kehta tha. Sirf wahi kaho jo
       folder ginta hai — imported bank lines. */
    emptyHint: "No unmatched credits in your imported bank lines.",
    href: "/accounting/banking",
  },
  {
    id: "bills_due", label: "Vendor Bills Due", icon: "🧾", noun: "bills",
    direction: "out",
    action: "What you owe Google, Microsoft and Zoho. Pay or schedule.",
    emptyHint: "No wholesale bills outstanding.",
    href: "/accounting/expenses",
  },
  {
    id: "gst", label: "GST & Tax", icon: "🏛️", noun: "returns",
    direction: "government",
    action: "Output tax collected, less input credit. File before the 20th.",
    emptyHint: "Nothing payable this financial year — output tax is covered by input credit.",
    href: "/accounting/gst",
  },
] as const;

export interface MoneyFolderState {
  id: MoneyFolderId;
  /** How many rows. */
  count: number;
  /** ₹, whole rupees. Always POSITIVE — `direction` carries the sign's meaning. */
  amount: number;
  /** True when this folder wants attention today. */
  urgent: boolean;
  /** Why it is urgent, or null. */
  urgentReason: string | null;
}

export interface MoneyInboxInput {
  /** Unpaid / overdue invoices: amount still owed on each, and how late it is. */
  receivables: { amountDue: number; daysOverdue: number }[];
  /** Bank credits with no matched_to_type. */
  unmatchedCredits: { amount: number; daysOld: number }[];
  /** Bills and expenses not yet paid. */
  billsDue: { amountDue: number; daysOverdue: number }[];
  /**
   * Net GST for the year: output tax minus input credit. May be NEGATIVE, which means
   * credit in hand rather than a debt — see `gstFolderState`.
   */
  gstNet: number;
}

/** Anything past its date at all is urgent. There is no grace worth inventing here. */
const OVERDUE_DAYS = 1;
/** A deposit nobody has explained within a week is a bookkeeping problem, not a backlog. */
const STALE_CREDIT_DAYS = 7;

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

/**
 * GST is the one folder whose number can be NEGATIVE, and it must not be shown as a
 * debt when it is a credit.
 *
 * Input credit exceeding output tax is a perfectly normal month for a reseller — they
 * bought wholesale licences and have not yet billed them all on. Printing "₹-8,000
 * payable" or, worse, "₹8,000 payable" would either confuse or invert the fact.
 */
export function gstFolderState(gstNet: number): MoneyFolderState {
  const payable = gstNet > 0;
  return {
    id: "gst",
    count: payable ? 1 : 0,
    amount: Math.abs(gstNet),
    urgent: payable,
    urgentReason: payable
      ? "Net GST is payable this year — due by the 20th of next month."
      : gstNet < 0
        ? "Input credit exceeds output tax, so nothing is payable — the balance carries forward."
        : null,
  };
}

export function moneyInboxState(input: MoneyInboxInput): Record<MoneyFolderId, MoneyFolderState> {
  const overdueRecv = input.receivables.filter((r) => r.daysOverdue >= OVERDUE_DAYS);
  const staleCredits = input.unmatchedCredits.filter((c) => c.daysOld >= STALE_CREDIT_DAYS);
  const overdueBills = input.billsDue.filter((b) => b.daysOverdue >= OVERDUE_DAYS);

  return {
    receivables: {
      id: "receivables",
      count: input.receivables.length,
      amount: sum(input.receivables.map((r) => r.amountDue)),
      urgent: overdueRecv.length > 0,
      urgentReason: overdueRecv.length > 0
        /* The overdue AMOUNT, not the total — "₹40,000 of it is late" is what decides
           whether the reseller picks up the phone this morning. */
        ? `${overdueRecv.length} of them are past due, worth ${sum(overdueRecv.map((r) => r.amountDue))} rupees.`
        : null,
    },
    unmatched_credits: {
      id: "unmatched_credits",
      count: input.unmatchedCredits.length,
      amount: sum(input.unmatchedCredits.map((c) => c.amount)),
      urgent: staleCredits.length > 0,
      urgentReason: staleCredits.length > 0
        ? `${staleCredits.length} have been sitting unexplained for over a week — your cash balance is right and your books are not.`
        : null,
    },
    bills_due: {
      id: "bills_due",
      count: input.billsDue.length,
      amount: sum(input.billsDue.map((b) => b.amountDue)),
      urgent: overdueBills.length > 0,
      urgentReason: overdueBills.length > 0
        ? `${overdueBills.length} are past their due date — a vendor suspension costs you the customer, not just the licence.`
        : null,
    },
    gst: gstFolderState(input.gstNet),
  };
}

/** Total work waiting, as a COUNT of rows — never a rupee total. See the header. */
export function totalOpenItems(state: Record<MoneyFolderId, MoneyFolderState>): number {
  return MONEY_FOLDERS.reduce((n, f) => n + state[f.id].count, 0);
}

/** The folders wanting attention today, in the module's own order. */
export function urgentFolders(
  state: Record<MoneyFolderId, MoneyFolderState>,
): MoneyFolderMeta[] {
  return MONEY_FOLDERS.filter((f) => state[f.id].urgent);
}
