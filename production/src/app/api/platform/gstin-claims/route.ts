/**
 * R-2445 (G-NETWORK) — /api/platform/gstin-claims: the platform admin's GSTIN-ownership queue.
 *
 * A company proves it owns its GSTIN (Settings → Network → "Prove you own this GSTIN"); the
 * platform admin sees company + GSTIN + GSTN legal name + any other company on the same GSTIN
 * here and approves or rejects. Why an admin check and not OTP: our GSTN lookup (Sandbox public
 * search) returns no registered email / mobile, so there is nothing to send an OTP to without
 * a new paid API. Spec: docs/specs/g-network.md → "GSTIN ownership".
 *
 * Gate (same as /api/platform/signups/[id] DELETE): signed in, email on the platform allowlist
 * AND confirmed — checked BEFORE the service-role client exists. The SQL functions are granted
 * to service_role only and store the admin's own (server-read) email as who decided.
 *
 *   GET  ?status=pending|approved|rejected|revoked|all   → { claims: [...] }
 *   POST { action: "approve" | "reject", claimId, note? } → { ok, result }
 *   POST { action: "revoke", tenantId, note }             → { ok, result }
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";

export const dynamic = "force-dynamic";

const fail = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status });

const STATUSES = ["pending", "approved", "rejected", "withdrawn", "revoked", "all"] as const;

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve"), claimId: z.string().uuid(), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal("reject"), claimId: z.string().uuid(), note: z.string().max(1000).optional() }),
  z.object({ action: z.literal("revoke"), tenantId: z.string().uuid(), note: z.string().min(1).max(1000) }),
]);

/** The signed-in platform admin's email, or a ready error response. */
async function adminEmail(): Promise<{ email: string } | { res: NextResponse }> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { res: fail(401, "You are not signed in — sign in again and retry.") };
  if (!isPlatformAdmin(user.email)) {
    return { res: fail(403, "Only a ResellerOS platform admin can check GSTIN ownership.") };
  }
  if (!user.email_confirmed_at) {
    return { res: fail(403, "Your email is not verified yet — open the verification link in your inbox, then try again.") };
  }
  return { email: String(user.email).trim().toLowerCase() };
}

type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
/* The functions are newer than the generated Database types — narrow untyped rpc. */
const rpcOf = (c: unknown): Rpc => (fn, args) => (c as { rpc: Rpc }).rpc(fn, args);

export async function GET(request: Request) {
  const who = await adminEmail();
  if ("res" in who) return who.res;
  const raw = new URL(request.url).searchParams.get("status") ?? "pending";
  const status = (STATUSES as readonly string[]).includes(raw) ? raw : "pending";
  const { data, error } = await rpcOf(createAdminClient())("platform_gstin_claims", { p_status: status });
  if (error) {
    console.error("[api/platform/gstin-claims] list failed:", error.message);
    return fail(500, "Could not load the GSTIN ownership claims. Refresh the page; if it keeps failing, check the server log.");
  }
  return NextResponse.json({ ok: true, claims: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const who = await adminEmail();
  if ("res" in who) return who.res;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return fail(400, "Send { action: approve | reject, claimId } or { action: revoke, tenantId, note } — a revoke needs a reason.");
  }
  const body = parsed.data;
  const rpc = rpcOf(createAdminClient());
  const { data, error } = body.action === "revoke"
    ? await rpc("platform_revoke_gstin_owner", { p_tenant: body.tenantId, p_admin_email: who.email, p_note: body.note })
    : await rpc("platform_decide_gstin_claim", {
        p_claim: body.claimId, p_approve: body.action === "approve", p_admin_email: who.email, p_note: body.note ?? null,
      });
  if (error) {
    /* The SQL guards phrase the next step themselves (e.g. "… revoke X first, then approve"). */
    const known = error.code === "22023" || error.code === "P0002" || error.code === "23505";
    if (!known) console.error("[api/platform/gstin-claims] decide failed:", error.message);
    return fail(known ? 409 : 500, known ? error.message : "Nothing was changed — the server could not save the decision. Refresh and try again.");
  }
  return NextResponse.json({ ok: true, result: data });
}
