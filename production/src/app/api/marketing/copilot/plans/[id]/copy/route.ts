/**
 * GET / PUT /api/marketing/copilot/plans/[id]/copy — R-1897: Co-pilot Step 3, the ad copy.
 *
 * GET → { status, sets: [{ platform, audience, format, version, rows }] } — every saved set of
 *       the plan (one per platform × audience), lines in order.
 * PUT → autosave ONE set: { platform, audience, format, expectedVersion, lines[] }.
 *       expectedVersion = the version the screen loaded (0 = never saved). Older → 409 with the
 *       current version (another tab saved first). Lines over a platform limit DO save (work is
 *       never lost); "Mark ready" is what refuses them. A Ready plan goes back to Draft.
 *
 * Who: owner, manager, marketing (R-1878); another company's id reads as not found.
 * Nothing here ever sends anything to Google or Meta.
 */
import { NextResponse } from "next/server";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { EDITABLE, copilotRoleOk, forbidden, myActiveRole } from "../../plan-io";
import { COPILOT_COPY_ROLES } from "@/lib/marketing/copilot/copy-prompt";
import { checkSetBody, planForCopy, readSets, saveSet, saveSetSchema } from "../../copy-io";

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
    const plan = await planForCopy(tx, session.tenantId, id);
    if (!plan) return { kind: "missing" as const };
    return { kind: "ok" as const, status: plan.status, sets: await readSets(tx, session.tenantId, id) };
  });
  if (out.kind === "forbidden") return forbidden();
  if (out.kind === "missing") return notFound();
  return NextResponse.json({ status: out.status, sets: out.sets });
}

export async function PUT(req: Request, { params }: Ctx) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID.test(id)) return notFound();

  const parsed = saveSetSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Check the ad copy — something in it is not valid.", detail: parsed.error.issues[0]?.message ?? null }, { status: 400 });
  }
  const b = parsed.data;

  const out = await withTenant(session, async (tx) => {
    /* Role gate (R-732 ratchet): owner / manager / marketing — the same roles as the co-pilot tables' RLS. */
    const role = await myActiveRole(tx, session.userId);
    if (!role || !(COPILOT_COPY_ROLES as readonly string[]).includes(role)) return { kind: "forbidden" as const };
    const plan = await planForCopy(tx, session.tenantId, id);
    if (!plan) return { kind: "missing" as const };
    if (!EDITABLE.has(plan.status)) return { kind: "locked" as const };
    const bad = checkSetBody(plan, b);
    if (bad) return { kind: "bad" as const, error: bad };
    return saveSet(tx, session.tenantId, plan, b);
  });

  if (out.kind === "forbidden") return forbidden();
  if (out.kind === "missing") return notFound();
  if (out.kind === "locked") return NextResponse.json({ error: "This plan is already being published — it cannot be changed here." }, { status: 409 });
  if (out.kind === "bad") return NextResponse.json({ error: out.error }, { status: 400 });
  if (out.kind === "conflict") {
    return NextResponse.json({
      error: "This copy was changed in another tab or by a teammate. Reload to see the latest version.",
      code: "version_conflict", version: out.version,
    }, { status: 409 });
  }
  return NextResponse.json({ version: out.version, status: out.status });
}
