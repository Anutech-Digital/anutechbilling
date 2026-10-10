/**
 * GET /api/settings/email-sender — which address this workspace's mail leaves from.
 *
 * ─── WHY THIS EXISTS AS ITS OWN ROUTE ───────────────────────────────────────
 * Pardeep sent a reply from /enquiries and then went looking for it in sales@anutech.in.
 * It was never going there: the connected Google account is pardeep@anutech.in, so the
 * copy sits in THAT account's Sent folder, and the reply itself went to the customer. The
 * app knew all of this and showed none of it.
 *
 * The fact is not derivable in the browser. `tenants.gmail_sender_user_id` points at a
 * user row whose email lives in auth, and useCurrentUser deliberately does not widen its
 * select — one extra column on `tenants` is exactly what broke identity for every user
 * once already (PGRST201, see the header on useCurrentUser). So the server answers it.
 *
 * ─── AND IT NEVER GUESSES ───────────────────────────────────────────────────
 * If the tenant is on Resend, or has connected nothing, this returns a null address rather
 * than the signed-in user's own email. Sending an operator to hunt through the wrong
 * mailbox is worse than telling them we do not know which one it is.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { prismaPathEnabled } from "@/server/db/flags";
import { getTenantSession } from "@/server/auth/session";
import { emailSenderFor } from "@/server/settings/email-sender";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  // New path (RLS-scoped, no service-role key). See src/server/settings/email-sender.ts.
  if (prismaPathEnabled()) {
    const session = await getTenantSession();
    if (!session) return NextResponse.json({ provider: null, address: null });
    return NextResponse.json(await emailSenderFor(session));
  }

  // Old path — removed once DATABASE_URL is set everywhere (plan Phase 8).
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ provider: null, address: null });

  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ provider: null, address: null });

  const admin = createAdminClient();
  const { data: tenant } = await admin
    .from("tenants")
    .select("email_provider, gmail_sender_user_id")
    .eq("id", me.tenant_id)
    .maybeSingle();

  const provider = tenant?.email_provider ?? null;
  if (provider !== "gmail" || !tenant?.gmail_sender_user_id) {
    /* Resend sends from a domain, not a mailbox, so there is no Sent folder to point at.
       Saying "gmail is not connected" is more use than naming an address nobody can open. */
    return NextResponse.json({ provider, address: null });
  }

  const { data: sender } = await admin
    .from("users").select("email").eq("id", tenant.gmail_sender_user_id).maybeSingle();

  return NextResponse.json({ provider, address: sender?.email ?? null });
}
