/**
 * GET / PUT /api/marketing/copilot/plans/[id] — R-1879: open a co-pilot draft and save the
 * wizard's steps 1–2 (name, product, objective, platforms, audience).
 *
 * Who: owner, manager, marketing (R-1878); another company's id reads as not found.
 * PUT body = PlanDraft (plan-draft.ts planDraftSchema). Platforms the objective cannot run on
 * are dropped with a note; nothing left → 400. A plan already publishing / live → 409
 * (the publisher owns it from there, R-1886+).
 */
import { NextResponse } from "next/server";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { normalizePlan, planDraftSchema } from "@/lib/marketing/copilot/plan-draft";
import { EDITABLE, copilotRoleOk, forbidden, readPlan, writePlan } from "../plan-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "That campaign plan was not found." }, { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const out = await withTenant(session, async (tx) => {
    if (!(await copilotRoleOk(tx, session.userId))) return { kind: "forbidden" as const };
    return { kind: "ok" as const, plan: await readPlan(tx, session.tenantId, id) };
  });
  if (out.kind === "forbidden") return forbidden();
  if (!out.plan) return notFound();
  return NextResponse.json({ plan: out.plan });
}

export async function PUT(req: Request, { params }: Ctx) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const parsed = planDraftSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Check the form — something in it is not valid." }, { status: 400 });
  }
  const { plan, notes, error } = normalizePlan(parsed.data);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const out = await withTenant(session, async (tx) => {
    if (!(await copilotRoleOk(tx, session.userId))) return { kind: "forbidden" as const };
    const now = await readPlan(tx, session.tenantId, id);
    if (!now) return { kind: "missing" as const };
    if (!EDITABLE.has(now.status)) return { kind: "locked" as const };
    await writePlan(tx, session.tenantId, plan, id);
    return { kind: "ok" as const, plan: await readPlan(tx, session.tenantId, id) };
  });
  if (out.kind === "forbidden") return forbidden();
  if (out.kind === "missing") return notFound();
  if (out.kind === "locked") {
    return NextResponse.json({ error: "This plan is already being published — it cannot be changed here." }, { status: 409 });
  }
  return NextResponse.json({ plan: out.plan, notes });
}
