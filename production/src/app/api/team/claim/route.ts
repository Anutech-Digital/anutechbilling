/**
 * GET  /api/team/claim  → who is stranded right now AND asked to join / was invited here (R-721)
 * POST /api/team/claim  { email, role }  → claim them into this workspace
 *
 * ─── THIS ROUTE DELIBERATELY HOLDS NO PRIVILEGE OF ITS OWN ───────────────────
 * Both handlers use the SESSION client, not the admin client, and do nothing but
 * forward to a SECURITY DEFINER function. That is not laziness — it is the only
 * arrangement where the owner check cannot drift.
 *
 * The rule "only an owner may claim someone, and only into their own tenant"
 * needs `auth.uid()` to mean something. Calling through the admin client would
 * make `auth.uid()` null inside the function, so the check there would have to be
 * replaced by a check here, in TypeScript, in one route — and a check that only
 * exists in TypeScript is a check that stops at the first `curl` (roles.ts says
 * this better than I can). Forwarding the session keeps the guarantee in Postgres
 * where the function can enforce it for every caller, forever.
 *
 * The corollary: error text from the RPC is passed through UNCHANGED. Those
 * messages carry the reason and the next step (CLAUDE.md §24) — "their workspace
 * still holds 9 records" is the whole point, and replacing it with "Could not
 * claim user" would throw away the only useful thing the failure knows.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { INVITABLE_ROLES, type InvitableRole } from "@/lib/auth/roles";
import { isActiveOwner } from "@/lib/auth/deactivated";

export async function GET() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { data, error } = await supabase.rpc("list_stranded_auth_users");
  if (error) {
    // The function's own owner check produced this; say what it said.
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  return NextResponse.json({ users: data ?? [] });
}

// R-1421: the only 400s this route gives are these. Each says what to fix in words
// an owner understands. Pawan hit one on staging by pressing "Claim & merge" with the
// email box empty (R-721 narrowed the list, so there was no name to tap).
const EMAIL_MISSING = "Type their email address first — the one they sign in with.";
const schema = z.object({
  email: z
    .string({ required_error: EMAIL_MISSING, invalid_type_error: EMAIL_MISSING })
    .trim()
    .min(1, EMAIL_MISSING)
    .email("That doesn't look like an email address. Check it and try again.")
    .max(200, "That email address is too long."),
  role: z.enum(INVITABLE_ROLES as unknown as [InvitableRole, ...InvitableRole[]], {
    errorMap: () => ({ message: "Pick a role for them from the list." }),
  }),
});

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // A missing/broken body reads as "nothing typed" so the owner gets the same plain message.
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body && typeof body === "object" ? body : {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Type their email address and pick a role." },
      { status: 400 },
    );
  }

  // The destination is never taken from the request body. It is read from the
  // caller's own row, so "claim into some other tenant" is not expressible.
  const { data: me } = await supabase
    .from("users")
    .select("tenant_id, role, is_active")
    .eq("id", authData.user.id)
    .maybeSingle();

  if (!me?.tenant_id) {
    return NextResponse.json({ error: "You are not in a workspace." }, { status: 403 });
  }
  if (!isActiveOwner(me)) { // R-722: a deactivated owner is not an owner
    return NextResponse.json(
      { error: "Only the workspace owner can claim a colleague. Ask them to open Team." },
      { status: 403 },
    );
  }

  const { data, error } = await supabase.rpc("merge_stranded_user_into_tenant", {
    p_email:     parsed.data.email.trim().toLowerCase(),
    p_tenant_id: me.tenant_id,
    p_role:      parsed.data.role,
  });

  if (error) {
    // 409, not 500: every refusal path in that function is a legitimate state the
    // owner can act on, not a server fault.
    return NextResponse.json({ error: error.message }, { status: 409 });
  }

  return NextResponse.json({ ok: true, result: data });
}
