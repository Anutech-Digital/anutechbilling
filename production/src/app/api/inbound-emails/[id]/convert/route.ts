/**
 * POST /api/inbound-emails/[id]/convert — turn an enquiry into a lead.
 *
 * ─── THE HEADER SAID "TENANT-SCOPED". IT WAS NOT SCOPED AT ALL ──────────────
 * Found 30 Aug 2026, alongside the same hole in the list route next door. This handler
 * took an id straight off the URL and handed it to a service_role RPC:
 *
 *     const admin = createAdminClientFor(user.id);
 *     await admin.rpc("convert_inbound_email_to_lead", { p_id: params.id });
 *
 * No session was required and no tenant was checked. `/api` is not in the middleware's
 * PROTECTED_PREFIXES, so nothing upstream required one either — and the list route was
 * handing out the ids anonymously, so the two together made a complete path: read every
 * enquiry id without signing in, then write a lead for any of them.
 *
 * A write is the half that matters here. A stranger could not read the result back after
 * this fix, but a lead they created would still be sitting in somebody's pipeline, and a
 * converted enquiry leaves the Inbox — so the damage outlives the request.
 *
 * The check is done BEFORE the RPC and by tenant, not by id alone: `.eq("id", …)` on its
 * own proves the row exists, which is not the same as proving it is yours.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";

export async function POST(_request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to convert an enquiry." }, { status: 401 });
  }

  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json(
      { error: "Your account is not attached to a workspace yet." },
      { status: 403 },
    );
  }

  const admin = createAdminClientFor(user.id);

  /* Does this enquiry belong to the caller's tenant? A 404 for both "no such row" and
     "not yours" on purpose — telling a stranger which ids exist is its own answer. */
  const { data: row } = await admin
    .from("inbound_emails")
    .select("id")
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();

  if (!row) {
    return NextResponse.json({ error: "Enquiry not found." }, { status: 404 });
  }

  const { data, error } = await admin.rpc("convert_inbound_email_to_lead", { p_id: params.id });

  if (error) {
    console.error("[api/inbound-emails/convert] error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ leadId: data });
}
