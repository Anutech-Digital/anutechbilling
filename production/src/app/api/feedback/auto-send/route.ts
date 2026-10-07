/**
 * /api/feedback/auto-send — the workspace switch "Auto-send new reports to AI" (R-357).
 *
 *   GET  → { on, canEdit, ready }   any signed-in member (the Bug Reports page shows the state)
 *   POST → { on: boolean }          workspace owner only
 *
 * ON (the default) means a new report goes to the AI queue as soon as it is triaged, with no
 * Run AI Auto-Fix press (see /api/feedback/triage). `ready` is false until migration
 * 20261007110000_feedback_agent_claim.sql adds tenants.feedback_auto_send: the switch then
 * reads ON and a save answers 409 saying so, instead of pretending it was stored.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import {
  AUTO_SEND_COLUMN,
  AGENT_CLAIM_MIGRATION,
  isAutoSendOn,
  isMissingColumnError,
} from "@/lib/feedback/auto-send";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type TenantUpdate = Database["public"]["Tables"]["tenants"]["Update"];

const bodySchema = z.object({ on: z.boolean() });

async function me() {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth?.user) return null;
  const { data } = await supabase.from("users").select("tenant_id, role").eq("id", auth.user.id).maybeSingle();
  if (!data?.tenant_id) return null;
  return { tenantId: data.tenant_id as string, isOwner: data.role === "owner" };
}

export async function GET() {
  const who = await me();
  if (!who) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  const admin = createAdminClient();
  const { data, error } = await admin.from("tenants").select("*").eq("id", who.tenantId).maybeSingle();
  if (error) return NextResponse.json({ error: "Could not read the setting." }, { status: 500 });
  return NextResponse.json({
    on: isAutoSendOn(data),
    canEdit: who.isOwner,
    ready: Boolean(data && AUTO_SEND_COLUMN in data),
  });
}

export async function POST(req: NextRequest) {
  const who = await me();
  if (!who) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!who.isOwner) return NextResponse.json({ error: "Only the workspace owner can change this." }, { status: 403 });

  let parsed;
  try { parsed = bodySchema.parse(await req.json()); } catch {
    return NextResponse.json({ error: "Body must be {\"on\": true|false}." }, { status: 400 });
  }

  /* Typed as the table Update: database.generated.ts learns this column only after the
     migration is applied and the types are regenerated (scripts/check-db-types.mjs --write). */
  const patch = { [AUTO_SEND_COLUMN]: parsed.on, updated_at: new Date().toISOString() } as TenantUpdate;
  const admin = createAdminClient();
  const { error } = await admin.from("tenants").update(patch).eq("id", who.tenantId);
  if (error) {
    if (isMissingColumnError(error)) {
      return NextResponse.json(
        { error: `Not saved: this switch needs migration ${AGENT_CLAIM_MIGRATION}. Until then new reports are always sent.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Could not save the setting." }, { status: 500 });
  }
  return NextResponse.json({ ok: true, on: parsed.on });
}
