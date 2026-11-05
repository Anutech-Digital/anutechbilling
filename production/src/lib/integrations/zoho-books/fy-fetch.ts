/**
 * R-2498 (G-FY2526) — the Zoho Books reads the FY 2025-26 books need. READ only, server-side.
 *
 *   listFyDocsPage     one page (200) of invoices / credit notes / bills / expenses / vendor payments
 *                      dated inside a range (Zoho's date_start / date_end), typed, money in paise
 *   getFyDocDetail     one document with its lines (account, HSN/SAC, tax), tax split and TDS
 *   countFyDocs        how many of each the FY has — resumable cursor; a list the stored token has
 *                      no scope for is reported in `needsReconnect`, never fatal
 *   readChartOfAccounts the organization's accounts
 *   trialBalanceAsAt   every account's debit / credit up to an as-at date (each account's
 *                      transactions with date_end), resumable
 *   runPaced           the pacing loop: at most `budget` calls in any 60 s (ZOHO_CALLS_PER_MIN = 80,
 *                      under Zoho's ~100/min per organization, room left for "Find in Zoho"); stops on
 *                      a call limit or when Zoho says busy (429), so the caller resumes from the cursor
 *
 * Reuses api.ts (booksGet, PAGE_SIZE, ZohoApiError) and the cached access token (R-1757,
 * store.ts zohoAccessToken). No booking here — the imports are R-2499 onwards.
 *
 * Trial balance: Zoho's public v3 API documents no trial-balance report (and no "reports" scope), so
 * it is built from the documented `chartofaccounts/accounttransactions` (ZohoBooks.accountants.READ).
 * The year-end tie-out (R-2506) compares it with Zoho's own Trial Balance screen.
 */
import { getOne, listPage, ZohoApiError } from "./api";
import { paceWaitMs, ZOHO_CALLS_PER_MIN, type PaceEntry } from "./zoho-pace";

type Fetch = typeof fetch;

export const FY_DOC_KINDS = ["invoices", "creditnotes", "bills", "expenses", "vendorpayments"] as const;
export type FyDocKind = (typeof FY_DOC_KINDS)[number];

interface KindSpec {
  path: string; listKey: string; detailKey: string;
  idKey: string; numberKey: string; contactSide: "customer" | "vendor"; amountKey: "total" | "amount";
  label: string;
}

export const FY_DOC_SPECS: Record<FyDocKind, KindSpec> = {
  invoices: { path: "/invoices", listKey: "invoices", detailKey: "invoice", idKey: "invoice_id", numberKey: "invoice_number", contactSide: "customer", amountKey: "total", label: "invoices" },
  creditnotes: { path: "/creditnotes", listKey: "creditnotes", detailKey: "creditnote", idKey: "creditnote_id", numberKey: "creditnote_number", contactSide: "customer", amountKey: "total", label: "credit notes" },
  bills: { path: "/bills", listKey: "bills", detailKey: "bill", idKey: "bill_id", numberKey: "bill_number", contactSide: "vendor", amountKey: "total", label: "bills" },
  /* An expense has no number of its own; its reference number stands in. */
  expenses: { path: "/expenses", listKey: "expenses", detailKey: "expense", idKey: "expense_id", numberKey: "reference_number", contactSide: "vendor", amountKey: "total", label: "expenses" },
  vendorpayments: { path: "/vendorpayments", listKey: "vendorpayments", detailKey: "vendorpayment", idKey: "payment_id", numberKey: "payment_number", contactSide: "vendor", amountKey: "amount", label: "vendor payments" },
};

/** What the card says when the stored Zoho sign-in was made before these scopes existed (config.ts). */
export { ZOHO_FY_RECONNECT_MESSAGE } from "./config";

// ── small, pure helpers ───────────────────────────────────────────────────────────────────

/** Rupees (number or numeric string) → whole paise. Anything not a finite number → 0. */
export function toPaise(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export function assertIsoDate(d: string): string {
  if (!ISO_DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new Error("A date must be YYYY-MM-DD.");
  return d;
}

export interface DateRange { dateStart: string; dateEnd: string }

/** "2025-26" → 1 Apr 2025 … 31 Mar 2026. Anything else is refused (it goes into a Zoho URL). */
export function fyDateRange(fy: string): DateRange {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new Error("The financial year must look like 2025-26.");
  const y = Number(m[1]);
  return { dateStart: `${y}-04-01`, dateEnd: `${y + 1}-03-31` };
}

/** Zoho's "this token has no scope for that list": HTTP 401 with code 57. */
export function isScopeMissing(e: unknown): boolean {
  return e instanceof ZohoApiError && e.status === 401 && e.code === "books_57";
}
/** Zoho's "too many requests" (any shape api.ts gives it). */
export function isZohoBusy(e: unknown): boolean {
  return e instanceof ZohoApiError && (e.status === 429 || e.code === "busy");
}

// ── typed rows ────────────────────────────────────────────────────────────────────────────

export interface ZohoFyDoc {
  kind: FyDocKind;
  id: string;
  number: string;
  date: string;
  status: string;
  contactId: string;
  contactName: string;
  totalPaise: number;
  /** Still owed / unapplied; null when Zoho sent none. */
  balancePaise: number | null;
  currency: string;
  raw: Record<string, unknown>;
}

export interface ZohoFyLine {
  accountId: string; accountName: string; description: string; hsnOrSac: string;
  quantity: number; amountPaise: number; taxId: string; taxName: string; taxPercent: number | null;
}

export interface ZohoFyDocDetail extends ZohoFyDoc {
  lines: ZohoFyLine[];
  taxes: Array<{ name: string; amountPaise: number }>;
  taxTotalPaise: number;
  /** TDS deducted on the document (bills), 0 when none. */
  tdsPaise: number;
  gstNo: string;
  gstTreatment: string;
  placeOfSupply: string;
  reverseCharge: boolean;
}

function toDoc(kind: FyDocKind, r: Record<string, unknown>): ZohoFyDoc {
  const s = FY_DOC_SPECS[kind];
  const side = s.contactSide;
  const bal = num(r.balance);
  return {
    kind,
    id: str(r[s.idKey]),
    number: str(r[s.numberKey]),
    date: str(r.date),
    status: str(r.status),
    contactId: str(r[`${side}_id`]),
    contactName: str(r[`${side}_name`]),
    totalPaise: toPaise(r[s.amountKey] ?? r.total),
    balancePaise: bal === null ? null : Math.round(bal * 100),
    currency: str(r.currency_code),
    raw: r,
  };
}

function toLine(l: Record<string, unknown>): ZohoFyLine {
  return {
    accountId: str(l.account_id),
    accountName: str(l.account_name),
    description: str(l.description),
    hsnOrSac: str(l.hsn_or_sac),
    quantity: num(l.quantity) ?? 1,
    amountPaise: toPaise(l.item_total ?? l.amount),
    taxId: str(l.tax_id),
    taxName: str(l.tax_name),
    taxPercent: num(l.tax_percentage),
  };
}

function toDetail(kind: FyDocKind, r: Record<string, unknown>): ZohoFyDocDetail {
  const rawLines = Array.isArray(r.line_items) ? (r.line_items as Array<Record<string, unknown>>) : [];
  /* An expense often has no line items: its own account, pre-tax amount and tax make the one line. */
  const lines = rawLines.length
    ? rawLines.map(toLine)
    : kind === "expenses" && str(r.account_id)
      ? [toLine({ ...r, item_total: r.sub_total ?? r.amount ?? r.total, quantity: 1, description: r.description ?? "" })]
      : [];
  const taxes = (Array.isArray(r.taxes) ? (r.taxes as Array<Record<string, unknown>>) : [])
    .map((t) => ({ name: str(t.tax_name), amountPaise: toPaise(t.tax_amount) }));
  const taxTotalPaise = r.tax_total !== undefined ? toPaise(r.tax_total)
    : taxes.length ? taxes.reduce((a, t) => a + t.amountPaise, 0)
      : toPaise(r.tax_amount);
  return {
    ...toDoc(kind, r),
    lines,
    taxes,
    taxTotalPaise,
    tdsPaise: toPaise(r.tds_amount),
    gstNo: str(r.gst_no),
    gstTreatment: str(r.gst_treatment),
    placeOfSupply: str(r.place_of_supply),
    reverseCharge: r.is_reverse_charge_applied === true,
  };
}

// ── the reads ─────────────────────────────────────────────────────────────────────────────

export interface FyDocsPage { rows: ZohoFyDoc[]; more: boolean }

/** One page (200) of `kind` dated inside `range` (oldest first, so a resumed walk is stable). */
export async function listFyDocsPage(kind: FyDocKind, orgId: string, token: string, range: DateRange, page: number, f: Fetch = fetch): Promise<FyDocsPage> {
  const s = FY_DOC_SPECS[kind];
  const p = await listPage(s.path, s.listKey, orgId, token, Math.max(1, Math.floor(page)), f, {
    date_start: assertIsoDate(range.dateStart),
    date_end: assertIsoDate(range.dateEnd),
    sort_column: "date",
    sort_order: "A",
  });
  return { rows: p.rows.map((r) => toDoc(kind, r)), more: p.more };
}

/** One document with its lines, taxes and TDS. */
export async function getFyDocDetail(kind: FyDocKind, orgId: string, token: string, id: string, f: Fetch = fetch): Promise<ZohoFyDocDetail> {
  const s = FY_DOC_SPECS[kind];
  return toDetail(kind, await getOne(s.path, s.detailKey, orgId, token, id, f));
}

// ── pacing ────────────────────────────────────────────────────────────────────────────────

export interface PaceOpts {
  /** Calls allowed in any 60 s (default ZOHO_CALLS_PER_MIN). */
  budget?: number;
  /** Shared across runs so a resumed run keeps counting the last minute. */
  history?: PaceEntry[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stop after this many calls and hand back a cursor (a request stays short). */
  maxCalls?: number;
}

export type PacedStop = "done" | "limit" | "busy";

/**
 * Calls `step` (one Zoho call each; it returns true when nothing is left) under the pace.
 * Zoho busy → stops with "busy" (the step that failed is retried on resume — it must not have
 * moved its cursor). Any other error is thrown.
 */
export async function runPaced(opts: PaceOpts & { step: () => Promise<boolean> }): Promise<{ calls: number; stopped: PacedStop }> {
  const budget = Math.max(1, opts.budget ?? ZOHO_CALLS_PER_MIN);
  const history = opts.history ?? [];
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxCalls = Math.max(1, Math.floor(opts.maxCalls ?? Number.MAX_SAFE_INTEGER));
  let calls = 0;
  while (calls < maxCalls) {
    const wait = paceWaitMs(history, now(), 1, budget);
    if (wait > 0) await sleep(wait);
    history.push({ at: now(), calls: 1 });
    calls += 1;
    let done: boolean;
    try { done = await opts.step(); } catch (e) {
      if (isZohoBusy(e)) return { calls, stopped: "busy" };
      throw e;
    }
    if (done) return { calls, stopped: "done" };
  }
  return { calls, stopped: "limit" };
}

// ── FY counts ─────────────────────────────────────────────────────────────────────────────

export type FyCounts = Record<FyDocKind, number>;

/** Where a count stopped. It comes back from the browser, so it is checked before use. */
export interface FyCountCursor {
  fy: string;
  list: FyDocKind;
  page: number;
  counts: Partial<FyCounts>;
  needsReconnect: FyDocKind[];
}

const MAX_PAGE = 10_000;
const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_PAGE * 200;

function checkCursor(c: FyCountCursor, fy: string): FyCountCursor {
  const bad = () => new Error("The count cursor is not valid. Start the count again.");
  if (!c || typeof c !== "object" || c.fy !== fy) throw bad();
  if (!(FY_DOC_KINDS as readonly string[]).includes(c.list)) throw bad();
  if (!Number.isInteger(c.page) || c.page < 1 || c.page > MAX_PAGE) throw bad();
  const counts: Partial<FyCounts> = {};
  for (const [k, v] of Object.entries(c.counts ?? {})) {
    if (!(FY_DOC_KINDS as readonly string[]).includes(k) || !isCount(v)) throw bad();
    counts[k as FyDocKind] = v as number;
  }
  const nr = Array.isArray(c.needsReconnect) ? c.needsReconnect : [];
  if (!nr.every((k) => (FY_DOC_KINDS as readonly string[]).includes(k))) throw bad();
  return { fy, list: c.list, page: c.page, counts, needsReconnect: [...new Set(nr)] };
}

export interface FyCountResult {
  counts: FyCounts;
  needsReconnect: FyDocKind[];
  /** null = finished; otherwise send it back to carry on. */
  cursor: FyCountCursor | null;
  calls: number;
  busy: boolean;
}

/** One-row read of invoices (scope every connection has): true when the token itself works. */
async function tokenStillReads(orgId: string, token: string, f: Fetch): Promise<boolean> {
  try {
    await listPage("/invoices", "invoices", orgId, token, 1, f, { per_page: "1" });
    return true;
  } catch (e) {
    if (isScopeMissing(e) || (e instanceof ZohoApiError && e.status === 401)) return false;
    throw e;
  }
}

/** Counts the FY's documents of each kind, resumable. */
export async function countFyDocs(
  orgId: string, token: string, fy: string, cursor: FyCountCursor | null, pace: PaceOpts, f: Fetch = fetch,
): Promise<FyCountResult> {
  const range = fyDateRange(fy);
  const cur: FyCountCursor = cursor ? checkCursor(cursor, fy) : { fy, list: FY_DOC_KINDS[0], page: 1, counts: {}, needsReconnect: [] };
  let idx = FY_DOC_KINDS.indexOf(cur.list);
  let finished = false;
  const r = await runPaced({
    ...pace,
    step: async () => {
      const kind = FY_DOC_KINDS[idx];
      let more = false;
      try {
        const p = await listFyDocsPage(kind, orgId, token, range, cur.page, f);
        cur.counts[kind] = (cur.counts[kind] ?? 0) + p.rows.length;
        more = p.more && cur.page < MAX_PAGE;
      } catch (e) {
        if (!isScopeMissing(e)) throw e;
        /* Zoho Books answers an expired / revoked token with the same 401 code 57. Only call it a
           missing scope when a list every connection has (invoices, R-1749) still reads. */
        if (kind === "invoices" || !(await tokenStillReads(orgId, token, f))) throw e;
        if (!cur.needsReconnect.includes(kind)) cur.needsReconnect.push(kind);
      }
      if (more) { cur.page += 1; return false; }
      cur.counts[kind] = cur.counts[kind] ?? 0;
      idx += 1;
      if (idx >= FY_DOC_KINDS.length) { finished = true; return true; }
      cur.list = FY_DOC_KINDS[idx];
      cur.page = 1;
      return false;
    },
  });
  const counts = Object.fromEntries(FY_DOC_KINDS.map((k) => [k, cur.counts[k] ?? 0])) as FyCounts;
  return { counts, needsReconnect: cur.needsReconnect, cursor: finished ? null : cur, calls: r.calls, busy: r.stopped === "busy" };
}

// ── chart of accounts + trial balance ─────────────────────────────────────────────────────

export interface ZohoAccount { id: string; name: string; code: string; type: string; active: boolean }

function toAccount(r: Record<string, unknown>): ZohoAccount {
  return { id: str(r.account_id), name: str(r.account_name), code: str(r.account_code), type: str(r.account_type), active: r.is_active !== false };
}

async function coaPage(orgId: string, token: string, page: number, f: Fetch) {
  const p = await listPage("/chartofaccounts", "chartofaccounts", orgId, token, page, f, { filter_by: "AccountType.All", sort_column: "account_code" });
  return { rows: p.rows.map(toAccount).filter((a) => a.id), more: p.more };
}

/** Every account (active and inactive), all pages. */
export async function readChartOfAccounts(orgId: string, token: string, f: Fetch = fetch): Promise<ZohoAccount[]> {
  const out: ZohoAccount[] = [];
  for (let page = 1; page <= MAX_PAGE; page++) {
    const p = await coaPage(orgId, token, page, f);
    out.push(...p.rows);
    if (!p.more) break;
  }
  return out;
}

export interface TbRow { accountId: string; name: string; code: string; type: string; debitPaise: number; creditPaise: number }

export interface TbCursor {
  asAt: string;
  phase: "accounts" | "transactions";
  page: number;
  accounts: ZohoAccount[];
  accIdx: number;
  /** Running sums for accounts[accIdx…]; finished accounts are in `done`. */
  dr: number; cr: number;
  done: TbRow[];
}

export interface TbResult {
  rows: TbRow[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  cursor: TbCursor | null;
  calls: number;
  busy: boolean;
}

/**
 * Trial balance as at `asAt` (inclusive): each account's transactions up to that date, netted to
 * one debit or credit figure. Server-side and resumable (the cursor is the server's own — it
 * is not meant to round-trip through a browser).
 */
export async function trialBalanceAsAt(
  orgId: string, token: string, asAt: string, cursor: TbCursor | null, pace: PaceOpts, f: Fetch = fetch,
): Promise<TbResult> {
  assertIsoDate(asAt);
  if (cursor && cursor.asAt !== asAt) throw new Error("The trial balance cursor is for another date.");
  const cur: TbCursor = cursor
    ? { ...cursor, accounts: [...cursor.accounts], done: [...cursor.done] }
    : { asAt, phase: "accounts", page: 1, accounts: [], accIdx: 0, dr: 0, cr: 0, done: [] };
  const closeAccount = () => {
    const a = cur.accounts[cur.accIdx];
    const net = cur.dr - cur.cr;
    cur.done.push({ accountId: a.id, name: a.name, code: a.code, type: a.type, debitPaise: net > 0 ? net : 0, creditPaise: net < 0 ? -net : 0 });
    cur.accIdx += 1; cur.page = 1; cur.dr = 0; cur.cr = 0;
  };
  const r = await runPaced({
    ...pace,
    step: async () => {
      if (cur.phase === "accounts") {
        const p = await coaPage(orgId, token, cur.page, f);
        cur.accounts.push(...p.rows);
        if (p.more && cur.page < MAX_PAGE) { cur.page += 1; return false; }
        cur.phase = "transactions"; cur.page = 1;
        return cur.accounts.length === 0;
      }
      const a = cur.accounts[cur.accIdx];
      const p = await listPage("/chartofaccounts/accounttransactions", "transactions", orgId, token, cur.page, f, {
        account_id: a.id, date_end: asAt, sort_column: "date", sort_order: "A",
      });
      let dr = 0, cr = 0;
      for (const t of p.rows) { dr += toPaise(t.debit_amount); cr += toPaise(t.credit_amount); }
      cur.dr += dr; cur.cr += cr;
      if (p.more && cur.page < MAX_PAGE) { cur.page += 1; return false; }
      closeAccount();
      return cur.accIdx >= cur.accounts.length;
    },
  });
  const finished = r.stopped === "done";
  const rows = cur.done;
  return {
    rows,
    totalDebitPaise: rows.reduce((s, x) => s + x.debitPaise, 0),
    totalCreditPaise: rows.reduce((s, x) => s + x.creditPaise, 0),
    cursor: finished ? null : cur,
    calls: r.calls,
    busy: r.stopped === "busy",
  };
}
