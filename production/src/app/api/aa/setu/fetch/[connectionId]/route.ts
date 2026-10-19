/**
 * POST /api/aa/setu/fetch/[connectionId]
 *
 * Pulls fresh FI Data from Setu for an ACTIVE AA connection, maps each
 * transaction into bank_transactions, dedupes by (date+amount+reference),
 * and inserts only new rows. Updates last_fetch_at / last_fetch_count on
 * the connection row. Returns { inserted, skipped_existing }.
 */
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/with-route";
import { MONEY_RECORD_ROLES } from "@/lib/auth/roles";
import { requestFiData, fetchFiData } from "@/lib/aa/setu";
import { refuseWithoutMfa } from "@/lib/aa/require-mfa";

export const runtime = "nodejs";

/* R-732: a bank-statement pull is a money action — the roles that may record money (R-718).
   Before this the route did not even check for a sign-in; RLS alone bounded it. */
export const POST = withRoute({
  route: "api/aa/setu/fetch/[connectionId]",
  roles: MONEY_RECORD_ROLES,
  roleHint: "Bank fetch sirf owner / manager / accountant / billing kar sakte hain.",
}, async ({ supabase, params, tenantId }) => {
  /* R-879: bank statements need the second sign-in step too (lib/aa/require-mfa.ts). */
  const mfa = await refuseWithoutMfa(supabase);
  if (mfa) return mfa;

  const connectionId = params.connectionId;

  /* R-879: tenant filter stated, not left to RLS alone. */
  const { data: conn, error: connErr } = await supabase
    .from("bank_aa_connections")
    .select("*")
    .eq("id", connectionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (connErr || !conn) {
    return NextResponse.json(
      { ok: false, error: "Ye bank connection is workspace mein nahi mila — Banking page refresh karke dobara 'Fetch' dabaiye." },
      { status: 404 },
    );
  }
  if (conn.status !== "active") {
    return NextResponse.json({ error: `Connection status is ${conn.status} — must be active` }, { status: 400 });
  }

  // Request + fetch
  const today    = new Date().toISOString().slice(0, 10);
  const fromDate: string = conn.last_fetch_at
    ? new Date(conn.last_fetch_at).toISOString().slice(0, 10)
    : (conn.fetch_window_from ?? today);

  const session = await requestFiData({
    consent_id:  conn.consent_id ?? "",
    account_ref: conn.linked_account_ref ?? "",
    from_date:   fromDate,
    to_date:     today,
  });
  const fiData = await fetchFiData(session.session_id);

  if (fiData.status !== "READY") {
    await supabase
      .from("bank_aa_connections")
      .update({
        last_fetch_at:     new Date().toISOString(),
        last_fetch_status: fiData.status.toLowerCase(),
        last_fetch_count:  0,
      })
      .eq("id", conn.id);
    return NextResponse.json({ inserted: 0, status: fiData.status });
  }

  // Dedupe against existing rows: compare (txn_date, debit, credit, reference)
  // for this bank account. Bank statements + AA pulls overlap so this matters.
  const { data: existing } = await supabase
    .from("bank_transactions")
    .select("txn_date, debit, credit, reference")
    .eq("bank_account_id", conn.bank_account_id);
  const seen = new Set(
    (existing ?? []).map((r) => `${r.txn_date}|${r.debit}|${r.credit}|${r.reference ?? ""}`),
  );

  const rows = fiData.transactions
    .map((t) => ({
      tenant_id:       conn.tenant_id,
      bank_account_id: conn.bank_account_id,
      txn_date:        t.date,
      description:     t.narration,
      debit:           t.type === "DEBIT"  ? Math.round(t.amount) : 0,
      credit:          t.type === "CREDIT" ? Math.round(t.amount) : 0,
      balance_after:   t.balance_after ?? null,
      reference:       t.reference,
      source:          "api_fetch" as const,
    }))
    .filter((r) => !seen.has(`${r.txn_date}|${r.debit}|${r.credit}|${r.reference ?? ""}`));

  let inserted = 0;
  if (rows.length > 0) {
    const { error: insErr, data: ins } = await supabase
      .from("bank_transactions")
      .insert(rows)
      .select("id");
    if (insErr) {
      return NextResponse.json({ error: `Insert failed: ${insErr.message}` }, { status: 500 });
    }
    inserted = ins?.length ?? 0;
  }

  await supabase
    .from("bank_aa_connections")
    .update({
      last_fetch_at:     new Date().toISOString(),
      last_fetch_status: "ok",
      last_fetch_count:  inserted,
    })
    .eq("id", conn.id);

  return NextResponse.json({
    inserted,
    skipped_existing: fiData.transactions.length - inserted,
    total_in_window:  fiData.transactions.length,
  });
});
