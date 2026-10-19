/** GET / POST /api/cold-calling/campaigns — list campaigns, start a new one (R-1661). */
import { NextResponse } from "next/server";
import { z } from "zod";
import { listBolnaAgents } from "@/lib/telecall/provider";
import { createCampaign, listCampaigns } from "@/server/coldcall/coldcall.server";
import { bolnaOrError, coldCallContext } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({ campaigns: await listCampaigns(ctx.run, new Date()) });
}

const body = z.object({
  name: z.string().trim().min(1).max(120),
  agentId: z.string().trim().min(1).max(100),
  dailyLimit: z.coerce.number().int().min(1).max(1000).default(50),
});

export async function POST(req: Request) {
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Give the campaign a name, pick an agent, and a daily limit from 1 to 1,000." },
      { status: 400 },
    );
  }
  const config = bolnaOrError();
  if (config instanceof NextResponse) return config;
  /* Only an agent that is really on this Bolna account — the id is checked, not trusted. */
  const agents = await listBolnaAgents(config);
  if (!agents.ok) {
    return NextResponse.json({ error: "Could not read your agents from Bolna.", detail: agents.error }, { status: 502 });
  }
  const agent = agents.agents.find((a) => a.id === parsed.data.agentId);
  if (!agent) {
    return NextResponse.json(
      { error: "That agent is not on your Bolna account.", detail: "Refresh the page and pick an agent from the list." },
      { status: 400 },
    );
  }
  const id = await createCampaign(ctx.run, {
    tenantId: ctx.session.tenantId, userId: ctx.session.userId, name: parsed.data.name,
    agentId: agent.id, agentName: agent.name, dailyLimit: parsed.data.dailyLimit,
  });
  return NextResponse.json({ id }, { status: 201 });
}
