/**
 * GET /api/integrations/zoho-books/day-calls — R-2661: how many Zoho Books API calls the signed-in
 * user's company has made today (IST), the day budget (ZOHO_DAY_BUDGET, default 900 of Zoho's
 * ~1,000), whether Zoho itself refused for the day, and when reading carries on (the next midnight
 * IST, ms). Shown as "Zoho calls today: N of 900" on the Zoho read dialogs.
 *
 * Own company only: the tenant is the caller's own `users` row (never from the request); the row
 * is read with the admin client filtered by that tenant. Any signed-in member may see it (a count,
 * nothing from Zoho). Nothing is written; Zoho is not called.
 */
import { NextResponse } from "next/server";
import { readDayCalls } from "@/lib/integrations/zoho-books/day-calls-store";
import { resolveZohoCaller } from "@/lib/integrations/zoho-books/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const caller = await resolveZohoCaller();
  if (!caller) return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  try {
    const s = await readDayCalls(caller.admin, caller.tenantId);
    return NextResponse.json({ ok: true, day: s.day, calls: s.calls, budget: s.budget, limitHitAt: s.limitHitAt, spent: s.spent, retryAt: s.retryAt });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not read today's Zoho call count." }, { status: 500 });
  }
}
