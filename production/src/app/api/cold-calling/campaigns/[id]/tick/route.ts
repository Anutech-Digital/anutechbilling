/**
 * POST /api/cold-calling/campaigns/[id]/tick — "Check results / call next now" (R-1662).
 * The same pass the cron runs, for one campaign, as the signed-in person (RLS). On a laptop,
 * where no cron runs and the vendor webhook cannot reach, this is how calls move.
 */
import { NextResponse } from "next/server";
import { runCampaignTick } from "@/server/coldcall/coldcall.server";
import { bolnaOrError, coldCallContext, UUID_RE } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(_req: Request, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "No such campaign." }, { status: 404 });
  const config = bolnaOrError();
  if (config instanceof NextResponse) return config;
  const report = await runCampaignTick(ctx.run, ctx.session.tenantId, id, config, new Date());
  return NextResponse.json(report);
}
