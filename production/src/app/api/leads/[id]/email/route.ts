/**
 * POST /api/leads/[id]/email — write to a lead from inside the app, and KEEP what was written.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The lead drawer's Email button opened Gmail in a new tab and logged a one-line note —
 * "Emailed x@y · subject". The text was never stored anywhere, so the new Email thread on
 * the lead could show the customer's words and only a stub for ours. Asked on 22 Aug 2026
 * for a real two-sided conversation; a half thread reads as data loss, which is worse than
 * the honest note it replaced.
 *
 * Nothing here is new machinery. `lib/email/send.ts` already sends (via the tenant's own
 * connected Gmail when they have one — this tenant does), and
 * `api/inbound-emails/[id]/reply` already files sent text into `inbound_emails` so the Sent
 * folder can show it. This is that same pair, anchored on a LEAD instead of on an enquiry,
 * for the case where the customer has not written first and there is no enquiry to reply to.
 *
 * ─── THE TENANT COMES FROM THE SESSION, THE RECIPIENT FROM THE LEAD ─────────
 * Same posture as the reply route, and for the same reason: the body carries a subject and
 * a message and NO `to`. Accepting a recipient would turn an authenticated endpoint into an
 * open relay sending in the reseller's name from a verified domain — the single most
 * abusable shape this can have. The address is read off the lead row, which is itself loaded
 * scoped by id AND tenant_id, because the admin client bypasses RLS and an id alone would
 * otherwise be a valid key to any row in the table.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { SENT_REPLY_STATUS } from "@/lib/inbound/sent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  subject: z.string().trim().min(1).max(300),
  /* Long enough for a real first email, bounded so a paste-bomb cannot be relayed. */
  body:    z.string().trim().min(1).max(20_000),
});

export async function POST(req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  }

  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) {
    return NextResponse.json(
      { error: "Your account is not linked to a workspace yet — an owner can claim it on the Team page." },
      { status: 403 },
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "A subject and a message are both required." }, { status: 400 });
  }

  const admin = createAdminClientFor(user.id);
  const { data: lead } = await admin
    .from("leads")
    .select("id, tenant_id, company, contact_email")
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();

  if (!lead) {
    return NextResponse.json({ error: "That lead no longer exists." }, { status: 404 });
  }
  if (!lead.contact_email) {
    /* §24 — what is missing and where to fix it, never a bare refusal. */
    return NextResponse.json(
      { error: "This lead has no email address, so there is nowhere to send. Open the lead and add one with Edit." },
      { status: 422 },
    );
  }

  const sent = await sendEmail({
    to:      lead.contact_email,
    subject: parsed.subject,
    text:    parsed.body,
    /* Routing context. Without it every message would go through Resend from our domain
       instead of the tenant's own connected Gmail — see lib/email/provider.ts. The customer
       seeing a different sender than the one they replied to last time is a real cost. */
    route:   { tenantId: me.tenant_id },
    kind:    "lead_email",
  });

  if (sent.status === "failed") {
    /* Nothing filed, so the operator can press send again without risking a duplicate. */
    return NextResponse.json(
      { error: sent.errorMessage ?? "The email could not be sent. Nothing was recorded, so you can try again." },
      { status: 502 },
    );
  }

  /* ─── AND THE TEXT IS KEPT ───────────────────────────────────────────────────
     Written AFTER the send and best-effort, exactly as the reply route does it: the
     customer has the email whatever happens next, so a failed insert must never become a
     second send. A missing row costs a line in the thread; a duplicate email costs the
     customer's trust.

     Only a real send is filed. A stubbed attempt reached nobody, and a thread that lists
     mail nobody received is the same lie in a different place. */
  let logged = false;
  if (sent.status === "sent") {
    const { error: logErr } = await admin.from("inbound_emails").insert({
      tenant_id:  me.tenant_id,
      /* The provider's own id keeps this idempotent against a retried request. */
      message_id: `lead-email:${sent.providerId ?? `${lead.id}:${Date.now()}`}`,
      /* No from_email: it left from the tenant's connected account, whose address belongs
         to the tenant and not to this row. `status` carries the direction. */
      from_email: null,
      to_email:   lead.contact_email,
      subject:    parsed.subject,
      body_text:  parsed.body,
      status:     SENT_REPLY_STATUS,
      route:      "sales",
      lead_id:    lead.id,
    });
    logged = !logErr;
  }

  return NextResponse.json({
    ok: true,
    /* "stubbed" means no provider is configured and NOTHING left. Reported so the screen
       can say so rather than showing a tick for an email nobody received. */
    stub: sent.status === "stubbed",
    provider: sent.provider,
    /* Reported rather than assumed, so the screen can say "sent, but not filed" instead of
       implying both worked. */
    logged,
  });
}
