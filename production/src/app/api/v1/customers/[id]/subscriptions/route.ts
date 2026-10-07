/**
 * GET /api/v1/customers/{billing_customer_id}/subscriptions
 * Subscriptions/plans for a customer. API-key auth, tenant-scoped.
 */
import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api-keys/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveCustomer } from "@/lib/api/v1-customer";
import { mapSubscription } from "@/lib/api/v1-mappers";
import { unauthorized, notFound, serverError, requireScope } from "@/lib/api/v1-response";
import type { Subscription as SubscriptionRow } from "@/lib/supabase/database.types";

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
    .from("subscriptions")
    .select("*")
    .eq("tenant_id", auth.tenantId)
    .eq("customer_id", customer.id)
    .order("start_date", { ascending: false });
  if (error) return serverError("Could not load subscriptions just now. Try again in a minute.");

  return NextResponse.json((data as SubscriptionRow[]).map(mapSubscription));
}
