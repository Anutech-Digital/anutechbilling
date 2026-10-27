/**
 * R-1879 — the co-pilot plan routes' shared reads and writes (draft, plans, plans/[id]).
 * Everything runs inside withTenant, so RLS (R-1878: same company AND owner / manager /
 * marketing) is the second lock behind the role check here.
 */
import { NextResponse } from "next/server";
import type { Tx } from "@/server/db";
import { mayWriteCopy } from "@/lib/marketing/copilot/copy-prompt";
import {
  audienceFromGroups, targetGroupRows,
  type ItemOption, type PlanDraft,
} from "@/lib/marketing/copilot/plan-draft";
import type { AdPlatform, CopilotObjective } from "@/lib/marketing/copilot/channel-specs";
import type { CopyLanguage } from "@/lib/marketing/copilot/copy-prompt";

/** The most products offered in the picker (and sent to the AI). */
const ITEM_LIMIT = 300;

/** The signed-in person's role, or null when the users row is missing or inactive. */
export async function myActiveRole(tx: Tx, userId: string): Promise<string | null> {
  const me = await tx.public_users.findUnique({ where: { id: userId }, select: { role: true, is_active: true } });
  return me && me.is_active !== false ? String(me.role) : null;
}

export async function copilotRoleOk(tx: Tx, userId: string): Promise<boolean> {
  return mayWriteCopy(await myActiveRole(tx, userId));
}

export const forbidden = () => NextResponse.json(
  { error: "The campaign co-pilot is for marketing, the owner and managers.", detail: "Ask the owner to change your role on the Team page." },
  { status: 403 },
);

export async function activeItems(tx: Tx, tenantId: string): Promise<ItemOption[]> {
  const rows = await tx.items.findMany({
    where: { tenant_id: tenantId, is_active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: ITEM_LIMIT,
  });
  return rows.map((r) => ({ id: String(r.id), name: String(r.name) }));
}

/** Statuses a person may still edit in the wizard; publishing / live belong to the publisher. */
export const EDITABLE = new Set(["draft", "ready"]);

export interface SavedPlan extends PlanDraft {
  id: string;
  status: string;
  updatedAt: string;
}

export async function readPlan(tx: Tx, tenantId: string, id: string): Promise<SavedPlan | null> {
  const p = await tx.ad_plans.findFirst({
    where: { id, tenant_id: tenantId },
    select: {
      id: true, name: true, item_id: true, objective: true, platforms: true, prompt: true,
      language: true, status: true, updated_at: true,
      ad_target_groups: { select: { kind: true, age_min: true, age_max: true, genders: true, regions: true } },
    },
  });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    itemId: p.item_id,
    objective: p.objective as CopilotObjective,
    platforms: p.platforms as AdPlatform[],
    prompt: p.prompt,
    language: p.language as CopyLanguage,
    audience: audienceFromGroups(p.ad_target_groups),
    status: p.status,
    updatedAt: p.updated_at.toISOString(),
  };
}

/** Create (no id) or update a plan and replace its audience rows — one transaction. */
export async function writePlan(tx: Tx, tenantId: string, plan: PlanDraft, id?: string): Promise<string> {
  const fields = {
    name: plan.name,
    item_id: plan.itemId,
    objective: plan.objective,
    platforms: plan.platforms,
    prompt: plan.prompt,
    language: plan.language,
  };
  let planId = id;
  if (planId) {
    await tx.ad_plans.update({ where: { id: planId }, data: { ...fields, updated_at: new Date() } });
    await tx.ad_target_groups.deleteMany({ where: { tenant_id: tenantId, plan_id: planId } });
  } else {
    const created = await tx.ad_plans.create({ data: { ...fields, tenant_id: tenantId, status: "draft" }, select: { id: true } });
    planId = created.id;
  }
  await tx.ad_target_groups.createMany({
    data: targetGroupRows(plan).map((g) => ({ ...g, tenant_id: tenantId, plan_id: planId! })),
  });
  return planId;
}
