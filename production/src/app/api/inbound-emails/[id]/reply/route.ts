/**
 * POST /api/inbound-emails/[id]/reply — answer an enquiry from the inbox.
 *
 * ─── THE TENANT COMES FROM THE SESSION, NEVER FROM THE BODY ─────────────────
 * Same posture as the sibling /state route, and it matters more here: this sends mail in
 * the reseller's name. A route that took the tenant from the request would let anyone with
 * the URL email a stranger's customers as that stranger.
 *
 * The enquiry is then loaded scoped by id AND tenant_id. The admin client bypasses RLS, so
 * an id on its own is a valid key to any row in the table — belt and braces.
 *
 * ─── THE RECIPIENT IS THE STORED SENDER, NOT ANYTHING THE CALLER SENDS ──────
 * The body carries a subject and a message. It does NOT carry a `to`, deliberately.
 * Accepting one would turn an authenticated inbox into an open relay sending from a
 * verified domain — the single most abusable shape an endpoint like this can have. The
 * address comes off the enquiry row and nowhere else.
 *
 * ─── THE REPLY IS RECORDED TWICE, ON PURPOSE ───────────────────────────────
 * sendEmail() writes `email_log` from inside itself (lib/email/log.ts says why the write
 * lives there and not at the call site). That row is the DELIVERY record: who, when, which
 * provider, and whether it actually left — including the attempts that did not.
 *
 * This route then writes a second row into `inbound_emails` carrying the TEXT, so the Sent
 * folder can show what was actually said. My first version skipped it on the argument that
 * two records can disagree, and that was wrong for a mail client: it left the screen able
 * to say "you replied on 18 Aug" and nothing more, which is not the fact anyone needs.
 *
 * They cannot disagree in the way that matters, because they answer different questions and
 * the delivery record is the one that decides. The text row is written only after a real
 * send, and never retried — see the comment at the insert.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { recordDraftFeedback } from "@/lib/ai/draft-feedback.server";
import { SENT_REPLY_STATUS } from "@/lib/inbound/sent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bodySchema = z.object({
  subject: z.string().trim().min(1).max(300),
  /* Long enough for a real reply, bounded so a paste-bomb cannot be relayed. */
  body:    z.string().trim().min(1).max(20_000),
  /**
   * The AI draft this send STARTED from, if it did — sent back by the composer, unedited.
   *
   * ─── WHY THE CLIENT SENDS IT AND THE SERVER DOES NOT LOOK IT UP ─────────────
   * The server cannot know. The draft was handed to the browser by /draft-reply and never
   * stored, and even if it had been, "the newest draft on this lead" is not the same thing
   * as "the text this person was editing" — a rep who drafted, went for lunch, and typed
   * something else would be recorded as having rewritten a draft they never saw.
   *
   * Nothing downstream trusts it: it is stored and compared, never sent, and never used to
   * decide anything. A client that lies here corrupts one row of hindsight and can do
   * nothing else, which is why the honest source is acceptable.
   *
   * Optional, so the existing composer and any other caller keep working untouched.
   */
  ai_draft_subject: z.string().trim().max(300).optional(),
  ai_draft_body:    z.string().trim().max(20_000).optional(),
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
  const { data: enquiry } = await admin
    .from("inbound_emails")
    .select("id, tenant_id, from_email, subject, lead_id")
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();

  if (!enquiry) {
    return NextResponse.json({ error: "That enquiry no longer exists." }, { status: 404 });
  }
  if (!enquiry.from_email) {
    /* §24 — say what is missing and what to do, never a bare refusal. */
    return NextResponse.json(
      { error: "This enquiry has no sender address, so there is nowhere to reply. Open the lead and add an email there." },
      { status: 422 },
    );
  }

  const sent = await sendEmail({
    to:      enquiry.from_email,
    subject: parsed.subject,
    text:    parsed.body,
    /* Routing context: if this tenant has connected their own Gmail, the reply leaves from
       their address rather than ours. Omitting it would silently send every reply through
       Resend — see lib/email/provider.ts. */
    route:   { tenantId: me.tenant_id },
    /* The label the screen reads back to decide whether this enquiry was answered. */
    kind:    "enquiry_reply",
  });

  if (sent.status === "failed") {
    return NextResponse.json(
      { error: sent.errorMessage ?? "The email could not be sent. Nothing was recorded, so you can try again." },
      { status: 502 },
    );
  }

  /* ─── AND THE REPLY IS KEPT, WITH ITS TEXT ───────────────────────────────────
     email_log records that a reply went and to whom, but not a word of it. That made
     the Sent folder a label over an empty room and left Pardeep asking "kaise pata
     chalega ki KYA reply send kiya hai". Knowing that you replied is not the useful
     fact; knowing what you said is.

     Written AFTER the send and best-effort: the customer has the email whatever happens
     next, so a failed insert must never turn into a second send. A missing row costs a
     line in the Sent folder; a duplicate email costs the customer's trust.

     Only a real send is filed. A stubbed attempt reached nobody, and a Sent folder that
     lists mail nobody received is the same lie in a different place. */
  /* ─── WHAT THE PERSON CHANGED, KEPT ─────────────────────────────────────────
     Only when this send started from an AI draft, and only after a real send. The agent does
     not learn from outcomes; a human reads these rows and edits the prompt. See
     lib/ai/draft-feedback.ts for why that is the whole loop.

     Awaited but never fatal — recordDraftFeedback swallows its own failures, because the
     customer has the email by now and a missing row of hindsight must not become a duplicate
     send. */
  if (sent.status === "sent" && parsed.ai_draft_body?.trim()) {
    await recordDraftFeedback({
      tenantId:     me.tenant_id,
      /* The dial this draft belonged to. /draft-reply is the operator-invoked drafter on the
         enquiry thread, which is the same permission the agent's own reply uses. */
      action:       "reply.send",
      entity:       "lead",
      /* The LEAD, not the enquiry: a thread can carry several enquiries and the thing being
         learned about is how the agent writes to this customer. Falls back to the enquiry id
         when the enquiry was never linked to a lead, so the row is still readable. */
      entityId:     enquiry.lead_id ?? enquiry.id,
      draftSubject: parsed.ai_draft_subject ?? null,
      draftBody:    parsed.ai_draft_body,
      sentSubject:  parsed.subject,
      sentBody:     parsed.body,
      sentBy:       user.id,
    });
  }

  let logged = false;
  if (sent.status === "sent") {
    const { error: logErr } = await admin.from("inbound_emails").insert({
      tenant_id:  me.tenant_id,
      /* The provider's own id keeps this idempotent against a retried request. */
      message_id: `reply:${sent.providerId ?? enquiry.id}`,
      /* No from_email: it left from the tenant's connected account, whose address is a
         property of the tenant and not of this row. `status` carries the direction. */
      from_email: null,
      to_email:   enquiry.from_email,
      subject:    parsed.subject,
      body_text:  parsed.body,
      status:     SENT_REPLY_STATUS,
      route:      "sales",
      lead_id:    enquiry.lead_id,
    });
    logged = !logErr;
  }

  return NextResponse.json({
    ok: true,
    /* "stubbed" means no mail provider is configured and NOTHING actually left. Reported so
       the screen can say so instead of showing a tick for an email nobody received. */
    stub: sent.status === "stubbed",
    provider: sent.provider,
    /* Reported rather than assumed, so the screen can say "sent, but not filed" instead of
       implying both worked. */
    logged,
  });
}

/**
 * GET — what has already been sent in answer to this enquiry.
 *
 * Read out of email_log rather than a `replied_at` flag, for the reason in
 * lib/inbound/replied.ts: a flag the app writes can disagree with whether an email
 * actually left, and the log records what the provider reported.
 *
 * ─── MATCHED ON RECIPIENT + KIND, AND THAT IS AN OVER-MATCH ─────────────────
 * email_log has no enquiry id, so two enquiries from the SAME address inside the same
 * period both see each other's replies. That is the honest direction to be wrong in: it
 * can say "you already replied" once too often, which costs a rep three seconds of
 * reading, where the opposite silently permits the duplicate this exists to prevent.
 */
export async function GET(_req: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });

  const { data: me } = await supabase
    .from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  if (!me?.tenant_id) return NextResponse.json({ replies: [] });

  const admin = createAdminClientFor(user.id);
  const { data: enquiry } = await admin
    .from("inbound_emails")
    .select("id, from_email, created_at")
    .eq("id", params.id)
    .eq("tenant_id", me.tenant_id)
    .maybeSingle();

  if (!enquiry?.from_email) return NextResponse.json({ replies: [] });

  const { data: rows } = await (admin as unknown as EmailLogReader)
    .from("email_log")
    .select("created_at, status, subject")
    .eq("tenant_id", me.tenant_id)
    .eq("recipient", enquiry.from_email)
    .eq("kind", "enquiry_reply")
    /* The window opens when the email arrived. Anything earlier is a different
       conversation — see lib/inbound/replied.ts. */
    .gte("created_at", enquiry.created_at)
    .order("created_at", { ascending: false })
    .limit(20);

  return NextResponse.json({
    replies: (rows ?? []).map((r) => ({
      sentAt:  r.created_at,
      status:  r.status,
      subject: r.subject,
    })),
  });
}

/**
 * email_log is not in the generated types yet (lib/email/log.ts says the same). Narrowed
 * to exactly the three columns read here rather than reached for with `any`, so a rename
 * in the table still shows up as a type error at this line.
 */
interface EmailLogReader {
  from(t: "email_log"): {
    select(cols: string): {
      eq(c: string, v: string): {
        eq(c: string, v: string): {
          eq(c: string, v: string): {
            gte(c: string, v: string): {
              order(c: string, o: { ascending: boolean }): {
                limit(n: number): Promise<{
                  data: { created_at: string; status: string; subject: string | null }[] | null;
                }>;
              };
            };
          };
        };
      };
    };
  };
}
