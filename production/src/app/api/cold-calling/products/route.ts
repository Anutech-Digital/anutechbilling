/** GET /api/cold-calling/products — what a campaign can be for: the catalogue's main items (R-1663). */
import { NextResponse } from "next/server";
import { listProducts } from "@/server/coldcall/coldcall.server";
import { coldCallContext } from "@/server/coldcall/route-context";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const ctx = await coldCallContext();
  if (ctx instanceof NextResponse) return ctx;
  return NextResponse.json({ products: await listProducts(ctx.run) });
}
