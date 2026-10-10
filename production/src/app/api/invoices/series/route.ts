/**
 * GET /api/invoices/series — the tenant's document counters, for the pre-action dialogs.
 *
 * Returns the INVOICE counter (for "issue invoice") and the RECEIPT VOUCHER counter (for
 * "record payment" — a receipt voucher is a GST document under CGST Section 31(3)(d) and
 * takes a number from the same gapless machinery, which no screen used to mention).
 *
 * ─── WHY THIS IS A ROUTE AND NOT A CLIENT QUERY ─────────────────────────────
 * `document_series` is not in the generated `Database` type, and adding it is not a
 * two-line fix. Measured 23 Aug 2026: registering that ONE extra table in the Tables map
 * took `npm run typecheck` from **4 errors to 2,722** — supabase-js resolves row types
 * through a large conditional chain, and a Database type this size tips over the
 * instantiation limit and collapses every table to `never`. So the table stays
 * unregistered and the one query that needs it lives here, against a deliberately
 * UNTYPED client, in a file short enough to read in full.
 *
 * Tenant comes from the SESSION, never from the caller. With no generated types nothing
 * checks the filter, so the explicit `.eq("tenant_id", …)` is the entire boundary between
 * one tenant's counters and another's — which is why it sits on the line below and says
 * so.
 *
 * READ-ONLY, and that is the point: `next_document_number()` is the sole allocator
 * (CLAUDE.md §17a). This reads `last_number` to PREDICT the next value and never writes,
 * which is why the dialogs call the number a prediction rather than a promise.
 */
import { NextResponse } from "next/server";
import { createClient as createSessionClient } from "@/lib/supabase/server";
import { createBareClient } from "@/lib/supabase/bare";
import { effectiveDocCode, type SeriesState } from "@/lib/actions/consequence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SeriesRow {
  doc_type: string;
  prefix: string;
  fiscal_year: string;
  last_number: number;
}

export async function GET() {
  const supabase = createSessionClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  /* Typed path — `users` and `tenants` ARE in the generated types. */
  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const tenantId = (me as { tenant_id?: string | null } | null)?.tenant_id ?? null;
  if (!tenantId) return NextResponse.json({ error: "No tenant on your account." }, { status: 403 });

  const { data: tenant } = await supabase
    .from("tenants").select("doc_code").eq("id", tenantId).maybeSingle();
  /* The code the SQL allocator will print — with its tenant-id fallback when doc_code is
     empty (R-095). Passing the raw NULL dropped "FBB9" from the predicted number. */
  const docCode = effectiveDocCode((tenant as { doc_code?: string | null } | null)?.doc_code, tenantId);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ error: "Supabase is not configured on the server." }, { status: 500 });
  }
  const bare = createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });

  const { data, error } = await bare
    .from("document_series")
    .select("doc_type, prefix, fiscal_year, last_number")
    .eq("tenant_id", tenantId)      // <- the only tenant boundary on this query
    .in("doc_type", ["invoice", "receipt_voucher"])
    .order("fiscal_year", { ascending: false });

  if (error) {
    /* Reported, not swallowed. Without this the dialog would quietly say "this opens the
       series" for a tenant already at 32 — a reassuring sentence built on a failure. */
    console.error(`[api/invoices/series] tenant ${tenantId}: ${error.message}`);
    return NextResponse.json({ error: "Could not read the document series." }, { status: 500 });
  }

  const rows = (data ?? []) as SeriesRow[];
  /* Newest fiscal year first from the ORDER BY, so the first row per doc_type is the
     current one. */
  const pick = (docType: string) => rows.find((r) => r.doc_type === docType) ?? null;

  /* The counts the gap check compares against: invoices for the invoice series, payments
     for the receipt-voucher series. Both tenant-scoped, for the same reason as above. */
  const [{ count: invoiceCount }, { count: paymentCount }] = await Promise.all([
    bare.from("invoices").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    bare.from("payments").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);

  /* Null when there is no row: that means the first document of this financial year, and
     the consequence modules say so rather than predicting 0001 as though they had read
     it. */
  const shape = (r: SeriesRow | null, documentCount: number): SeriesState | null =>
    r ? { prefix: r.prefix, docCode, fiscalYear: r.fiscal_year, lastNumber: r.last_number, documentCount } : null;

  return NextResponse.json({
    invoice: shape(pick("invoice"), invoiceCount ?? 0),
    receiptVoucher: shape(pick("receipt_voucher"), paymentCount ?? 0),
  });
}
