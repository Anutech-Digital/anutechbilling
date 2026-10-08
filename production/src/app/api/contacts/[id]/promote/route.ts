/**
 * POST /api/contacts/[id]/promote
 *
 * Promote a contact (from the standalone directory) into a lead at
 * stage='new' on the Deal Pipeline. The original contact row stays —
 * we set status='promoted' and link via promoted_to_lead_id.
 *
 * Body (optional overrides):
 *   { plan?: string; seats?: number; value?: number; notes?: string }
 *
 * Returns: { leadId, contactId }
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const schema = z.object({
  plan:   z.string().optional(),
  seats:  z.coerce.number().int().min(1).max(10000).optional(),
  value:  z.coerce.number().int().min(0).optional(),
  notes:  z.string().max(2000).optional(),
}).default({});

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const userClient = createClient();
  const { data: authData } = await userClient.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: me } = await userClient
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .single();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "user not linked to a tenant" }, { status: 403 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = {}; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body: " + parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 }
    );
  }

  const admin = createAdminClientFor(authData.user.id);

  // Load contact + verify tenant
  const { data: contact, error: cErr } = await admin
    .from("contacts")
    .select("*")
    .eq("id", params.id)
    .single();
  if (cErr || !contact) {
    return NextResponse.json({ error: "contact not found" }, { status: 404 });
  }
  if (contact.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (contact.promoted_to_lead_id) {
    return NextResponse.json(
      { error: "already promoted", leadId: contact.promoted_to_lead_id },
      { status: 409 }
    );
  }

  // Create lead
  const leadId = "L-" + Date.now().toString(36).toUpperCase();
  const notes  = [
    `Promoted from contact ${contact.id} (source: ${contact.source})`,
    contact.notes ? `Original notes: ${contact.notes}` : null,
    parsed.data.notes ? `Promotion note: ${parsed.data.notes}` : null,
  ].filter(Boolean).join("\n");

  const { error: leadErr } = await admin.from("leads").insert({
    id:             leadId,
    tenant_id:      me.tenant_id,
    company:        contact.company || contact.full_name,
    contact_name:   contact.full_name,
    contact_email:  contact.email,
    contact_phone:  contact.phone,
    plan:           parsed.data.plan  ?? null,
    seats:          parsed.data.seats ?? null,
    value:          parsed.data.value ?? null,
    stage:          "new",
    source:         `from-contact:${contact.source}`,
    notes,
  });
  if (leadErr) {
    return NextResponse.json({ error: leadErr.message }, { status: 500 });
  }

  // Mark contact as promoted
  const { error: updErr } = await admin
    .from("contacts")
    .update({
      status:               "promoted",
      promoted_to_lead_id:  leadId,
      promoted_at:          new Date().toISOString(),
    })
    .eq("id", params.id);
  if (updErr) {
    // Lead created but contact update failed — not catastrophic, log
    console.error("[contacts/promote] contact update failed:", updErr);
  }

  return NextResponse.json({ leadId, contactId: params.id });
}
