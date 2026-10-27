/**
 * GET /api/marketing/copilot/plans — R-1879: the co-pilot page's "Recent plans" (newest first)
 * and the product picker list (active items). Owner, manager, marketing only (R-1878).
 */
import { NextResponse } from "next/server";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { activeItems, copilotRoleOk, forbidden } from "./plan-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RECENT = 12;

export async function GET() {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const out = await withTenant(session, async (tx) => {
    if (!(await copilotRoleOk(tx, session.userId))) return null;
    const plans = await tx.ad_plans.findMany({
      where: { tenant_id: session.tenantId },
      orderBy: { updated_at: "desc" },
      take: RECENT,
      select: { id: true, name: true, objective: true, platforms: true, status: true, updated_at: true, item_id: true },
    });
    /* Brand = the company name until a brands table exists (R-1882). */
    const tenant = await tx.tenants.findUnique({ where: { id: session.tenantId }, select: { name: true } });
    return { plans, items: await activeItems(tx, session.tenantId), brand: tenant?.name ?? "" };
  });
  if (!out) return forbidden();

  const names = new Map(out.items.map((i) => [i.id, i.name]));
  return NextResponse.json({
    plans: out.plans.map((p) => ({
      id: p.id, name: p.name, objective: p.objective, platforms: p.platforms, status: p.status,
      updatedAt: p.updated_at.toISOString(), product: p.item_id ? names.get(p.item_id) ?? null : null,
    })),
    items: out.items,
    brand: out.brand,
  });
}
