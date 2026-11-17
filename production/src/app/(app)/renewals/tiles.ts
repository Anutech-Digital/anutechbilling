/**
 * R-2405 — the tiles at the top of Renewals, each one a button that filters the queue.
 *
 * Audit (Anutech-HQ/drafts/RENEWALS-AUDIT/page-audit.md): the old Insights line read
 * "Urgent MRR ₹5.8L · Upcoming 30d MRR ₹7.0K · At risk ARR ₹69.2L" — monthly and yearly money
 * mixed, and none of it led to a list. Now six tiles, all in the SAME money the table shows (the
 * row's renewal amount: R-2751 the term amount BEFORE GST, whether or not a renewal quote exists —
 * queue.ts renewalAmount), and a click shows exactly the rows a tile adds up:
 *
 *   Overdue            the Overdue tab's rows
 *   Due in 30 days     due today .. +30 days (the ≤7 days + 8–30 tabs)
 *   Due in 31–60 days  the 31–60 tab        ┐ windows, not "within 60/90": the three Due tiles
 *   Due in 61–90 days  the 61–90 tab        ┘ never count a renewal twice and add up
 *     — the Due tiles leave out a renewal already paid (status Renewed) and one the customer
 *       said they won't renew: that money is in, or not coming.
 *   Won't renew        rows marked Won't renew, still running (the money that is leaving)
 *   Renewed this month renewals whose renewal date is in this IST month and are paid, as ₹ and
 *                      as % of all renewals due this month (paid + still due). Its click shows
 *                      what is still due this month — the rows to work to lift that %.
 *
 * Paid renewals mostly leave the queue (record_payment moves renewal_date on), so "renewed" comes
 * from the renewal quotes themselves (quotes.is_renewal, renewal_term_date = the renewal date it
 * renewed — R-1574) that are fully paid. Pure — tested in tiles-r2405.test.ts.
 */
import { taxableAfterDiscount } from "@/lib/quotes/amounts";
import { SAAS_GST_RATE } from "@/lib/gst/hsn";
import type { RenewalForecast } from "@/lib/renewals/forecast";
import { rupee } from "@/lib/utils";
import { liveTogetherLinks, type TogetherLink } from "./last-docs";
import type { QueueTab, RowStatusKey } from "./queue";

export const TILE_KEYS = ["overdue", "due30", "due60", "due90", "wontRenew", "renewedMonth"] as const;
export type TileKey = (typeof TILE_KEYS)[number];

export const TILE_LABEL: Record<TileKey, string> = {
  overdue: "Overdue",
  due30: "Due in 30 days",
  due60: "Due in 31–60 days",
  due90: "Due in 61–90 days",
  wontRenew: "Won't renew",
  renewedMonth: "Renewed this month",
};

/**
 * R-2855: what each tile's ₹ IS, in plain words, printed under the number (it was only in the tooltip).
 * The work tiles add up renewal VALUE (the next term's bill, before GST) — not unpaid bills; the header
 * line carries those ("Bills and instalments due: ₹X unpaid on these renewals"). The Renewed tile's
 * caption is worked out (tileText): the % and the month's ₹ it divides by.
 */
export const TILE_CAPTION: Record<Exclude<TileKey, "renewedMonth">, string> = {
  overdue: "Renewal value overdue",
  due30: "Renewal value due",
  due60: "Renewal value due",
  due90: "Renewal value due",
  wontRenew: "Renewal value leaving",
};

/** What the table shows when a tile is pressed. R-2741: the Renewed tile lists the renewals it counts. */
export const TILE_VIEW_LABEL: Record<TileKey, string> = { ...TILE_LABEL };

/** One queue row, as the tiles need it. */
export interface TileRow {
  id: string;
  tab: QueueTab;
  statusKey: RowStatusKey;
  /** The row's renewal amount in whole rupees (queue.ts renewalAmount().value). */
  amount: number;
  /**
   * R-2862: what falls due on the row's Due date, ₹ before GST (due-anchor.ts rowDue().amount) — a part-billed row
   * with one part unpaid owes that PART, not the term. The Overdue / Due tiles add this; absent = `amount`.
   * Won't renew and Renewed this month stay on the term amount (the renewal's value leaving / dated in the month).
   */
  dueAmount?: number;
  renewalDate: string | null;
}

/** A renewal quote, as loaded for the Renewed tile. */
export interface RenewalQuotePayment {
  id: string;
  amount: number | null;
  payment_amount: number | null;
  payment_status: string | null;
  status?: string | null;
  renewal_subscription_id: string | null;
  renewal_term_date: string | null;
  /** R-2751: for the amount before GST = subtotal less discount (quotes.subtotal / discount_pct / tax_rate). */
  subtotal?: number | null;
  discount_pct?: number | null;
  tax_rate?: number | null;
}



/**
 * R-2751: a paid renewal quote counts in "Renewed this month" at its amount BEFORE GST — the same
 * basis as every row and tile (queue.ts renewalAmount: term amount + GST). It used the total incl.
 * GST, so "of ₹1.0L due in Nov" mixed incl. GST (paid) with before GST (still due).
 * Subtotal less discount; a quote with no subtotal → total ÷ (1 + its GST rate).
 */
export function quoteAmountBeforeGst(q: Pick<RenewalQuotePayment, "amount" | "subtotal" | "discount_pct" | "tax_rate">): number {
  const sub = Math.round(q.subtotal ?? 0);
  if (sub > 0) return taxableAfterDiscount(sub, q.discount_pct ?? 0);
  const rate = Math.max(0, q.tax_rate ?? SAAS_GST_RATE);
  return Math.round(((q.amount ?? 0) * 100) / (100 + rate));
}

export interface MonthRange {
  /** YYYY-MM-01 */
  start: string;
  /** last day, YYYY-MM-DD */
  end: string;
  /** "Nov" */
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The calendar month of an IST date (YYYY-MM-DD). */
export function monthOf(todayIst: string): MonthRange {
  const y = Number(todayIst.slice(0, 4));
  const m = Number(todayIst.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}`, label: MONTHS[m - 1] };
}

const inMonth = (d: string | null | undefined, month: Pick<MonthRange, "start" | "end">) => !!d && d >= month.start && d <= month.end;

/**
 * A renewal quote whose money is fully in: received (or received and then invoiced — the invoice
 * keeps payment_amount) for at least the quote total. A partial payment is not a renewal.
 */
export function isFullyPaidRenewal(q: RenewalQuotePayment): boolean {
  if (q.status === "rejected" || q.status === "cancelled" || q.status === "void") return false;
  if (q.payment_status !== "received" && q.payment_status !== "invoiced") return false;
  const total = Math.round(q.amount ?? 0);
  return total > 0 && Math.round(q.payment_amount ?? 0) >= total;
}

const NOT_DUE: ReadonlySet<RowStatusKey> = new Set(["renewed", "non-renewing"]);

/**
 * Is this row one the tile adds up (and the table shows when the tile is pressed)?
 * `paidSubs` = subscriptions with a fully paid renewal quote this month (Renewed tile only).
 */
export function tileMatches(key: TileKey, r: TileRow, month: MonthRange, paidSubs: ReadonlySet<string> = new Set()): boolean {
  switch (key) {
    /* R-2741: Overdue leaves out a Won't renew / renewed row too — it is counted in its own tile, once. */
    case "overdue":   return r.tab === "overdue" && !NOT_DUE.has(r.statusKey);
    case "due30":     return (r.tab === "due7" || r.tab === "d30") && !NOT_DUE.has(r.statusKey);
    case "due60":     return r.tab === "d60" && !NOT_DUE.has(r.statusKey);
    case "due90":     return r.tab === "d90" && !NOT_DUE.has(r.statusKey);
    case "wontRenew": return r.statusKey === "non-renewing";
    case "renewedMonth":
      return inMonth(r.renewalDate, month) && !NOT_DUE.has(r.statusKey) && !paidSubs.has(r.id);
  }
}

/** R-2741: the rows the Renewed tile's press lists — the renewals it adds up (a paid quote, or a Renewed row not moved on yet). */
export function renewedRowMatches(r: TileRow, month: MonthRange, paidSubs: ReadonlySet<string>): boolean {
  return paidSubs.has(r.id) || (r.statusKey === "renewed" && inMonth(r.renewalDate, month));
}

/** The queue tabs each Overdue / Due tile is made of. */
export const TILE_WINDOW_TABS = {
  overdue: ["overdue"], due30: ["due7", "d30"], due60: ["d60"], due90: ["d90"],
} as const satisfies Record<string, readonly QueueTab[]>;
export type WindowKey = keyof typeof TILE_WINDOW_TABS;

export interface WindowReconcile {
  /** Rows the tabs of this window hold (the tab counts added up). */
  tabRows: number;
  /** Rows the tile counts. */
  tileRows: number;
  /** Closed rows the tabs still list but the tile leaves out (own tile / already renewed). */
  wontRenew: number;
  renewed: number;
}

/**
 * R-2741 — ONE function for "tile = tab count = sum of rows": for each window, the tab rows split
 * into what the tile counts + the closed rows it leaves out, so tabRows === tileRows + wontRenew + renewed
 * always, and the tile can say "(+1 won't renew)" instead of looking 1 short of its tab.
 */
export function reconcileWindows(rows: readonly TileRow[], month: MonthRange): Record<WindowKey, WindowReconcile> {
  const out = {} as Record<WindowKey, WindowReconcile>;
  for (const key of Object.keys(TILE_WINDOW_TABS) as WindowKey[]) {
    const tabs: readonly QueueTab[] = TILE_WINDOW_TABS[key];
    const inTabs = rows.filter((r) => tabs.includes(r.tab));
    out[key] = {
      tabRows: inTabs.length,
      tileRows: inTabs.filter((r) => tileMatches(key, r, month)).length,
      wontRenew: inTabs.filter((r) => r.statusKey === "non-renewing").length,
      renewed: inTabs.filter((r) => r.statusKey === "renewed").length,
    };
  }
  return out;
}

/** "(+1 won't renew)" / "(+2 renewed)" — what a tab holds beyond its tile; "" when they agree. */
export function windowExtraNote(w: WindowReconcile): string {
  const parts = [w.wontRenew > 0 ? `${w.wontRenew} won't renew` : "", w.renewed > 0 ? `${w.renewed} renewed` : ""].filter(Boolean);
  return parts.length ? `(+${parts.join(", +")})` : "";
}

export interface TileFigure {
  count: number;
  /** Whole rupees. */
  amount: number;
}

export interface RenewedFigure extends TileFigure {
  /** Paid + still due this month, whole rupees. */
  dueAmount: number;
  /** Renewed ₹ ÷ due ₹, whole percent; null when nothing was due this month. */
  pct: number | null;
  /** What the tile's click shows: renewals of this month not paid yet. */
  stillDue: TileFigure;
  /** R-2855: `stillDue` split by where those rows sit — past their date (in the Overdue tile) … */
  stillDueOverdue: TileFigure;
  /** … and not due yet (in the Due in 30 days tile). stillDueOverdue + stillDueLater = stillDue, always. */
  stillDueLater: TileFigure;
}

export type RenewalTiles = Record<Exclude<TileKey, "renewedMonth">, TileFigure> & { renewedMonth: RenewedFigure };

/** Subscriptions with a fully paid renewal quote for a renewal date in this month. */
export function paidRenewalsInMonth(quotes: readonly RenewalQuotePayment[], month: MonthRange): RenewalQuotePayment[] {
  const seen = new Set<string>();
  return quotes.filter((q) => {
    if (seen.has(q.id) || !inMonth(q.renewal_term_date, month) || !isFullyPaidRenewal(q)) return false;
    seen.add(q.id);
    return true;
  });
}

/**
 * R-2870: a together quote (renewal_quote_subscriptions) leaves quotes.renewal_subscription_id / renewal_term_date empty, so the
 * month read never sees it. Each live link whose term is in the month becomes ONE entry for its member: the member's own
 * subtotal (before GST — never the whole quote on each), the quote's paid state. Ids are per member, so paidRenewalsInMonth
 * keeps both. A quote not read (or not fully paid / closed) adds nothing — isFullyPaidRenewal decides, as for any renewal.
 */
export function togetherMemberPayments(
  links: readonly TogetherLink[],
  quotes: ReadonlyArray<Pick<RenewalQuotePayment, "id" | "amount" | "payment_amount" | "payment_status" | "status" | "tax_rate">>,
  month: Pick<MonthRange, "start" | "end">,
): RenewalQuotePayment[] {
  const byId = new Map(quotes.map((q) => [q.id, q]));
  const out: RenewalQuotePayment[] = [];
  for (const l of liveTogetherLinks(links)) {
    const q = byId.get(l.quote_id);
    if (!q || !inMonth(l.renewal_term_date, month)) continue;
    out.push({
      id: `${q.id}#${l.subscription_id}`, amount: q.amount, payment_amount: q.payment_amount, payment_status: q.payment_status, status: q.status ?? null,
      renewal_subscription_id: l.subscription_id, renewal_term_date: l.renewal_term_date,
      subtotal: l.subtotal, discount_pct: 0, tax_rate: q.tax_rate ?? null,
    });
  }
  return out;
}

export function renewalTiles(rows: readonly TileRow[], quotes: readonly RenewalQuotePayment[], month: MonthRange): RenewalTiles {
  const paid = paidRenewalsInMonth(quotes, month);
  const paidSubs = new Set(paid.map((q) => q.renewal_subscription_id).filter((x): x is string => !!x));
  const sum = (key: TileKey): TileFigure => {
    let count = 0, amount = 0;
    /* R-2862: the window tiles add what is due on the Due date (a late part = that part only) */
    const of = (r: TileRow) => (key in TILE_WINDOW_TABS ? r.dueAmount ?? r.amount : r.amount);
    for (const r of rows) if (tileMatches(key, r, month, paidSubs)) { count += 1; amount += Math.round(of(r)); }
    return { count, amount };
  };
  /* a row already Renewed (paid, its date not moved yet) with no paid quote loaded counts as renewed too */
  const renewedRows = rows.filter((r) => r.statusKey === "renewed" && inMonth(r.renewalDate, month) && !paidSubs.has(r.id));
  const renewedCount = paid.length + renewedRows.length;
  /* R-2751: before GST, like the rows (it was the quote total incl. GST). */
  const renewedAmount = paid.reduce((s, q) => s + quoteAmountBeforeGst(q), 0)
    + renewedRows.reduce((s, r) => s + Math.round(r.amount), 0);
  const stillDue = sum("renewedMonth");
  /* R-2855: the month's unpaid renewals, split by tab — the same rows, so the two parts add up to stillDue */
  const stillDueOverdue: TileFigure = { count: 0, amount: 0 };
  for (const r of rows) {
    if (r.tab === "overdue" && tileMatches("renewedMonth", r, month, paidSubs)) { stillDueOverdue.count += 1; stillDueOverdue.amount += Math.round(r.amount); }
  }
  const stillDueLater: TileFigure = { count: stillDue.count - stillDueOverdue.count, amount: stillDue.amount - stillDueOverdue.amount };
  const dueAmount = renewedAmount + stillDue.amount;
  return {
    overdue: sum("overdue"),
    due30: sum("due30"),
    due60: sum("due60"),
    due90: sum("due90"),
    wontRenew: sum("wontRenew"),
    renewedMonth: {
      count: renewedCount,
      amount: renewedAmount,
      dueAmount,
      pct: dueAmount > 0 ? Math.round((renewedAmount / dueAmount) * 100) : null,
      stillDue,
      stillDueOverdue,
      stillDueLater,
    },
  };
}

export interface TileText {
  /** The big number, compact ("₹4.5L"). */
  value: string;
  /** Beside it: how many renewals. */
  sub: string;
  /** R-2855: under it, what the number is — always on screen. */
  caption: string;
  /** The tooltip: full rupees and how the number is made. */
  title: string;
}

/** "1 renewal" / "3 renewals" — one wording for the tiles and the tile-view bar. */
export const plural = (n: number) => `${n} renewal${n === 1 ? "" : "s"}`;

/**
 * R-2855 — every word a tile shows, in one pure place (tiles-card.tsx only draws it).
 *
 * Renewed this month: "₹P · N renewals" and under it "N% of <month>'s ₹X", where ₹X = that month's
 * renewals, paid + not paid (before GST) — the base of the % is on the tile itself. The old helper said
 * "₹3.4L still due (Overdue + Due tiles)", read as "= those tiles added up" (4.5L + 5.4L): those tiles
 * also hold other months' renewals. The tooltip says how ₹X is made and which part of the unpaid rest
 * sits in Overdue and which in Due in 30 days (the two parts add up — renewalTiles).
 * Every branch reads the AMOUNTS (pct / stillDue.amount), so a ₹0 renewal never gives "₹0 of it not paid".
 */
export function tileText(key: TileKey, t: RenewalTiles, month: MonthRange, windows: Partial<Record<WindowKey, WindowReconcile>>): TileText {
  if (key === "renewedMonth") {
    const f = t.renewedMonth;
    const due = rupee(f.dueAmount, { compact: true });
    /* on the tile: short enough for one line of a 160px tile (1280 screen); the tooltip keeps "N% of ₹X due in <month>" */
    const caption = f.pct == null ? `Nothing due in ${month.label}` : `${f.pct}% of ${month.label}'s ${due}`;
    const long = f.pct == null ? caption : `${f.pct}% of ${due} due in ${month.label}`;
    const base = `"Due in ${month.label}" = renewals dated in ${month.label}, paid + not paid, before GST (${rupee(f.dueAmount)})`;
    const parts = [
      f.stillDueOverdue.amount > 0 ? `${rupee(f.stillDueOverdue.amount)} of it is in Overdue` : "",
      f.stillDueLater.amount > 0 ? `${rupee(f.stillDueLater.amount)} is not due yet (in ${TILE_LABEL.due30})` : "",
    ].filter(Boolean);
    const unpaid = f.stillDue.amount > 0
      ? `Not paid yet: ${rupee(f.stillDue.amount)} (${plural(f.stillDue.count)}) — ${parts.join(", ")}`
      : f.pct == null ? `No renewal value dated in ${month.label}` : `All of ${month.label}'s renewals are paid`;
    return {
      value: rupee(f.amount, { compact: true }),
      sub: plural(f.count),
      caption,
      title: `${TILE_LABEL[key]}: ${rupee(f.amount)} paid (${plural(f.count)}) — ${long}. ${base}. ${unpaid}. Press to list the renewed ones.`,
    };
  }
  const f = t[key];
  const w = key in windows ? windows[key as WindowKey] : undefined;
  const extra = w ? windowExtraNote(w) : "";   // R-2741: "(+1 won't renew)" — the tab lists it, the tile does not
  const sub = extra ? `${plural(f.count)} ${extra}` : plural(f.count);
  const caption = TILE_CAPTION[key];
  return {
    value: rupee(f.amount, { compact: true }),
    sub,
    caption,
    title: `${TILE_LABEL[key]}: ${rupee(f.amount)} — ${sub}. ${caption}, before GST (each renewal's next-term bill; not unpaid bills).${key in TILE_WINDOW_TABS ? " A renewal billed in parts with one part unpaid adds that part only." : ""} Press to list them.`,
  };
}

/**
 * R-2751: the Forecast's bar for THIS month = the Renewed tile's "of ₹X due in <month>" (paid +
 * still due, before GST). The audit saw "91% of ₹1.0L due in Nov" next to a Forecast Nov of
 * ₹12.6K: the forecast counted only subscriptions still dated in November, but a paid renewal has
 * already moved its date to next year. Later months stay the forecast's own (term amounts of the
 * renewals dated then); the totals are summed again so the strip's line adds up.
 */
export function forecastWithThisMonth(f: RenewalForecast, renewed: RenewedFigure, month: MonthRange): RenewalForecast {
  const key = month.start.slice(0, 7);
  const months = f.months.map((m) => (m.key === key
    ? { ...m, amount: renewed.dueAmount, count: renewed.count + renewed.stillDue.count }
    : m));
  return {
    ...f,
    months,
    totalAmount: months.reduce((s, m) => s + m.amount, 0),
    totalCount: months.reduce((s, m) => s + m.count, 0),
  };
}
