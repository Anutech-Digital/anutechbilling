/**
 * POST /api/integrations/email-provider/test — send one email to yourself.
 *
 * ─── IT CAN ONLY EVER EMAIL THE CALLER ───────────────────────────────────────
 * The recipient is taken from the session, never from the request body. That is
 * the whole safety property: this endpoint cannot be pointed at a customer by
 * anyone, including by a bug in a form I write later, and it cannot become a
 * relay if the URL leaks. A test button that accepts a `to` parameter is one
 * typo away from mailing a real customer a message that says "test".
 *
 * ─── IT PROVES THE WHOLE PATH, NOT A PIECE OF IT ─────────────────────────────
 * It goes through sendEmail with the tenant's `route`, so it exercises exactly
 * what a renewal reminder does: the provider decision, the Gmail token and its
 * scopes, the actual API call, and the email_log write. A test that bypassed any
 * of those would pass while the real thing failed — which is the failure mode
 * this whole day has been about.
 */
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { sendInternalEmail } from "@/lib/messaging";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { data: me } = await supabase
    .from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json({ error: "No tenant." }, { status: 403 });
  }
  if (me.role !== "owner") {
    return NextResponse.json({ error: "Only the workspace owner can send a test." }, { status: 403 });
  }

  const stamp = new Date().toISOString();

  const result = await sendInternalEmail({
    to: user.email,              // ← session, never the body
    subject: `ResellerOS test email · ${stamp.slice(0, 16).replace("T", " ")} UTC`,
    text:
      `This is a test from ResellerOS.\n\n`
      + `If you are reading it, outbound email works: the provider was reachable, `
      + `the credentials were accepted, and the message left the building.\n\n`
      + `What this does NOT prove: that mail reaches customers whose addresses are `
      + `wrong or whose servers reject you. "Sent" means the provider accepted the `
      + `message, not that it arrived.\n\n`
      + `Sent at ${stamp}\n`,
    kind: "test",
    route: { tenantId: me.tenant_id, messageClass: "transactional" },
  });

  // The provider's own error text is passed through rather than replaced. When
  // Gmail refuses, its message names the reason (scope, revoked grant, quota) —
  // and that sentence is the difference between fixing it and guessing.
  return NextResponse.json({
    ok: result.status === "sent",
    status: result.status,
    provider: result.provider,
    sentTo: user.email,
    providerId: result.providerId,
    error: result.errorMessage,
    note: result.status === "stubbed"
      ? "Nothing was actually sent — the app is in stub mode, which logs instead of sending."
      : null,
  });
}
