/** POST /api/cold-calling/campaigns/bulk-delete — delete several campaigns at once (R-1663). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteCampaigns } from "@/server/coldcall/coldcall.server";
import { coldCallContext } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

export async function POST(req: Request) {
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  if (ctx.role !== "owner" && ctx.role !== "manager") {
    return NextResponse.json(
      { error: "Only the owner or a manager can delete campaigns.", detail: "You can press Pause on a campaign instead, or ask your manager." },
      { status: 403 },
    );
  }
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Pick at least one campaign.", detail: "Tick the boxes on the campaigns to delete." }, { status: 400 });
  }
  return NextResponse.json(await deleteCampaigns(ctx.run, parsed.data.ids));
}
