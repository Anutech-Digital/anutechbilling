/**
 * /api/leads/[id]/ai-workflow — R-2039, AI Lead Workflow A.
 *
 *   POST  run enrich → qualify → 2-line pitch as an email DRAFT for this lead (nothing is sent).
 *         200 with the finished run; 202 with the run already going (a second press never starts
 *         a second run); §24 errors as { error, detail } (+ the failed run when one was recorded).
 *   GET   the lead's latest run, read with the caller's own client (RLS), for the UI to poll.
 *
 * Who: a signed-in member whose role may open Leads (mayOpenPage, R-1470). The lead is looked up
 * with the USER's client first, so a lead of another company — or one the hierarchy hides from
 * this person — is 404 before any AI is called or anything is written. The runner then writes
 * with the admin client, every query pinned to the caller's tenant.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { mayOpenPage, ROLE_GATE_ERROR } from "@/lib/api/with-route";
import { runLeadAiWorkflow, latestLeadAiRun } from "@/lib/leads/ai-workflow.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/* Website reads + two AI calls; the Lead Finder budget. */
export const maxDuration = 120;

type Caller =
  | { ok: false; res: NextResponse }
  | { ok: true; supabase: ReturnType<typeof createClient>; userId: string; tenantId: string };

async function caller(leadId: string): Promise<Caller> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "Please sign in again.", detail: "Your session ended — sign in and open the lead again." }, { status: 401 }) };
  const { data: me } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return { ok: false, res: NextResponse.json({ error: "Your account is not linked to a workspace yet.", detail: "An owner can claim it on the Team page." }, { status: 403 }) };
  }
  if (!mayOpenPage(me.role, ["/leads"])) return { ok: false, res: NextResponse.json({ error: ROLE_GATE_ERROR }, { status: 403 }) };
  const { data: visible } = await supabase.from("leads").select("id").eq("id", leadId).eq("tenant_id", me.tenant_id).maybeSingle();
  if (!visible) {
    return { ok: false, res: NextResponse.json({ error: "Lead not found.", detail: "That lead is not in your list any more — refresh the page." }, { status: 404 }) };
  }
  return { ok: true, supabase, userId: user.id, tenantId: me.tenant_id as string };
}

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await props.params;
  const who = await caller(leadId);
  if (!who.ok) return who.res;

  const out = await runLeadAiWorkflow({ admin: createAdminClient() as never, tenantId: who.tenantId, leadId, userId: who.userId });
  if (out.kind === "error") {
    return NextResponse.json({ error: out.error, detail: out.detail, ...(out.run ? { run: out.run } : {}) }, { status: out.status });
  }
  return NextResponse.json({ run: out.run, alreadyRunning: out.kind === "running" }, { status: out.status });
}

export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await props.params;
  const who = await caller(leadId);
  if (!who.ok) return who.res;
  const run = await latestLeadAiRun(who.supabase as never, leadId);
  return NextResponse.json({ run });
}
