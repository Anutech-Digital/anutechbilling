/**
 * GET /api/expense-claim/link — the owner's shareable expense-claim link.
 *
 * Authenticated. Resolves the caller's tenant, signs a claim token, and builds
 * the full /expense-claim URL off the real request host (so the link points at
 * whatever domain the app is served on). The owner shares this with staff.
 */
import { NextResponse, type NextRequest } from "next/server";
import { trustedOrigin } from "@/lib/app-url";
import { createClient } from "@/lib/supabase/server";
import { claimLinkUrl } from "@/lib/claim-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { data: me } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (!me?.tenant_id) return NextResponse.json({ error: "No tenant" }, { status: 400 });

  const appUrl = trustedOrigin(req.headers); // R-723: never a raw request host

  return NextResponse.json({ url: claimLinkUrl(appUrl, me.tenant_id) });
}
