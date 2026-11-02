/**
 * POST /api/integrations/zoho-books/payment-match — R-2359 "Find in Zoho" on a money-in bank line.
 *
 * Body: { transactionId, paymentId? }. The bank line is read HERE, filtered by the caller's own
 * tenant (never an amount / date / UTR from the browser); then the tenant's own Zoho Books
 * organization is searched READ-ONLY (lib/integrations/zoho-books/payment-match.ts). Nothing is
 * written — not to Zoho, not to the app. The Reconcile sheet pre-fills its existing sale form
 * from the answer and books only when the owner presses Save.
 *
 * Owner / accountant only. Every refusal says what happened, why, and the next step (§24).
 */
import { NextResponse, type NextRequest } from "next/server";
import { NOT_CONFIGURED_MESSAGE, SETTINGS_RETURN, ZOHO_FIND_ROLES, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { dropZohoAccessToken, readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { ZohoApiError } from "@/lib/integrations/zoho-books/api";
import { findInZoho, type BankCreditLine } from "@/lib/integrations/zoho-books/payment-match";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const SETTINGS_NEXT = { label: "Open Settings → Integrations", href: SETTINGS_RETURN };

function fail(status: number, code: string, error: string, why: string, next?: { label: string; href?: string }) {
  return NextResponse.json({ ok: false, code, error, why, ...(next ? { next } : {}) }, { status });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const caller = await resolveZohoCaller();
  if (!caller) return fail(401, "signed_out", "You are signed out.", "Your session ended.", { label: "Sign in", href: "/login" });
  if (!(ZOHO_FIND_ROLES as readonly string[]).includes(caller.role)) {
    return fail(403, "role", "Only an owner or accountant can look up Zoho Books payments.",
      "Zoho Books holds the company's sales records.", { label: "Ask the owner to reconcile this line", href: "/accounting/banking" });
  }
  const creds = zohoBooksCreds();
  if (!creds) return fail(503, "not_configured", NOT_CONFIGURED_MESSAGE, "This server has no Zoho Books app settings.", SETTINGS_NEXT);

  const body = (await req.json().catch(() => ({}))) as { transactionId?: unknown; paymentId?: unknown };
  const transactionId = typeof body.transactionId === "string" ? body.transactionId : "";
  const paymentId = typeof body.paymentId === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(body.paymentId) ? body.paymentId : null;
  if (!UUID_RE.test(transactionId)) return fail(400, "bad_request", "No bank line was given.", "The sheet did not send which line to look up.", { label: "Close and open the line again", href: "/accounting/banking" });

  const { data: row, error: rowErr } = await caller.admin.from("bank_transactions")
    .select("id, tenant_id, txn_date, description, reference, credit")
    .eq("id", transactionId).eq("tenant_id", caller.tenantId).maybeSingle();
  const txn = row as { tenant_id: string; txn_date: string; description: string | null; reference: string | null; credit: number | null } | null;
  if (rowErr || !txn || txn.tenant_id !== caller.tenantId) {
    return fail(404, "no_line", "This bank line was not found.", "It may have been removed by a statement re-import.", { label: "Back to Banking", href: "/accounting/banking" });
  }
  const credit = Number(txn.credit ?? 0);
  if (!(credit > 0)) return fail(400, "not_credit", "Find in Zoho works on money-in lines only.", "This line is a payment out.", { label: "Back to Banking", href: "/accounting/banking" });

  const conn = await readConnection(caller.admin, caller.tenantId).catch(() => null);
  if (!conn?.refreshToken) {
    return fail(409, "not_connected", "Zoho Books is not connected.", "Find in Zoho reads your Zoho Books payments.", { label: "Connect Zoho Books", href: SETTINGS_RETURN });
  }
  if (!conn.orgId) {
    return fail(409, "no_org", "Choose your Zoho Books organization first.", "The connection has no organization picked yet.", SETTINGS_NEXT);
  }

  const line: BankCreditLine = { txnDate: String(txn.txn_date).slice(0, 10), credit, description: txn.description, reference: txn.reference };
  const run = async () => findInZoho(line, { orgId: conn.orgId!, token: await zohoAccessToken(caller, conn.refreshToken!, creds) }, paymentId);
  try {
    let result;
    try {
      result = await run();
    } catch (e) {
      /* A cached token Zoho no longer accepts: forget it and try once with a fresh one. */
      if (!(e instanceof ZohoApiError && e.status === 401)) throw e;
      await dropZohoAccessToken(caller);
      result = await run();
    }
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof ZohoApiError) {
      if (e.status === 401 || e.code === "reconnect") {
        return fail(502, "reconnect", "Zoho Books did not let ResellerOS read payments.",
          "The Zoho connection has ended, or it was made before payment reading was added (2 Nov 2026).",
          { label: "Disconnect and connect Zoho Books again", href: SETTINGS_RETURN });
      }
      if (e.code === "busy" || e.status === 429) {
        return fail(503, "busy", "Zoho is busy right now.", "Zoho limits how often it can be asked.", { label: "Wait a minute, then try again" });
      }
      return fail(502, "zoho_error", e.message, "Zoho Books answered with an error.", { label: "Try again" });
    }
    return fail(502, "zoho_error", "Could not read from Zoho Books.", "The lookup stopped part way.", { label: "Try again" });
  }
}
