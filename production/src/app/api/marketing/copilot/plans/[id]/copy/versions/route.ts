/**
 * GET /api/marketing/copilot/plans/[id]/copy/versions?platform=&audience= — R-1897: the saved
 * versions of ONE copy set (newest first, the latest 20), each with its lines, so Step 3 can
 * bring an earlier version back (it is saved again as a new version — history is never rewritten).
 * Owner, manager, marketing; another company's plan reads as not found.
 */
import { NextResponse } from "next/server";
import { getTenantSession } from "@/server/auth/session";
import { withTenant } from "@/server/db";
import { PLATFORMS } from "@/lib/marketing/copilot/channel-specs";
import { AUDIENCE_KEYS } from "@/lib/marketing/copilot/copy-set";
import { copilotRoleOk, forbidden } from "../../../plan-io";
import { KEEP_VERSIONS, planForCopy } from "../../../copy-io";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: "That campaign plan was not found." }, { status: 404 });

export async function GET(req: Request, { params }: Ctx) {
  const session = await getTenantSession();
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  const q = new URL(req.url).searchParams;
  const platform = q.get("platform") ?? "";
  const audience = q.get("audience") ?? "";
  if (!(PLATFORMS as readonly string[]).includes(platform) || !(AUDIENCE_KEYS as readonly string[]).includes(audience)) {
    return NextResponse.json({ error: "Say which platform and audience." }, { status: 400 });
  }

  const out = await withTenant(session, async (tx) => {
    if (!(await copilotRoleOk(tx, session.userId))) return { kind: "forbidden" as const };
    const plan = await planForCopy(tx, session.tenantId, id);
    if (!plan) return { kind: "missing" as const };
    const set = await tx.ad_copy_sets.findFirst({
      where: { tenant_id: session.tenantId, plan_id: id, platform, audience },
      select: { id: true },
    });
    if (!set) return { kind: "ok" as const, versions: [] };
    const versions = await tx.ad_copy_set_versions.findMany({
      where: { tenant_id: session.tenantId, set_id: set.id },
      orderBy: { version: "desc" },
      take: KEEP_VERSIONS,
      select: { version: true, lines: true, saved_at: true },
    });
    return { kind: "ok" as const, versions };
  });
  if (out.kind === "forbidden") return forbidden();
  if (out.kind === "missing") return notFound();
  return NextResponse.json({
    versions: out.versions.map((v) => ({
      version: v.version,
      savedAt: v.saved_at instanceof Date ? v.saved_at.toISOString() : String(v.saved_at),
      lines: Array.isArray(v.lines) ? v.lines : [],
    })),
  });
}
