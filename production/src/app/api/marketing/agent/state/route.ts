/**
 * GET /api/marketing/agent/state?planId=… — R-2157 (G-ADS-AI, AI-01): where the agent is on
 * this plan: not_started | waiting (with what it waits for) | running | done, plus the
 * checked CampaignState (a checkpoint that no longer fits the schema shows as null).
 *
 * 401 no session · 400 bad planId · 403 not owner or marketing · 404 plan not in this company.
 */
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { AgentThreadError } from "@/lib/marketing/agent/checkpointer";
import { readRun } from "@/lib/marketing/agent/runner";
import {
  AGENT_ROLES, PlanIdSchema, activeRole, agentFailed, agentForbidden, agentGraphFor, badRequest,
  planNotFound, planSeed, runJson, signIn,
} from "../agent-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = await getTenantSession();
  if (!session) return signIn();

  const planId = PlanIdSchema.safeParse(new URL(req.url).searchParams.get("planId") ?? "");
  if (!planId.success) return badRequest(planId.error);

  const ctx = await withTenant(session, async (tx) => {
    const role = await activeRole(tx, session.userId);
    if (!role || !AGENT_ROLES.includes(role)) return "forbidden" as const;
    return (await planSeed(tx, session.tenantId, planId.data)) ? "ok" as const : "missing" as const;
  });
  if (ctx === "forbidden") return agentForbidden();
  if (ctx === "missing") return planNotFound();

  try {
    return runJson(await readRun(await agentGraphFor(session), planId.data));
  } catch (e) {
    if (e instanceof AgentThreadError) return badRequest(e.message);
    return agentFailed("state", e);
  }
}
