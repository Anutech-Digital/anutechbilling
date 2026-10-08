/**
 * GET /api/v1/customers/{billing_customer_id}
 * Customer lookup for the DSP integration. API-key auth, tenant-scoped.
 */
import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/api-keys/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveCustomer } from "@/lib/api/v1-customer";
import { mapCustomer } from "@/lib/api/v1-mappers";
import { unauthorized, notFound, requireScope } from "@/lib/api/v1-response";

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

  const { count } = await admin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", auth.tenantId)
    .eq("customer_id", customer.id)
    .eq("status", "active");

  return NextResponse.json(mapCustomer(customer, (count ?? 0) > 0));
}
