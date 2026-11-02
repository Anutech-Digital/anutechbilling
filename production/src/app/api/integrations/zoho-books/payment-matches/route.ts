/**
 * POST /api/integrations/zoho-books/payment-matches — R-2360 Banking "Zoho has a match".
 *
 * Body: { accountId }. The account's UNMATCHED money-in lines are read HERE, filtered by the
 * caller's own tenant; the tenant's own Zoho Books payments of those lines' date window are read
 * ONCE (cached 30 min per company + window — lib/integrations/zoho-books/payment-batch.ts) and the
 * lines are matched in memory with R-2359's rules. Read-only: nothing is written anywhere.
 *
 * Owner / accountant only (same as "Find in Zoho"). Not connected → { ok: false, code:
 * "not_connected" } without calling Zoho; the Banking page then shows no Zoho filter at all.
 */
import { NextResponse, type NextRequest } from "next/server";
import { ZOHO_FIND_ROLES, zohoBooksCreds } from "@/lib/integrations/zoho-books/config";
import { dropZohoAccessToken, readConnection, resolveZohoCaller, zohoAccessToken } from "@/lib/integrations/zoho-books/store";
import { ZohoApiError } from "@/lib/integrations/zoho-books/api";
import { countZohoMatches, type BatchLine } from "@/lib/integrations/zoho-books/payment-batch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Unmatched money-in lines looked at, at most (newest first). */
const MAX_LINES = 3000;
const PAGE = 1000;

function fail(status: number, code: string, error: string) {
  return NextResponse.json({ ok: false, code, error }, { status });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LineRow = { id: string; txn_date: string; description: string | null; reference: string | null; credit: number | null };

export async function POST(req: NextRequest) {
  const caller = await resolveZohoCaller();
  if (!caller) return fail(401, "signed_out", "You are signed out.");
  if (!(ZOHO_FIND_ROLES as readonly string[]).includes(caller.role)) {
    return fail(403, "role", "Only an owner or accountant can look up Zoho Books payments.");
  }
  if (!zohoBooksCreds()) return fail(409, "not_configured", "Zoho Books is not set up on this server.");

  const body = (await req.json().catch(() => ({}))) as { accountId?: unknown };
  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  if (!UUID_RE.test(accountId)) return fail(400, "bad_request", "No bank account was given.");

  const conn = await readConnection(caller.admin, caller.tenantId).catch(() => null);
  if (!conn?.refreshToken) return fail(409, "not_connected", "Zoho Books is not connected.");
  if (!conn.orgId) return fail(409, "no_org", "Choose your Zoho Books organization first.");

  const rows: LineRow[] = [];
  for (let from = 0; from < MAX_LINES; from += PAGE) {
    const { data, error } = await caller.admin.from("bank_transactions")
      .select("id, txn_date, description, reference, credit")
      .eq("tenant_id", caller.tenantId).eq("bank_account_id", accountId)
      .is("matched_to_type", null).gt("credit", 0)
      .order("txn_date", { ascending: false }).order("id", { ascending: true })
      .range(from, Math.min(from + PAGE, MAX_LINES) - 1);
    if (error) return fail(500, "read_failed", "Could not read this account's bank lines. Refresh the page.");
    const page = (data ?? []) as LineRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  const lines: BatchLine[] = rows.map((r) => ({
    id: r.id, txnDate: String(r.txn_date).slice(0, 10), credit: Number(r.credit ?? 0), description: r.description, reference: r.reference,
  }));

  const creds = zohoBooksCreds()!;
  const run = async () => countZohoMatches(caller.tenantId, lines,
    { orgId: conn.orgId!, token: await zohoAccessToken(caller, conn.refreshToken!, creds) });
  try {
    let result;
    try {
      result = await run();
    } catch (e) {
      if (!(e instanceof ZohoApiError && e.status === 401)) throw e;
      await dropZohoAccessToken(caller);
      result = await run();
    }
    return NextResponse.json({ ok: true, result });
  } catch (e) {
    if (e instanceof ZohoApiError) {
      if (e.status === 401 || e.code === "reconnect") return fail(502, "reconnect", "Zoho Books did not let ResellerOS read payments — disconnect and connect it again.");
      if (e.code === "busy" || e.status === 429) return fail(503, "busy", "Zoho is busy right now — try again in a minute.");
    }
    return fail(502, "zoho_error", "Could not read from Zoho Books.");
  }
}
