/**
 * POST /api/team/members/[id]/temp-password   { password?: string }
 *
 * R-391 (7 Oct 2026). An owner sets a TEMPORARY password for a teammate so they can sign in
 * today without waiting for a reset email. Design and what it grants: lib/auth/temp-password.ts.
 *
 * Order matters and is pinned by route.test.ts:
 *   1. signed in (401), rate limit per caller (429)
 *   2. caller AND target re-read from public.users with the admin client — the target only
 *      within the caller's tenant — and decideTempPassword() refuses non-owners, other
 *      workspaces, owners and yourself (403). Nothing from the client is trusted for this.
 *   3. password: owner-typed (≥8, normal rules) or generated (16 random chars)
 *   4. audit row FIRST (activity_log: who, whom, when — never the password). If it cannot be
 *      written the password is not changed, so there is no unaudited change.
 *   5. auth admin update with the service role: password + app_metadata.must_change_password
 *      (works on GoTrue and on R-161's Auth.js store — both merge app_metadata).
 *   6. the password goes back ONCE in this response (no-store) for the copy button. It is not
 *      logged, stored in any table, or put in a URL.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { rateLimitShared } from "@/lib/security/rate-limit";
import {
  TEMP_PASSWORD_RATE,
  checkTypedTempPassword,
  decideTempPassword,
  generateTempPassword,
} from "@/lib/auth/temp-password";
import { MUST_CHANGE_PASSWORD_KEY } from "@/lib/auth/must-change-password";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ password: z.string().max(128).optional() }).strict();

const fail = (error: string, status: number, headers: Record<string, string> = {}) =>
  NextResponse.json({ error }, { status, headers: { ...NO_STORE, ...headers } });

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id: targetId } = await props.params;

  const { data: authData } = await createClient().auth.getUser();
  const callerId = authData?.user?.id;
  if (!callerId) return fail("Please sign in again.", 401);

  const rl = await rateLimitShared(`team-temp-pw:${callerId}`, TEMP_PASSWORD_RATE);
  if (!rl.ok) {
    return fail("Too many temporary passwords in the last hour. Try again later.", 429, { "Retry-After": String(rl.retryAfterSec) });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return fail("Send either nothing or { password }.", 400);

  const admin = createAdminClientFor(callerId);
  const { data: caller } = await admin
    .from("users")
    .select("id, role, tenant_id, is_active")
    .eq("id", callerId)
    .maybeSingle();

  /* The target is looked up INSIDE the caller's tenant only. A malformed id or one from
     another workspace both come back null and get the same 403 — no existence oracle. */
  let target: { id: string; role: string | null; tenant_id: string | null; email: string | null } | null = null;
  if (caller?.tenant_id && UUID.test(targetId)) {
    const { data } = await admin
      .from("users")
      .select("id, role, tenant_id, email")
      .eq("id", targetId)
      .eq("tenant_id", caller.tenant_id)
      .maybeSingle();
    target = data ?? null;
  }

  const decision = decideTempPassword(caller ?? null, target);
  if (!decision.ok) return fail(decision.error, decision.status);
  if (!caller?.tenant_id || !target) return fail("That person is not in your workspace.", 403); // narrows types

  /* R-2477: a login can now belong to several companies (memberships). A temporary password is a
     password for the whole LOGIN — with it this owner could sign in as them and open their OTHER
     company (maybe as its owner). So it is only for a login that works in no other company. */
  /* tenant_memberships (R-2471) is not in the generated types yet — a narrow shape, not `any`. */
  type MembershipQ = {
    select(c: string): MembershipQ; eq(c: string, v: string): MembershipQ; neq(c: string, v: string): MembershipQ;
    is(c: string, v: null): MembershipQ;
    limit(n: number): PromiseLike<{ data: Array<{ tenant_id: string }> | null; error: { message: string } | null }>;
  };
  const { data: elsewhere, error: elsewhereErr } = await (admin.from as unknown as (t: "tenant_memberships") => MembershipQ)
    .call(admin, "tenant_memberships")
    .select("tenant_id")
    .eq("user_id", target.id)
    .neq("tenant_id", caller.tenant_id)
    .is("ended_at", null)
    .limit(1);
  if (elsewhereErr) {
    return fail("Could not check whether they work in another company, so no password was set. Try again.", 500);
  }
  /* R-2477 re-review: an OPEN invite from another company is the same lever — with the password
     this owner could sign in as them and accept that invite (maybe as owner). Same rule as the
     users.email guard (migration 20261105192420). */
  type InviteQ = {
    select(c: string): InviteQ; eq(c: string, v: string): InviteQ; neq(c: string, v: string): InviteQ;
    is(c: string, v: null): InviteQ; gt(c: string, v: string): InviteQ;
    limit(n: number): PromiseLike<{ data: Array<{ tenant_id: string }> | null; error: { message: string } | null }>;
  };
  const { data: invitedElsewhere, error: invitedErr } = await (admin.from as unknown as (t: "membership_invites") => InviteQ)
    .call(admin, "membership_invites")
    .select("tenant_id")
    .eq("user_id", target.id)
    .neq("tenant_id", caller.tenant_id)
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .limit(1);
  if (invitedErr) {
    return fail("Could not check whether they are invited to another company, so no password was set. Try again.", 500);
  }
  if ((elsewhere ?? []).length > 0 || (invitedElsewhere ?? []).length > 0) {
    return fail(
      "They also work in (or are invited to) another company on ResellerOS, so only they can change their password. Next step: use Send reset link on their row, or ask them to use Forgot password on the sign-in page.",
      409,
    );
  }

  const typed = parsed.data.password;
  let password: string;
  if (typed !== undefined && typed !== "") {
    const problem = checkTypedTempPassword(typed);
    if (problem) return fail(problem.message, 422);
    password = typed;
  } else {
    password = generateTempPassword();
  }

  const who = target.email ?? target.id;
  const { data: audit, error: auditErr } = await admin
    .from("activity_log")
    .insert({
      tenant_id: caller.tenant_id,
      user_id:   callerId,
      action:    "temp_password_set",
      entity:    "user",
      entity_id: target.id,
      label:     `Temporary password set for ${who} (must change at next sign-in)`,
    })
    .select("id")
    .single();
  if (auditErr || !audit) {
    return fail("Could not write the audit record, so the password was not changed. Try again.", 500);
  }

  const { error: upErr } = await admin.auth.admin.updateUserById(target.id, {
    password,
    app_metadata: {
      [MUST_CHANGE_PASSWORD_KEY]: true,
      temp_password_set_at: new Date().toISOString(),
      temp_password_set_by: callerId,
    },
  });
  if (upErr) {
    await admin
      .from("activity_log")
      .update({ action: "temp_password_failed", label: `Temporary password for ${who} NOT set — ${upErr.message}`.slice(0, 300) })
      .eq("id", audit.id);
    return fail(`Could not set the password: ${upErr.message}`, 500);
  }

  return NextResponse.json(
    { ok: true, password, email: target.email, mustChange: true },
    { headers: NO_STORE },
  );
}
