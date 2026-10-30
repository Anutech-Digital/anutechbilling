/**
 * POST /api/marketing/agent/resume — R-2157 (G-ADS-AI, AI-01): answer the gate the agent is
 * waiting at. Body: { planId, decision: "approve" | "edit" | "reject", note? }.
 * The answer goes back into the graph as Command({ resume }).
 *
 * 401 no session · 400 bad body · 403 not owner or marketing · 404 plan not in this company ·
 * 409 not started / not waiting (returns the current run) · 200 { run }.
 */
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { AgentThreadError } from "@/lib/marketing/agent/checkpointer";
import { AgentConflictError, resumeRun } from "@/lib/marketing/agent/runner";
import { ReviewDecisionSchema } from "@/lib/marketing/agent/state";
import {
  AGENT_ROLES, PlanIdSchema, activeRole, agentFailed, agentForbidden, agentGraphFor, badRequest,
  planNotFound, planSeed, runJson, signIn,
} from "../agent-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = ReviewDecisionSchema.extend({ planId: PlanIdSchema });

export async function POST(req: Request) {
  const session = await getTenantSession();
  if (!session) return signIn();

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(parsed.error);
  const { planId, ...answer } = parsed.data;

  const ctx = await withTenant(session, async (tx) => {
    const role = await activeRole(tx, session.userId);
    if (!role || !AGENT_ROLES.includes(role)) return "forbidden" as const;
    return (await planSeed(tx, session.tenantId, planId)) ? "ok" as const : "missing" as const;
  });
  if (ctx === "forbidden") return agentForbidden();
  if (ctx === "missing") return planNotFound();

  try {
    return runJson(await resumeRun(agentGraphFor(session), planId, answer));
  } catch (e) {
    if (e instanceof AgentConflictError) return Response.json({ error: e.message, run: e.view }, { status: 409 });
    if (e instanceof AgentThreadError) return badRequest(e.message);
    return agentFailed("resume", e);
  }
}
