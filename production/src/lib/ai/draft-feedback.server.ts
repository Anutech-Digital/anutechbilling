/**
 * Writing the draft-vs-sent pair. The comparison itself lives in `draft-feedback.ts` and is pure.
 *
 * Bare client for the same measured reason as the other AI tables: `ai_draft_feedback` is not
 * in the generated `Database` type, and registering a table is not a two-line fix — measured
 * 23 Aug 2026 on `document_series`, adding ONE took `npm run typecheck` from 4 errors to
 * 2,722, because supabase-js resolves row types through a conditional chain that tips over the
 * instantiation limit at this schema size.
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER. The insert below carries
 * `tenant_id` explicitly and it always comes from the caller's resolved session, never from a
 * request body.
 */
import { createBareClient } from "@/lib/supabase/bare";
import { summariseEdit } from "./draft-feedback";

function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export interface RecordDraftFeedbackArgs {
  tenantId: string;
  /** Which dial's draft this was — reply.send, followup.send, support.reply.send. */
  action: string;
  entity: "lead" | "support_ticket";
  entityId: string;
  /** What the agent produced. Empty or absent means the send did not start from a draft. */
  draftSubject?: string | null;
  draftBody?: string | null;
  /** What the customer actually received. */
  sentSubject: string;
  sentBody: string;
  /** The user who pressed send. Part of the signal — see the migration header. */
  sentBy?: string | null;
}

/**
 * Record what the person changed. Never throws, and never blocks the caller.
 *
 * ─── IT MUST NOT BE ABLE TO BREAK A SEND ────────────────────────────────────
 * The customer already has the email by the time this runs. A failed insert costs one row of
 * hindsight; a failed request costs the operator a duplicate send while they work out whether
 * the first one went. Same posture as the `email_log` write and the `ai_action_log` write, and
 * for the same reason.
 *
 * ─── NO DRAFT MEANS NO ROW ──────────────────────────────────────────────────
 * A rep writing from scratch produces nothing here, deliberately: there is no draft to have
 * an opinion about, and inserting a row with an empty `draft_body` would make every "how often
 * was the draft good enough" query silently wrong by counting sends the agent never touched.
 */
export async function recordDraftFeedback(args: RecordDraftFeedbackArgs): Promise<void> {
  const draft = (args.draftBody ?? "").trim();
  if (!draft) return;

  const summary = summariseEdit(draft, args.sentBody);

  const db = bare();
  if (!db) {
    console.error("[draft-feedback] Supabase is not configured — nothing recorded", {
      entity: args.entity,
      entityId: args.entityId,
      verdict: summary.verdict,
    });
    return;
  }

  try {
    const { error } = await db.from("ai_draft_feedback").insert({
      tenant_id: args.tenantId,
      action: args.action,
      entity: args.entity,
      entity_id: args.entityId,
      draft_subject: args.draftSubject ?? null,
      draft_body: draft,
      sent_subject: args.sentSubject,
      sent_body: args.sentBody,
      verdict: summary.verdict,
      similarity: summary.similarity,
      words_added: summary.wordsAdded,
      words_removed: summary.wordsRemoved,
      sent_by: args.sentBy ?? null,
    });
    /* Logged with the VERDICT, not just the error. When this table is empty and somebody asks
       why, the console is the only place that can say "it ran and the insert was refused"
       rather than leaving "it never ran" and "it ran and failed" looking identical. */
    if (error) {
      console.error("[draft-feedback] insert failed:", error.message, {
        entity: args.entity,
        entityId: args.entityId,
        verdict: summary.verdict,
      });
    }
  } catch (err) {
    console.error("[draft-feedback] insert crashed:", err);
  }
}
