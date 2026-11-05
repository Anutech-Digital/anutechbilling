/**
 * POST /api/integrations/zoho-books/purchase-import — R-2502 (G-FY2526): a financial year's Zoho
 * Books bills, expenses and vendor payments into the app's expenses, COGS bills and payments (ITC,
 * RCM, TDS by section). OWNER / ACCOUNTANT only (the SQL checks the same roles). Built on R-2499's
 * generic FY framework (fy-import/: scan, store, parts).
 *
 * Body { action, fy: "2025-26", … }:
 *   read     { kind } → reads the next piece of one Zoho list (bills / expenses / vendorpayments) into
 *              the server's scan; READ only; at most FY_CALLS_PER_REQUEST Zoho calls a request — call
 *              again until `complete`. Counts come from the stored rows.
 *   restart  { kind } → forgets that list's scan.
 *   preview  → from the COMPLETE bills + expenses scans: counts, skip reasons, Zoho vs to-import vs
 *              already-in-the-app per month (ITC, RCM, TDS), TDS by section, unmapped Zoho accounts,
 *              the category choices, bank accounts; and (when that scan is complete) the vendor
 *              payments plan. Nothing written.
 *   saveMap  { rows: [{ zohoAccountId, zohoAccountName, category }] } → save_zoho_account_categories.
 *   import   { kind, part, dryRun } → one part through import_zoho_fy_purchases (bills /
 *              expenses) or import_zoho_fy_vendor_payments; dryRun true (default) writes nothing.
 *              Picks name only Zoho ids + the matched vendor — every amount comes from the scan.
 *              Vendor payments make NO bank line (R-2502b): expense bills are marked paid, COGS-bill
 *              payments are listed (payments.cogs) to pay in Reconcile on the real 4523 debit.
 *   undo     { batchId, reason } → remove_zoho_fy_purchase_import (while untouched).
 * Zoho is never written to.
 */
import { NextResponse, type NextRequest } from "next/server";
import { NOT_CONFIGURED_MESSAGE, FY_CALLS_PER_REQUEST, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { dropZohoAccessToken, readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { ZohoApiError } from "@/lib/integrations/zoho-books/api";
import { fyDateRange, type ZohoFyDocDetail } from "@/lib/integrations/zoho-books/fy-fetch";
import type { PaceEntry } from "@/lib/integrations/zoho-books/zoho-pace";
import { scanStep, type ScanFacts } from "@/lib/integrations/zoho-books/fy-import/scan";
import { partCount, partOf } from "@/lib/integrations/zoho-books/fy-import/parts";
import { readImportBatches, readScannedFacts, supabaseScanStore, type FyImportDb } from "@/lib/integrations/zoho-books/fy-import/store";
import { zohoPurchaseFacts, zohoVendorPaymentFacts, type PurchaseFacts, type VendorPaymentFacts } from "@/lib/integrations/zoho-books/purchase-import/normalise";
import {
  CATEGORY_CHOICES, PURCHASE_IMPORT_ROLES, buildPaymentPlan, buildPurchasePlan, toPurchasePick,
} from "@/lib/integrations/zoho-books/purchase-import/plan";
import {
  readAppPurchasesByMonth, readPaymentContext, readPurchaseContext,
} from "@/lib/integrations/zoho-books/purchase-import/store";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const KINDS = ["bills", "expenses", "vendorpayments"] as const;
type Kind = (typeof KINDS)[number];
const ROLE_MSG = "Only the owner or an accountant can import FY purchases from Zoho.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}
const isKind = (k: unknown): k is Kind => typeof k === "string" && (KINDS as readonly string[]).includes(k);
const toFacts = (kind: Kind) => (d: ZohoFyDocDetail): ScanFacts => (kind === "vendorpayments" ? zohoVendorPaymentFacts(d) : zohoPurchaseFacts(d));

export async function POST(req: NextRequest) {
  const caller = await resolveZohoCaller();
  if (!caller) return fail(401, "Not signed in.");
  if (!(PURCHASE_IMPORT_ROLES as readonly string[]).includes(caller.role)) return fail(403, ROLE_MSG);

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === "string" ? body.action : "";
  const fy = typeof body.fy === "string" ? body.fy : "";
  let range;
  try { range = fyDateRange(fy); } catch { return fail(400, "Choose a financial year like 2025-26."); }
  const db = caller.admin as unknown as FyImportDb;
  const storeOf = (k: Kind) => supabaseScanStore<ScanFacts>(db, caller.tenantId, k);
  const rpc = async (fn: string, args: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (createClient() as any).rpc(fn, args) as Promise<{ data: unknown; error: { message?: string } | null }>;

  if (action === "restart") {
    if (!isKind(body.kind)) return fail(400, "Choose bills, expenses or vendor payments.");
    try { await storeOf(body.kind).reset(fy); } catch { return fail(500, "Could not clear the Zoho read. Try again."); }
    return NextResponse.json({ ok: true, fy, kind: body.kind, listed: 0, detailed: 0, complete: false });
  }

  if (action === "read") {
    if (!isKind(body.kind)) return fail(400, "Choose bills, expenses or vendor payments.");
    const kind = body.kind;
    const creds = zohoBooksCreds();
    if (!creds) return fail(503, NOT_CONFIGURED_MESSAGE);
    let conn;
    try { conn = await readConnection(caller.admin, caller.tenantId); }
    catch { return fail(500, "Could not read the Zoho Books connection. Refresh the page."); }
    if (!conn.refreshToken) return fail(409, "Zoho Books is not connected. Settings → Integrations → Zoho Books → Connect.");
    if (!conn.orgId) return fail(409, "Choose your Zoho Books organization first.");
    const history: PaceEntry[] = [];
    const used = () => history.reduce((s, h) => s + h.calls, 0);
    try {
      const run = async () => scanStep(storeOf(kind), kind, toFacts(kind), conn.orgId!, await zohoAccessToken(caller, conn.refreshToken!, creds), fy,
        { history, maxCalls: Math.max(1, FY_CALLS_PER_REQUEST - used()) });
      let result;
      try { result = await run(); } catch (e) {
        if (!(e instanceof ZohoApiError && e.status === 401)) throw e;
        await dropZohoAccessToken(caller);
        result = await run();
      }
      return NextResponse.json({ ok: true, fy, kind, ...result, calls: used() });
    } catch (e) {
      if (e instanceof ZohoApiError) {
        if (e.status === 401 || e.code === "reconnect" || e.code === "books_57") return fail(502, "Zoho Books did not let ResellerOS read — Settings → Integrations → Zoho Books → Reconnect, then Allow.");
        return fail(502, e.message);
      }
      return fail(502, "Could not read from Zoho Books. Try again.");
    }
  }

  if (action === "saveMap") {
    const rows = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : null;
    if (!rows || rows.length === 0 || rows.length > 500) return fail(400, "Send the accounts to map.");
    const out = [];
    for (const r of rows) {
      const id = typeof r.zohoAccountId === "string" ? r.zohoAccountId.trim() : "";
      const category = typeof r.category === "string" ? r.category.trim() : "";
      if (!id || id.length > 40) return fail(400, "A Zoho account is missing.");
      if (category && !CATEGORY_CHOICES.includes(category)) return fail(400, `"${category}" is not a category you can map to.`);
      out.push({ zoho_account_id: id, zoho_account_name: typeof r.zohoAccountName === "string" ? r.zohoAccountName.slice(0, 200) : "", category });
    }
    const { data, error } = await rpc("save_zoho_account_categories", { p_rows: out });
    if (error) return fail(400, error.message ?? "The map was not saved.");
    return NextResponse.json({ ok: true, result: data });
  }

  /** Is a list read completely (counted on the server)? */
  const complete = async (k: Kind) => {
    const s = storeOf(k);
    const [c, run] = await Promise.all([s.counts(fy), s.readRun(fy)]);
    return { done: Boolean(run?.listDone) && c.detailed >= c.listed, listed: c.listed };
  };

  const purchasePlan = async () => {
    const [b, e] = await Promise.all([complete("bills"), complete("expenses")]);
    if (!b.done || !e.done || b.listed + e.listed === 0) return null;
    const [bills, exps, ctx] = await Promise.all([
      readScannedFacts<PurchaseFacts>(db, caller.tenantId, "bills", fy),
      readScannedFacts<PurchaseFacts>(db, caller.tenantId, "expenses", fy),
      readPurchaseContext(db, caller.tenantId, range),
    ]);
    return buildPurchasePlan([...bills, ...exps], ctx);
  };
  const paymentPlan = async () => {
    const p = await complete("vendorpayments");
    if (!p.done || p.listed === 0) return null;
    const [facts, ctx] = await Promise.all([
      readScannedFacts<VendorPaymentFacts>(db, caller.tenantId, "vendorpayments", fy),
      readPaymentContext(db, caller.tenantId, range),
    ]);
    return buildPaymentPlan(facts, ctx);
  };

  if (action === "preview") {
    let plan, pays, appByMonth, batches;
    try {
      [plan, pays] = await Promise.all([purchasePlan(), paymentPlan()]);
      if (!plan) return fail(409, "Read bills and expenses from Zoho first (Read from Zoho) — it is not complete yet.");
      [appByMonth, batches] = await Promise.all([
        readAppPurchasesByMonth(db, caller.tenantId, range),
        Promise.all(KINDS.map((k) => readImportBatches(db, caller.tenantId, k, fy).then((rows) => rows.map((x) => ({ ...x, kind: k }))))).then((a) => a.flat()),
      ]);
    } catch { return fail(500, "Could not build the preview. Refresh and try again."); }
    const parts = (k: Kind) => partCount(plan.rows.filter((r) => r.verdict !== "skip" && r.facts.kind === k).length);
    return NextResponse.json({
      ok: true, fy,
      purchases: {
        counts: plan.counts, parts: { bills: parts("bills"), expenses: parts("expenses") },
        zohoByMonth: plan.zohoByMonth, importByMonth: plan.importByMonth, appByMonth,
        skipReasons: plan.skipReasons, tdsBySection: plan.tdsBySection, unmapped: plan.unmapped,
        skipped: plan.rows.filter((r) => r.verdict === "skip").slice(0, 500).map((r) => ({
          kind: r.facts.kind, number: r.facts.number, date: r.facts.date, vendor: r.facts.vendorName, amount: r.facts.total, reason: r.reason })),
      },
      payments: pays && {
        counts: pays.counts, parts: partCount(pays.rows.filter((r) => r.verdict !== "skip").length),
        paidThrough: pays.paidThrough, skipReasons: pays.skipReasons, cogs: pays.cogs.slice(0, 500),
      },
      categories: CATEGORY_CHOICES, batches,
    });
  }

  if (action === "import") {
    if (!isKind(body.kind)) return fail(400, "Choose bills, expenses or vendor payments.");
    const kind = body.kind;
    const dryRun = body.dryRun !== false;
    if (kind === "vendorpayments") {
      let pays;
      try { pays = await paymentPlan(); }
      catch { return fail(500, "Could not build the preview. Refresh and try again."); }
      if (!pays) return fail(409, "Read vendor payments from Zoho first — it is not complete yet.");
      /* R-2502b: Zoho ids only — no bank account, no manual bank line (COGS bills are paid in Reconcile). */
      const picks = pays.rows.filter((r) => r.verdict !== "skip").map((r) => ({ zoho_id: r.facts.zohoId }));
      if (!picks.length) return fail(409, "Nothing to import.");
      const part = Number(body.part ?? 0);
      const slice = partOf(picks, part);
      if (!slice) return fail(400, "That part does not exist. Preview again.");
      const { data, error } = await rpc("import_zoho_fy_vendor_payments", { p_fy: fy, p_picks: slice, p_dry_run: dryRun });
      if (error) return fail(400, error.message ?? "The import was refused.");
      return NextResponse.json({ ok: true, fy, kind, part, parts: partCount(picks.length), result: data });
    }
    let plan;
    try { plan = await purchasePlan(); } catch { return fail(500, "Could not build the preview. Refresh and try again."); }
    if (!plan) return fail(409, "Read bills and expenses from Zoho first (Read from Zoho) — it is not complete yet.");
    /* Import + already, in the scan's stable order: part N is the same documents on every call. */
    const picks = plan.rows.filter((r) => r.verdict !== "skip" && r.facts.kind === kind).map(toPurchasePick);
    if (!picks.length) return fail(409, "Nothing to import.");
    const part = Number(body.part ?? 0);
    const slice = partOf(picks, part);
    if (!slice) return fail(400, "That part does not exist. Preview again.");
    const { data, error } = await rpc("import_zoho_fy_purchases", { p_kind: kind, p_fy: fy, p_picks: slice, p_dry_run: dryRun });
    if (error) return fail(400, error.message ?? "The import was refused.");
    return NextResponse.json({ ok: true, fy, kind, part, parts: partCount(picks.length), result: data });
  }

  if (action === "undo") {
    const batchId = typeof body.batchId === "string" ? body.batchId : "";
    if (!UUID.test(batchId)) return fail(400, "Choose an import to remove.");
    const { data, error } = await rpc("remove_zoho_fy_purchase_import", { p_batch_id: batchId, p_reason: String(body.reason ?? "") });
    if (error) return fail(400, error.message ?? "The import could not be removed.");
    return NextResponse.json({ ok: true, result: data });
  }

  return fail(400, "Unknown action.");
}
