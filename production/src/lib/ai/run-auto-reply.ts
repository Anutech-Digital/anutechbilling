/**
 * ⚠ SUPERSEDED 24 AUG 2026 — NOTHING CALLS THIS ANY MORE.
 *
 * The inbound-email webhook now calls `lib/ai/run-sales-agent.ts` on both branches instead.
 * That was a swap rather than an addition: two drafters on one webhook means two replies to
 * one customer. Verified after the change — no non-test file imports this module.
 *
 * It is kept, not deleted, for two reasons. Its tests (auto-reply.test.ts, human-touch.test.ts)
 * still pin behaviour the replacement REUSES — `decideAutoReply` is called unchanged by the new
 * path, and human-touch.test.ts asserts on this file's source shape to protect the
 * `created_by IS NOT NULL` fix. And if the agent is rolled back, this is what it rolls back to.
 *
 * Deleting it is a decision for Pardeep, not a cleanup. Until then this banner is here so the
 * next reader does not spend an afternoon debugging a file that cannot run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Step 2, joined up: draft a reply, decide whether it may go, send it or file it.
 *
 * Called fire-and-forget from the inbound webhook. Nothing here may fail the request — the
 * lead and the message are committed before this runs, and losing a captured enquiry to
 * protect an email would be the wrong trade (the provider would retry, the messageId claim
 * would skip it as a duplicate, and the mail would be gone).
 *
 * ─── WHAT `hold` DOES, AND WHY IT IS THE DEFAULT ────────────────────────────
 * `reply.send` ships as `hold`, not `auto`, even though the machinery works. A brake was
 * built before the thing needing braking (AGENTS.md L63), and the same discipline applies to
 * the first automated sentence this app would ever write to a customer unattended: prepare
 * it, show it, let Pardeep watch the log for a few days, and let him move the dial himself
 * from /automation when he believes it.
 *
 * "Show it" is the part that would be easy to skip and would make the whole mode useless. A
 * held reply that only logged "held" would tell him it happened and never what it would have
 * said — so the draft is written onto the LEAD'S TIMELINE as a note, where he already looks,
 * and the audit log carries the decision. Content on the timeline, decisions in the log:
 * `buildAiActionRecord` redacts message bodies by key name precisely so the audit table does
 * not quietly become the second place customer mail accumulates.
 */
import { createBareClient } from "@/lib/supabase/bare";
import { sendEmail } from "@/lib/email/send";
import { resolveAutonomy } from "./autonomy";
import { loadAutonomyPolicy, logAiAction } from "./autonomy.server";
import { draftReplyForLead } from "./draft-reply.server";
import { decideAutoReply } from "./auto-reply";

function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export interface RunAutoReplyArgs {
  tenantId: string;
  leadId: string;
  /** Where the enquiry came from, and where a reply would go. */
  recipient: string;
  senderIsOurs: boolean;
  /** A marked self-test — lets the reply reach our own address, which is the point of one. */
  isSelfTest?: boolean;
  /** Envelope sender for this deployment. */
  fromEmail: string;
}

export async function runAutoReply(args: RunAutoReplyArgs): Promise<void> {
  const db = bare();
  if (!db) return;

  const note = async (detail: string) => {
    await db.from("lead_activities").insert({
      tenant_id: args.tenantId, lead_id: args.leadId, kind: "note", detail,
    });
  };

  const policy  = await loadAutonomyPolicy(args.tenantId);
  const verdict = resolveAutonomy("reply.send", policy);

  if (verdict.mode === "off") {
    /* No Gemini call at all. Drafting something nobody will see or send would spend a token
       budget and a customer's patience on nothing — and would put a draft in the timeline
       that looks like an offer somebody made. */
    await logAiAction({
      tenantId: args.tenantId, action: "reply.send", outcome: "skipped",
      reason: verdict.reason, mode: verdict.mode,
      entity: "lead", entityId: args.leadId,
    });
    return;
  }

  const drafted = await draftReplyForLead({ tenantId: args.tenantId, leadId: args.leadId });

  if (!drafted.ok) {
    /* The specific reason, not "draft failed". "AI drafting is not configured" is fixed on a
       settings page; "the AI did not return a reply" is a retry. Flattening them sends
       somebody to investigate an outage that is not happening. */
    await logAiAction({
      tenantId: args.tenantId, action: "reply.send", outcome: "failed",
      reason: `could not draft a reply — ${drafted.reason}`, mode: verdict.mode,
      entity: "lead", entityId: args.leadId,
    });
    return;
  }

  /* Has anything gone OUT since the customer's newest message? `reply_sent` rows are our own
     copies (lib/inbound/sent.ts), so one newer than their last inbound means this is already
     answered. Counted here rather than trusted from the webhook's idempotency, which is the
     WEBHOOK's guarantee and not this decision's. */
  const { data: outbound } = await db
    .from("inbound_emails")
    .select("id, created_at, status")
    .eq("tenant_id", args.tenantId)
    .eq("lead_id", args.leadId)
    .eq("status", "reply_sent")
    .order("created_at", { ascending: false })
    .limit(1);
  const { data: inboundLatest } = await db
    .from("inbound_emails")
    .select("created_at")
    .eq("tenant_id", args.tenantId)
    .eq("lead_id", args.leadId)
    .neq("status", "reply_sent")
    .order("created_at", { ascending: false })
    .limit(1);

  const lastOut = (outbound ?? [])[0] as { created_at?: string } | undefined;
  const lastIn  = (inboundLatest ?? [])[0] as { created_at?: string } | undefined;
  const alreadyReplied = Boolean(
    lastOut?.created_at && lastIn?.created_at && lastOut.created_at > lastIn.created_at,
  );

  /* Has a PERSON touched this thread since the customer wrote? A call logged, a note added,
     a draft opened. Somebody is on it, and a machine chiming in over a colleague mid-
     conversation is worse than silence.

     ─── A PERSON. NOT THIS APP'S OWN FOOTPRINTS ──────────────────────────────
     `created_by IS NOT NULL` is the whole fix, and without it this check answered a different
     question than it asks. Every automated write here leaves it NULL — the bare service-role
     client cannot know a user — while anything a human does goes through the
     `log_lead_activity` RPC, which stamps `auth.uid()`. Verified against live data before
     relying on it: call ×5, email ×3 and note ×6 all carry a `created_by`; note ×9,
     email_in ×14, email_out and quote are all NULL.

     What it cost: the inbound webhook writes its own `note` a fraction of a second after
     filing the customer's email — "No new quote from this reply — …" when the requote rule
     declines (route.ts:737) — or an `email_out` row when the auto-quote DOES go. Both land
     newer than the inbound message, both were counted, and both are this app. So on the
     second enquiry in a thread the reply would hold saying "a person has picked this thread
     up" when nobody had. Worse than a wrong outcome: a wrong REASON, which is what somebody
     reads when deciding whether to trust the automation at all — the same failure as
     AGENTS.md L97.

     It stayed hidden because the own-address rule is checked first and always fired first on
     the self-tests. Found by reading this path before asking Pardeep to re-run one, which
     would have produced exactly that misleading reason. */
  const { data: humanTouch } = await db
    .from("lead_activities")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("lead_id", args.leadId)
    .in("kind", ["call", "whatsapp", "note", "email_out"])
    .not("created_by", "is", null)
    .gt("created_at", lastIn?.created_at ?? "1970-01-01")
    .limit(1);
  const humanIsHandlingIt = (humanTouch ?? []).length > 0;

  const decision = decideAutoReply({
    senderIsOurs:       args.senderIsOurs,
    isSelfTest:         args.isSelfTest,
    theyWroteLast:      drafted.draft.theyWroteLast,
    alreadyReplied,
    humanIsHandlingIt,
    draft:              { subject: drafted.draft.subject, message: drafted.draft.message },
    draftIsForThisLead: !drafted.draft.usedTemplate,
  });

  /* Two gates, two questions, both required — the same shape as the auto-quote path.
     `decision` answers "is this reply safe to send"; `verdict.mode` answers "may this
     workspace send replies at all". A draft that passes the first and is held by the second
     is exactly what shadow mode is. */
  const mayGo = decision.send && verdict.mode === "auto";

  if (!mayGo) {
    const reason = !decision.send
      ? decision.reason
      : `the reply is safe to send, but replies are set to "${verdict.mode}" for this workspace`;

    /* The draft itself, on the timeline where an operator already looks. Without this, a
       held reply says it happened and never what it would have said — and shadow mode with
       nothing to look at is not a mode. */
    await note(
      `✍ AI drafted a reply and did NOT send it — ${reason}\n\n` +
      `Subject: ${drafted.draft.subject || "(none)"}\n\n${drafted.draft.message}`,
    );
    await logAiAction({
      tenantId: args.tenantId, action: "reply.send",
      /* `held` either way, and the ternary that used to be here returned "held" on both
         branches — a leftover from when the two cases had different outcomes. They do not:
         a reply the app prepared and did not send is held whether the promise rule stopped
         it or the dial did. The REASON separates them, and the reason is what gets read. */
      outcome: "held",
      reason, mode: verdict.mode,
      entity: "lead", entityId: args.leadId,
      /* The findings, not the text. `facts` redacts a `message` key by design, and the draft
         lives on the timeline instead. */
      facts: {
        recipient: args.recipient,
        promiseFound: decision.send ? null : (decision.findings?.[0]?.kind ?? null),
        promisePhrase: decision.send ? null : (decision.findings?.[0]?.matched ?? null),
      },
    });
    return;
  }

  const result = await sendEmail({
    to:      args.recipient,
    from:    args.fromEmail,
    subject: drafted.draft.subject || "Re: your enquiry",
    text:    drafted.draft.message,
    kind:    "auto_reply",
    route:   { tenantId: args.tenantId },
    /* The dial is consulted twice on purpose — here it is the CHOKEPOINT check, which also
        covers the kill switch having been flipped in the seconds since the read above. */
    /* logsItsOwnOutcome: this function writes its own did/failed row below, with the
       promise-check reason the chokepoint does not have. */
    automated: { tenantId: args.tenantId, action: "reply.send", logsItsOwnOutcome: true },
  });

  if (result.status === "failed") {
    await note(`AI reply to ${args.recipient} FAILED to send — ${result.errorMessage ?? "unknown error"}. The draft is above.`);
    await logAiAction({
      tenantId: args.tenantId, action: "reply.send", outcome: "failed",
      reason: `send failed — ${result.errorMessage ?? "unknown error"}`, mode: verdict.mode,
      entity: "lead", entityId: args.leadId,
      facts: { recipient: args.recipient },
    });
    return;
  }

  /* Filed as a real outbound message so the thread reads correctly and `alreadyReplied` is
     true for the next run. A reply that went out and was not recorded would be answered
     again by the next inbound message. */
  await db.from("inbound_emails").insert({
    tenant_id:  args.tenantId,
    lead_id:    args.leadId,
    status:     "reply_sent",
    from_email: null,
    to_email:   args.recipient,
    subject:    drafted.draft.subject || "Re: your enquiry",
    body_text:  drafted.draft.message,
  });

  await db.from("lead_activities").insert({
    tenant_id: args.tenantId, lead_id: args.leadId, kind: "email_out",
    detail: `AI replied automatically to ${args.recipient} — it promised nothing, so it was cleared to send.`,
  });

  await logAiAction({
    tenantId: args.tenantId, action: "reply.send", outcome: "did",
    reason: decision.reason, mode: verdict.mode,
    entity: "lead", entityId: args.leadId,
    facts: { recipient: args.recipient, subject: drafted.draft.subject },
  });
}
