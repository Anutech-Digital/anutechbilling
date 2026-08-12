/**
 * POST /api/inbound-emails/[id]/convert
 *
 * Tenant-scoped server endpoint for converting an inbound email to a lead.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("convert_inbound_email_to_lead", { p_id: params.id });

  if (error) {
    console.error("[api/inbound-emails/convert] error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ leadId: data });
}
