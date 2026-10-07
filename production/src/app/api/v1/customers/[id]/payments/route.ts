/**
 * GET /api/v1/customers/{billing_customer_id}/payments
 * Payments / transactions for a customer. API-key auth, tenant-scoped.
 *
 * Payments link to a quote, not directly to an invoice, so we derive invoice_id
 * by joining through the payment's quote_id → invoices.quote_id.
 */
import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api-keys/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveCustomer } from "@/lib/api/v1-customer";
import { mapPayment } from "@/lib/api/v1-mappers";
import { unauthorized, notFound, serverError, requireScope } from "@/lib/api/v1-response";
import type { Payment as PaymentRow } from "@/lib/supabase/database.types";

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
    .from("payments")
    .select("*")
    .eq("tenant_id", auth.tenantId)
    .eq("customer_id", customer.id)
    .eq("status", "received")
    .order("received_at", { ascending: false });
  if (error) return serverError("Could not load payments just now. Try again in a minute.");

  const payments = (data as PaymentRow[]) ?? [];

  // Derive invoice_id per payment via its quote_id.
  const quoteIds = Array.from(new Set(payments.map((p) => p.quote_id).filter(Boolean)));
  const quoteToInvoice = new Map<string, string>();
  if (quoteIds.length > 0) {
    const { data: invs } = await admin
      .from("invoices")
      .select("id, quote_id")
      .eq("tenant_id", auth.tenantId)
      .in("quote_id", quoteIds as string[]);
    for (const inv of invs ?? []) {
      if (inv.quote_id) quoteToInvoice.set(inv.quote_id, inv.id);
    }
  }

  return NextResponse.json(
    payments.map((p) => mapPayment(p, quoteToInvoice.get(p.quote_id) ?? null)),
  );
}
