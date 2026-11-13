/**
 * POST /api/integrations/zoho-books/bulk-match — R-2402 "Reconcile from Zoho" (bulk) on a bank account.
 *
 *   { accountId }                → { ok, ids, total }    the account's UNMATCHED money-in lines,
 *                                                         newest first (what the plan walks through)
 *   { accountId, txnIds (≤ 8) }  → { ok, rows, skipped, zohoCalls, stopped? }
 *        each line: R-2359's Zoho match (from ONE cached read of the account's payment window, then
 *        the payment, its invoices and — for a customer the app does not have — the Zoho contact);
 *        `zohoCalls` = Zoho requests this page made, so the browser keeps under Zoho's limit;
 *        Zoho busy part way → the lines done so far + `stopped`, and the browser continues later.
 *
 * Lines are read HERE, filtered by the caller's own tenant + account + still unmatched (a line
 * booked meanwhile is `skipped`, never planned twice). READ-ONLY: nothing is written to Zoho or the
 * app — booking is the Reconcile sheet's own RPC, row by row, from the browser.
 * R-2419: each row also carries `facts` / `booksStart` (customer-facts.ts) — what the app already has
 * for that customer, so the plan can stop double bookings.
 * Owner / accountant only (as Find in Zoho). Every refusal says what, why and the next step (§24).
 */
import { NextResponse, type NextRequest } from "next/server";
import { NOT_CONFIGURED_MESSAGE, SETTINGS_RETURN, ZOHO_FIND_ROLES, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { dropZohoAccessToken, readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { getContact, isZohoDayLimit, ZohoApiError, type ZohoDayLimitError } from "@/lib/integrations/zoho-books/api";
import {
  findZohoPayment, FX_DATE_WINDOW_DAYS, readZohoPaymentMatch, type RivalLine, type ZohoReadDeps,
} from "@/lib/integrations/zoho-books/payment-match";
import { parseInwardRemittance, REMITTANCE_CODES } from "@/lib/banking/inward-remittance";
import { cachedZohoPayments, findInPaymentList, paymentWindow } from "@/lib/integrations/zoho-books/payment-batch";
import { mapZohoCustomer } from "@/lib/integrations/zoho-books/payment-prefill";
import { BULK_PAGE, zohoContactInfo, type BulkLine, type BulkMatchRow, type ZohoContactInfo } from "@/lib/integrations/zoho-books/bulk-reconcile-plan";
import { createClient } from "@/lib/supabase/server";
import { attachCustomerFacts, FactsReadError } from "./customer-facts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_LINES = 3000;
const PAGE = 1000;
/** R-2658: the company's other foreign receipts read at most (pages of PAGE — the API gives no more per request). */
const MAX_RIVALS = 3000;
/** R-2658: a narration that may carry "<CODE><amount>@<rate>" — PostgREST or-filter over the parser's codes. */
const REMITTANCE_OR = REMITTANCE_CODES.map((c) => `description.ilike.%${c}%@%`).join(",");
const NOT_SURE_CUT = "There are too many bank lines to check that no other line could be this Zoho payment — check which line it belongs to.";

const SETTINGS_NEXT = { label: "Open Settings → Integrations", href: SETTINGS_RETURN };
function fail(status: number, code: string, error: string, why: string, next?: { label: string; href?: string }) {
  return NextResponse.json({ ok: false, code, error, why, ...(next ? { next } : {}) }, { status });
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LineRow = { id: string; txn_date: string; description: string | null; reference: string | null; credit: number | null };
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const caller = await resolveZohoCaller();
  if (!caller) return fail(401, "signed_out", "You are signed out.", "Your session ended.", { label: "Sign in", href: "/login" });
  if (!(ZOHO_FIND_ROLES as readonly string[]).includes(caller.role)) {
    return fail(403, "role", "Only an owner or accountant can reconcile from Zoho Books.",
      "Zoho Books holds the company's sales records.", { label: "Ask the owner to run it", href: "/accounting/banking" });
  }
  const creds = zohoBooksCreds();
  if (!creds) return fail(503, "not_configured", NOT_CONFIGURED_MESSAGE, "This server has no Zoho Books app settings.", SETTINGS_NEXT);

  const body = (await req.json().catch(() => ({}))) as { accountId?: unknown; txnIds?: unknown };
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  if (!UUID_RE.test(accountId)) return fail(400, "bad_request", "No bank account was given.", "The page did not say which account to reconcile.", { label: "Reload the page" });
  const txnIds = Array.isArray(body.txnIds) ? body.txnIds.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)) : null;
  if (txnIds && (txnIds.length === 0 || txnIds.length > BULK_PAGE)) {
    return fail(400, "bad_request", `Send 1 to ${BULK_PAGE} bank lines at a time.`, "The page asked for too many lines at once.", { label: "Reload the page" });
  }

  const conn = await readConnection(caller.admin, caller.tenantId).catch(() => null);
  if (!conn?.refreshToken) return fail(409, "not_connected", "Zoho Books is not connected.", "Reconcile from Zoho reads your Zoho Books payments.", { label: "Connect Zoho Books", href: SETTINGS_RETURN });
  if (!conn.orgId) return fail(409, "no_org", "Choose your Zoho Books organization first.", "The connection has no organization picked yet.", SETTINGS_NEXT);

  /* The account's unmatched money-in lines — own tenant only. */
  const rows: LineRow[] = [];
  for (let from = 0; from < MAX_LINES; from += PAGE) {
    const { data, error } = await caller.admin.from("bank_transactions")
      .select("id, txn_date, description, reference, credit")
      .eq("tenant_id", caller.tenantId).eq("bank_account_id", accountId)
      .is("matched_to_type", null).gt("credit", 0)
      .order("txn_date", { ascending: false }).order("id", { ascending: true })
      .range(from, Math.min(from + PAGE, MAX_LINES) - 1);
    if (error) return fail(500, "read_failed", "Could not read this account's bank lines.", "The database did not answer.", { label: "Reload the page" });
    const page = (data ?? []) as LineRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const lines: BulkLine[] = rows.map((r) => ({
    id: r.id, txnDate: String(r.txn_date).slice(0, 10), credit: Number(r.credit ?? 0), description: r.description, reference: r.reference,
  })).filter((l) => l.credit > 0);

  if (!txnIds) return NextResponse.json({ ok: true, ids: lines.map((l) => l.id), total: lines.length });

  const byId = new Map(lines.map((l) => [l.id, l]));
  const wanted = txnIds.map((id) => byId.get(id)).filter((l): l is BulkLine => !!l);
  const skipped = txnIds.filter((id) => !byId.has(id));
  const win = paymentWindow(lines);
  if (!win || wanted.length === 0) return NextResponse.json({ ok: true, rows: [], skipped, zohoCalls: 0 });

  /* R-2658: every remittance line of the company near the wanted ones — reconciled or not, any
     account — so a Zoho payment another line could be, or has already used, is never a sure pair.
     Read like the lines above: ordered, PAGE at a time (the API returns at most PAGE rows a request),
     only narrations that can be a remittance (never every "@" — UPI handles). FAIL CLOSED: when this
     read, or the account's own lines above, stops at its cap, a rival may be missing — then no pair
     by foreign amount is sure (rivalsCut). */
  let rivals: RivalLine[] = lines;
  let rivalsCut = rows.length >= MAX_LINES;
  const fxWanted = wanted.filter((l) => parseInwardRemittance(l.description)).map((l) => l.txnDate).sort();
  if (fxWanted.length) {
    const others: LineRow[] = [];
    for (let from = 0; from < MAX_RIVALS; from += PAGE) {
      const { data, error } = await caller.admin.from("bank_transactions")
        .select("id, txn_date, description, reference, credit")
        .eq("tenant_id", caller.tenantId).gt("credit", 0).or(REMITTANCE_OR)
        .gte("txn_date", addDays(fxWanted[0], -3 * FX_DATE_WINDOW_DAYS)).lte("txn_date", addDays(fxWanted[fxWanted.length - 1], 3 * FX_DATE_WINDOW_DAYS))
        .order("txn_date", { ascending: false }).order("id", { ascending: true })
        .range(from, Math.min(from + PAGE, MAX_RIVALS) - 1);
      if (error) return fail(500, "read_failed", "Could not read the company's other foreign receipts.", "Without them a foreign receipt could be paired with another line's Zoho payment, so nothing is planned.", { label: "Press Continue to try again" });
      const page = (data ?? []) as LineRow[];
      others.push(...page);
      if (page.length < PAGE) break;
    }
    if (others.length >= MAX_RIVALS) rivalsCut = true;
    const seen = new Set(lines.map((l) => l.id));
    rivals = [...lines, ...others.filter((r) => !seen.has(r.id) && parseInwardRemittance(r.description)).map((r) => ({
      id: r.id, txnDate: String(r.txn_date).slice(0, 10), credit: Number(r.credit ?? 0), description: r.description, reference: r.reference,
    }))];
  }

  /* The tenant's customers, to know whether Zoho's customer needs its contact read. */
  const { data: custData } = await caller.admin.from("customers").select("id, name, gstin").eq("tenant_id", caller.tenantId);
  const appCustomers = (custData ?? []) as Array<{ id: string; name: string; gstin: string | null }>;

  let zohoCalls = 0;
  const counted: typeof fetch = (input, init) => { zohoCalls += 1; return fetch(input, init); };
  let token = await zohoAccessToken(caller, conn.refreshToken, creds);
  const deps = (): ZohoReadDeps => ({ orgId: conn.orgId!, token, fetch: counted });

  const out: BulkMatchRow[] = [];
  const contacts = new Map<string, ZohoContactInfo>();
  const planOne = async (line: BulkLine, payments: Awaited<ReturnType<typeof cachedZohoPayments>>): Promise<BulkMatchRow> => {
    /* R-2658: a Zoho payment another remittance line could be (or already used), or one from a read
       that stopped at its page limit, is paired but never sure (notSure). */
    let found = findInPaymentList(line, payments.payments, rivals, payments.complete);
    if (found.kind === "none" && !payments.complete) {
      const live = await findZohoPayment(line, deps(), rivals);
      found = live.kind === "none" ? { kind: "none" } : live;
    }
    if (found.kind === "one" && found.by === "fx_amount" && !found.notSure && rivalsCut) found = { ...found, notSure: NOT_SURE_CUT };
    if (found.kind === "none") return { line, result: { kind: "none", utrs: [], from: win.from, to: win.to }, contact: null };
    if (found.kind === "several") return { line, result: found, contact: null };
    const match = await readZohoPaymentMatch(found.payment.zohoId, found.by, deps());
    match.notSure = found.notSure ?? null;
    match.matchedAt = new Date().toISOString();
    let contact: ZohoContactInfo | null = null;
    if (match.customer.zohoId && !mapZohoCustomer(match.customer, appCustomers)) {
      contact = contacts.get(match.customer.zohoId) ?? null;
      if (!contact) {
        const raw = await getContact(conn.orgId!, token, match.customer.zohoId, counted);
        contact = zohoContactInfo(raw, match.customer);
        contacts.set(match.customer.zohoId, contact);
      }
    }
    return { line, result: { kind: "match", match }, contact };
  };

  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      /* A cached token Zoho no longer accepts: forget it and try once with a fresh one. */
      if (!(e instanceof ZohoApiError && e.status === 401)) throw e;
      await dropZohoAccessToken(caller);
      token = await zohoAccessToken(caller, conn.refreshToken!, creds);
      return fn();
    }
  };

  /* R-2419: each row carries what the app already has for its customer (open quotes, opening
     invoices, recent receipts, billed periods) — the plan's double-booking checks need it. */
  const answer = async (stopped: boolean, dayLimit?: ZohoDayLimitError) => {
    try {
      const rows = await attachCustomerFacts(out, caller, createClient() as unknown as Parameters<typeof attachCustomerFacts>[2], appCustomers);
      /* R-2661: dayLimit = the app's own day budget is used (no call was made) — the sheet stops at once. */
      const day = dayLimit ? { dayLimit: { calls: dayLimit.day.calls, budget: dayLimit.day.budget, retryAt: dayLimit.day.retryAt, day: dayLimit.day.day } } : {};
      const stop = dayLimit ? { stopped: { code: "day_limit", message: dayLimit.message } } : stopped ? { stopped: { code: "busy", message: "Zoho is busy — waiting a minute, then it carries on." } } : {};
      return NextResponse.json({ ok: true, rows, skipped, zohoCalls, ...stop, ...day });
    } catch (e) {
      const what = e instanceof FactsReadError ? e.message : "the app's records";
      return fail(500, "read_failed", `Could not read ${what} for these customers.`,
        "Without them the plan cannot tell a new sale from a payment already booked, so nothing is planned.", { label: "Press Continue to try again" });
    }
  };

  try {
    const payments = await withRetry(() => cachedZohoPayments(caller.tenantId, win.from, win.to, deps()));
    for (const line of wanted) {
      try {
        out.push(await withRetry(() => planOne(line, payments)));
      } catch (e) {
        if (isZohoDayLimit(e)) return answer(true, e);
        if (e instanceof ZohoApiError && (e.code === "busy" || e.status === 429)) return answer(true);
        throw e;
      }
    }
    return answer(false);
  } catch (e) {
    if (isZohoDayLimit(e)) return answer(true, e);
    if (e instanceof ZohoApiError) {
      if (e.status === 401 || e.code === "reconnect") {
        return fail(502, "reconnect", "Zoho Books did not let ResellerOS read payments.",
          "The Zoho connection has ended, or it was made before payment reading was added (2 Nov 2026).",
          { label: "Disconnect and connect Zoho Books again", href: SETTINGS_RETURN });
      }
      if (e.code === "busy" || e.status === 429) return answer(true);
      return fail(502, "zoho_error", e.message, "Zoho Books answered with an error.", { label: "Press Continue to try again" });
    }
    return fail(502, "zoho_error", "Could not read from Zoho Books.", "The lookup stopped part way.", { label: "Press Continue to try again" });
  }
}
