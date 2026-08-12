/**
 * GET /api/inbound-emails
 *
 * Tenant-scoped server endpoint for fetching inbound emails.
 * Supports logged-in user session as well as fallback tenant for local preview.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

const DEFAULT_TENANT_ID =
  process.env.INBOUND_EMAIL_TENANT_ID?.trim() ||
  process.env.BUY_PAGE_TENANT_ID?.trim() ||
  "fbb976f1-9090-4f10-9726-0901bd144e42";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let tenantId = DEFAULT_TENANT_ID;

  if (user) {
    const { data: me } = await supabase
      .from("users")
      .select("tenant_id")
      .eq("id", user.id)
      .maybeSingle();

    if (me?.tenant_id) {
      tenantId = me.tenant_id;
    }
  }

  const admin = createAdminClient();
  let { data, error } = await admin
    .from("inbound_emails")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  // Fallback to top inbound emails if specific tenant has no rows in local preview
  if (!error && (!data || data.length === 0)) {
    const { data: fallbackData } = await admin
      .from("inbound_emails")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (fallbackData && fallbackData.length > 0) {
      data = fallbackData;
    }
  }

  if (error) {
    console.error("[api/inbound-emails] GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
