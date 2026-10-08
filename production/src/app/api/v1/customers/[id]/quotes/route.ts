/**
 * GET /api/v1/customers/{billing_customer_id}/quotes
 * Quotes / pending payments for a customer. API-key auth, tenant-scoped.
 *
 * Each quote carries `renews`: the services (vendor + domain) whose subscription it renews,
 * [] for a quote that renews nothing (28 Sep 2026, so DMS can match a renewal bill to the
 * hosting account or domain being renewed instead of offering every pending bill).
 */
import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api-keys/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveCustomer } from "@/lib/api/v1-customer";
import { mapQuote, type V1QuoteRenews } from "@/lib/api/v1-mappers";
import { pdfDownloadUrl } from "@/lib/pdf/pdf-token";
import { unauthorized, notFound, requestBaseUrl, serverError, requireScope } from "@/lib/api/v1-response";
import type { Quote as QuoteRow } from "@/lib/supabase/database.types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await authenticateApiKey(req);
  if (!auth) return unauthorized();
  const denied = requireScope(auth, "read");
  if (denied) return denied;

  const admin = createAdminClient();
  const customer = await resolveCustomer(admin, auth.tenantId, params.id);
  if (!customer) return notFound("Customer not found");

  const { data, error } = await admin
    .from("quotes")
    .select("*")
    .eq("tenant_id", auth.tenantId)
    .eq("customer_id", customer.id)
    .order("created_date", { ascending: false });
  if (error) return serverError("Could not load quotes just now. Try again in a minute.");
  const quotes = data as QuoteRow[];

  // Which subscriptions each quote renews. A failed read fails the whole answer: a list
  // without `renews` would read as "renews nothing" and hide a customer's renewal bill.
  const renewsByQuote = new Map<string, V1QuoteRenews[]>();
  if (quotes.length) {
    const { data: subs, error: sErr } = await admin
      .from("subscriptions")
      .select("renewal_quote_id, vendor, domain")
      .eq("tenant_id", auth.tenantId)
      .in("renewal_quote_id", quotes.map((q) => q.id));
    if (sErr) return serverError("Could not load quotes just now. Try again in a minute.");
    for (const s of subs ?? []) {
      if (!s.renewal_quote_id) continue;
      const list = renewsByQuote.get(s.renewal_quote_id) ?? [];
      list.push({ vendor: String(s.vendor ?? ""), domain: s.domain ?? null });
      renewsByQuote.set(s.renewal_quote_id, list);
    }
  }

  const base = requestBaseUrl(req);
  return NextResponse.json(
    quotes.map((q) =>
      mapQuote(q, base, pdfDownloadUrl(base, "quote", q.id, auth.tenantId), renewsByQuote.get(q.id) ?? []),
    ),
  );
}
