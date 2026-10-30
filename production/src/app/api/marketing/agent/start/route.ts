/**
 * POST /api/marketing/agent/start — R-2157 (G-ADS-AI, AI-01): start the marketing agent on a
 * saved co-pilot plan. Body: { planId, intent? } — intent defaults to the plan's prompt.
 *
 * 401 no session · 400 bad body / nothing to work from · 403 not owner or marketing ·
 * 404 plan not in this company · 409 already started (returns the current run) ·
 * 200 { run } — the run stops "waiting": at Xeno's questions (budget / goal missing, R-2159) or
 * at the review gate with Xeno's brief in run.state.brief.
 */
import { z } from "zod";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { AgentThreadError } from "@/lib/marketing/agent/checkpointer";
import { AgentConflictError, startRun } from "@/lib/marketing/agent/runner";
import { initialState } from "@/lib/marketing/agent/state";
import {
  AGENT_ROLES, PlanIdSchema, activeRole, agentFailed, agentForbidden, agentGraphFor, agentItems, badRequest,
  planNotFound, planSeed, runJson, signIn,
} from "../agent-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  planId: PlanIdSchema,
  intent: z.string().trim().max(4000, "Keep the campaign request under 4000 characters.").optional(),
});

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return signIn();

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(parsed.error);

  const ctx = await withTenant(session, async (tx) => {
    const role = await activeRole(tx, session.userId);
    if (!role || !AGENT_ROLES.includes(role)) return { kind: "forbidden" as const };
    const seed = await planSeed(tx, session.tenantId, parsed.data.planId);
    return seed ? { kind: "ok" as const, seed, items: await agentItems(tx, session.tenantId) } : { kind: "missing" as const };
  });
  if (ctx.kind === "forbidden") return agentForbidden();
  if (ctx.kind === "missing") return planNotFound();

  const first = initialState(ctx.seed, parsed.data.intent);
  if (!first.userIntent) return badRequest("Type what the campaign should do first.");

  try {
    return runJson(await startRun(await agentGraphFor(session, ctx.items), first));
  } catch (e) {
    if (e instanceof AgentConflictError) return Response.json({ error: e.message, run: e.view }, { status: 409 });
    if (e instanceof AgentThreadError) return badRequest(e.message);
    return agentFailed("start", e);
  }
}
