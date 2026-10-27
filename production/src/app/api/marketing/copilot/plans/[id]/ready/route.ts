/**
 * POST /api/marketing/copilot/plans/[id]/ready — R-1897: "Mark ready" at the end of Step 3.
 *
 * The rule (copy-set.ts readyCheck): EVERY platform the plan uses needs at least one saved copy
 * set (any audience) that meets the platform's minimum — Google search 3 headlines + 2
 * descriptions, Meta 1 primary text + 1 headline + a call-to-action — with no line over a hard
 * limit. Otherwise 422 { error, missing[] } in plain words, and the plan stays Draft.
 * Ready only means "approved by a person"; nothing is sent to Google or Meta here.
 * Owner, manager, marketing; another company's plan reads as not found.
 */
import { NextResponse } from "next/server";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { readyCheck } from "@/lib/marketing/copilot/copy-set";
import { EDITABLE, forbidden, myActiveRole } from "../../plan-io";
import { COPILOT_COPY_ROLES } from "@/lib/marketing/copilot/copy-prompt";
import { planForCopy, readSets, toCopySets } from "../../copy-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "That campaign plan was not found." }, { status: 404 });

export async function POST(_req: Request, { params }: Ctx) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const out = await withTenant(session, async (tx) => {
    const role = await myActiveRole(tx, session.userId);
    if (!role || !(COPILOT_COPY_ROLES as readonly string[]).includes(role)) return { kind: "forbidden" as const };
    const plan = await planForCopy(tx, session.tenantId, id);
    if (!plan) return { kind: "missing" as const };
    if (!EDITABLE.has(plan.status)) return { kind: "locked" as const };
    const check = readyCheck(plan.platforms, plan.objective, toCopySets(await readSets(tx, session.tenantId, id)));
    if (!check.ok) return { kind: "not-ready" as const, missing: check.missing };
    if (plan.status !== "ready") {
      await tx.ad_plans.update({ where: { id: plan.id }, data: { status: "ready", updated_at: new Date() } });
    }
    return { kind: "ok" as const };
  });

  if (out.kind === "forbidden") return forbidden();
  if (out.kind === "missing") return notFound();
  if (out.kind === "locked") return NextResponse.json({ error: "This plan is already being published — it cannot be changed here." }, { status: 409 });
  if (out.kind === "not-ready") {
    return NextResponse.json({ error: "Some ad copy is still missing.", missing: out.missing }, { status: 422 });
  }
  return NextResponse.json({ status: "ready" });
}
