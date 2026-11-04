/**
 * R-2157 (G-ADS-AI, AI-01) — what the three agent routes (start, resume, state) share.
 *
 * Who: owner and marketing of the plan's own company (card R-2157). Narrower than the
 * co-pilot wizard (which also lets managers in): this agent will propose spend, and the
 * agent_checkpoints RLS (migration 20261030084415) allows the same two roles, so the route
 * and the database agree. Each route checks the role itself (R-732 role-gate ratchet).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import type { TenantSession, Tx } from "@/server/db";
import { TenantCheckpointSaver } from "@/lib/marketing/agent/checkpointer";
import { compileCampaignGraph } from "@/lib/marketing/agent/graph";
import { xenoBrain } from "@/lib/marketing/agent/xeno-brain";
import { resolveGeminiConfig } from "@/lib/ai/gemini";
import { createClient } from "@/lib/supabase/server";
import type { ItemOption } from "@/lib/marketing/copilot/plan-draft";
import { activeItems } from "../copilot/plans/plan-io";
import { prismaCheckpointStore } from "@/lib/marketing/agent/prisma-store";
import type { AgentRunView } from "@/lib/marketing/agent/runner";
import type { PlanSeed } from "@/lib/marketing/agent/state";

export const AGENT_ROLES: readonly string[] = ["owner", "marketing"];

export const PlanIdSchema = z.string().uuid("Open a saved campaign plan first.");

/** The signed-in person's role, or null when the users row is missing or inactive. */
export async function activeRole(tx: Tx, userId: string): Promise<string | null> {
  const me = await tx.public_users.findUnique({ where: { id: userId }, select: { role: true, is_active: true } });
  return me && me.is_active !== false ? String(me.role) : null;
}

/** The plan as the graph's seed — only when it belongs to this company (RLS + explicit tenant filter). */
export async function planSeed(tx: Tx, tenantId: string, planId: string): Promise<PlanSeed | null> {
  const p = await tx.ad_plans.findFirst({
    where: { id: planId, tenant_id: tenantId },
    select: { id: true, tenant_id: true, marketing_campaign_id: true, prompt: true },
  });
  return p ? { tenantId: p.tenant_id, planId: p.id, campaignId: p.marketing_campaign_id, prompt: p.prompt } : null;
}

/** R-2159: the company's active products — Xeno matches the request to one (same list as the co-pilot). */
export const agentItems = (tx: Tx, tenantId: string): Promise<ItemOption[]> => activeItems(tx, tenantId);

/**
 * The graph with a checkpointer bound to THIS session (every read/write through withTenant).
 * Pass `items` when the run may reach Xeno (start, resume): Xeno then gets this company's AI
 * door, which counts every call against this company's monthly AI cap before it is made.
 * Without it (state) the graph is only read, never run.
 */
export async function agentGraphFor(session: TenantSession, items?: readonly ItemOption[]) {
  const saver = new TenantCheckpointSaver(prismaCheckpointStore(session));
  if (!items) return compileCampaignGraph(saver);
  const ai = await resolveGeminiConfig(createClient(), session.tenantId);
  const brain = xenoBrain({ tenantId: session.tenantId, apiKey: ai.apiKey, model: ai.model });
  return compileCampaignGraph(saver, { xeno: { items, brain } });
}

export const signIn = () => NextResponse.json({ error: "Please sign in again." }, { status: 401 });

export const agentForbidden = () => NextResponse.json(
  { error: "The marketing agent is for the owner and the marketing team.", detail: "Ask the owner to change your role on the Team page." },
  { status: 403 },
);

export const planNotFound = () => NextResponse.json(
  { error: "Campaign plan not found.", detail: "Open it again from Marketing → Campaign co-pilot." },
  { status: 404 },
);

export const badRequest = (error: z.ZodError | string) => NextResponse.json(
  { error: typeof error === "string" ? error : error.issues[0]?.message ?? "Check the request and try again." },
  { status: 400 },
);

/** 500 with a short ref; the raw error stays in the server log only. */
export function agentFailed(route: string, e: unknown) {
  const ref = Math.random().toString(36).slice(2, 10);
  console.error(`[api/marketing/agent/${route}] failed (${ref}):`, e);
  return NextResponse.json({ error: "The marketing agent could not finish this step. Try again.", ref }, { status: 500 });
}

export const runJson = (run: AgentRunView, status = 200) => NextResponse.json({ run }, { status });
