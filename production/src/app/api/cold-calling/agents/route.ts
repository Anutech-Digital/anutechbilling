/** GET /api/cold-calling/agents — the Bolna agents to choose from (R-1661), read live from Bolna. */
import { NextResponse } from "next/server";
import { listBolnaAgents } from "@/lib/telecall/provider";
import { bolnaOrError, coldCallContext } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  const config = bolnaOrError();
  if (config instanceof NextResponse) return config;
  const r = await listBolnaAgents(config);
  if (!r.ok) {
    return NextResponse.json({ error: "Could not read your agents from Bolna.", detail: r.error }, { status: 502 });
  }
  return NextResponse.json({ agents: r.agents, defaultAgentId: config.agentId });
}
