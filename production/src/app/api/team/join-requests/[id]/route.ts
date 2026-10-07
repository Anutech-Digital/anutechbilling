/**
 * POST /api/team/join-requests/[id]   { action: "approve" | "reject", role? }
 *
 * The moment a `join_requests` row turns into access — or does not.
 *
 * ─── WHY APPROVAL RUNS SERVER-SIDE WITH THE ADMIN CLIENT ─────────────────────
 * Approving inserts a `public.users` row for SOMEBODY ELSE'S auth uid. No RLS
 * policy grants that and none should: "a signed-in user may create user rows" is
 * one typo away from "a signed-in user may create user rows in another tenant".
 * So the privilege lives here, behind an explicit owner check on the requesting
 * tenant, rather than in a policy that has to be re-read carefully forever.
 *
 * ─── THE ROLE IS RE-READ, NOT TRUSTED ────────────────────────────────────────
 * `requested_role` on the row is what the SIGNUP PATH proposed, and that path is
 * reachable by the person being approved. It is a suggestion. The role that gets
 * written is the one the owner sends in this request (falling back to the safest
 * value), so a crafted signup cannot promote itself to owner by asking nicely.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";
import { INVITABLE_ROLES, type InvitableRole } from "@/lib/auth/roles";

const schema = z.object({
  action: z.enum(["approve", "reject"]),
  role:   z.string().optional().nullable(),
});

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const admin = createAdminClientFor(authData.user.id);

  // ── Caller must be the OWNER of the tenant this request belongs to ──────
  const { data: me } = await admin
    .from("users")
    .select("tenant_id, role")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "You are not in a workspace." }, { status: 403 });
  }
  if (me.role !== "owner") {
    return NextResponse.json(
      { error: "Only the workspace owner can approve people. Ask them to open Team." },
      { status: 403 },
    );
  }

  const { data: req } = await admin
    .from("join_requests")
    .select("id, tenant_id, auth_user_id, email, full_name, status")
    .eq("id", params.id)
    .maybeSingle();

  if (!req || req.tenant_id !== me.tenant_id) {
    return NextResponse.json({ error: "That request no longer exists." }, { status: 404 });
  }
  if (req.status !== "pending_approval") {
    return NextResponse.json(
      { error: `That request was already ${req.status === "approved" ? "approved" : "rejected"}.` },
      { status: 409 },
    );
  }

  // ── Reject: record the decision and stop. Nothing else changes. ─────────
  if (parsed.data.action === "reject") {
    await admin
      .from("join_requests")
      .update({ status: "rejected", decided_at: new Date().toISOString(), decided_by: authData.user.id })
      .eq("id", req.id);
    return NextResponse.json({ ok: true, action: "rejected", email: req.email });
  }

  // ── Approve ────────────────────────────────────────────────────────────
  if (!req.auth_user_id) {
    return NextResponse.json(
      {
        error:
          "This request has no sign-in account attached, so there is nobody to add yet. " +
          "Invite them from Team → Invite teammate and ask them to sign in once.",
      },
      { status: 409 },
    );
  }

  // Whitelist, not passthrough — see the header.
  const asked = parsed.data.role ?? "";
  const role: InvitableRole = (INVITABLE_ROLES as readonly string[]).includes(asked)
    ? (asked as InvitableRole)
    : "support";

  const { data: already } = await admin
    .from("users")
    .select("id, tenant_id")
    .eq("id", req.auth_user_id)
    .maybeSingle();

  if (already?.tenant_id && already.tenant_id !== me.tenant_id) {
    return NextResponse.json(
      {
        error:
          `${req.email} already belongs to another workspace. ` +
          `Use "Claim a colleague" on the Team page — that path checks whether their old workspace can be safely removed.`,
      },
      { status: 409 },
    );
  }

  if (!already) {
    const name = req.full_name?.trim() || req.email.split("@")[0];
    const { error: insErr } = await admin.from("users").insert({
      id:        req.auth_user_id,
      tenant_id: me.tenant_id,
      email:     req.email,
      full_name: name,
      initials:  initials(name),
      role,
      color:     "indigo",
    });
    if (insErr) {
      console.error("[join-requests] approve insert failed:", insErr.message);
      return NextResponse.json({ error: "Could not add them. Please try again." }, { status: 500 });
    }
  }

  await admin
    .from("join_requests")
    .update({ status: "approved", decided_at: new Date().toISOString(), decided_by: authData.user.id })
    .eq("id", req.id);

  // A pending invite for the same person is now moot; closing it keeps the
  // Team page from showing them as both "invited" and "member".
  await admin
    .from("team_invites")
    .update({ accepted_at: new Date().toISOString() })
    .eq("email", req.email)
    .is("accepted_at", null);

  await admin.from("activity_log").insert({
    tenant_id: me.tenant_id,
    user_id:   authData.user.id,
    action:    "approved",
    entity:    "user",
    entity_id: req.auth_user_id,
    label:     `Approved ${req.email} as ${role}`,
  });

  return NextResponse.json({ ok: true, action: "approved", email: req.email, role });
}
