/**
 * The one door every outbound AI call goes through.
 *
 * ─── WHY THIS FILE EXISTS AT ALL ────────────────────────────────────────────
 * `sendEmail` is the chokepoint for mail: pass `automated` and it resolves the dial, logs the
 * outcome and refuses when the kill switch is on. Voice has no such chokepoint — `placeCall`
 * posts straight to Retell or Vapi, exactly as `sendWhatsApp` posts straight to Meta. An agent
 * that respected the brake on email and ignored it on the phone would be a brake in name only,
 * and the kill switch is what somebody reaches for when a wrong price has already gone out.
 *
 * So the dial is resolved HERE, before the vendor is asked, in the same shape
 * `quote-dispatcher.ts` uses for WhatsApp — and `telecall-chokepoint.test.ts` pins that
 * ordering on the source, because "does this call site resolve the dial first" reads in the
 * source and not at all in a mock.
 *
 * ─── WHAT `hold` MEANS HERE ─────────────────────────────────────────────────
 * Not "do nothing". The number is resolved, the catalogue is read, the script and the dynamic
 * variables are built in full, and all of it is written to `ai_telecall_logs` with status
 * `held`. The operator opens that row, reads exactly what would have been said and to whom,
 * and rings by hand. The feature is useful at hold, which is what stops anybody moving the
 * dial merely to get value out of it — the same bargain `support.reply.send` made.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { resolveAutonomy } from "../autonomy";
import { loadAutonomyPolicy, logAiAction } from "../autonomy.server";
import { buildTelecallPrompt } from "../telecaller-prompt";
import { decideTelecall, type TelecallType } from "../telecall";
import { callHistoryFor, recordTelecall } from "../telecall.server";
import {
  missingTelecallEnv,
  placeCall,
  resolveTelecallProvider,
} from "@/lib/telecall/provider";
import type { SalesCatalogEntry } from "../sales-agent";

/* Typed as the RETURN of createAdminClient — hand-rolling this shape is what produced the
   TS2589 "excessively deep" failure in lib/email/owner-alert.ts. */
type Admin = ReturnType<typeof createAdminClient>;

export interface TelecallDispatchArgs {
  admin: Admin;
  tenantId: string;
  callType: TelecallType;
  /** One of these two is set; the schema refuses a row with neither. */
  leadId: string | null;
  subscriptionId: string | null;
  /** As recorded — free text, normalised inside decideTelecall. */
  rawPhone: string | null;
  customerName: string | null;
  currentPlan: string | null;
  seats: number | null;
  /** Renewal calls only. */
  renewalDate: string | null;
  pendingAmount: number | null;
  /** Read from `items` at call time. Never a literal — see telecaller-prompt.ts's header. */
  catalogue: readonly SalesCatalogEntry[];
  sellerName: string;
  /** Our own numbers, so nothing dials back to us. */
  ourNumbers: readonly string[];
  doNotCall: boolean;
  /**
   * R-1437: a person pressed "AI call" on this lead. Their press IS the approval a `hold` dial
   * waits for, so `hold` becomes `auto` for this one call. The workspace kill switch (`off`) is
   * still obeyed — a person cannot dial past "automation is switched off".
   */
  humanApproved?: { userName: string } | null;
  subjectIsOpen: boolean;
  subjectClosedReason: string | null;
  /** Passed in so the decision is testable at 21:01 on a Saturday. */
  now: Date;
}

export interface TelecallDispatchResult {
  outcome: "queued" | "held" | "refused" | "failed";
  /** One sentence a non-engineer can act on. */
  detail: string;
  /** The `ai_telecall_logs` row, when one could be written. */
  callLogId: string | null;
}

/**
 * Note the attempt on the lead's own timeline.
 *
 * The call row holds the detail; this is the line a rep sees while scrolling the lead. Never
 * throws — a timeline note that fails must not take the call decision with it.
 */
async function noteOnTimeline(args: TelecallDispatchArgs, detail: string): Promise<void> {
  if (!args.leadId) return;
  try {
    await args.admin.from("lead_activities").insert({
      tenant_id: args.tenantId,
      lead_id: args.leadId,
      kind: "note",
      detail,
    });
  } catch (err) {
    console.error("[telecall-dispatcher] timeline note failed:", err);
  }
}

/**
 * Decide, record, and only then possibly dial.
 *
 * Never throws. Every caller is a route or a cron, and neither may fail because a telephony
 * vendor was slow.
 */
export async function dispatchTelecall(
  args: TelecallDispatchArgs,
): Promise<TelecallDispatchResult> {
  try {
    /* ── 1. THE BRAKE, BEFORE ANYTHING ELSE ──────────────────────────────────
       Resolved first so the kill switch outranks every other consideration, and so a switched-
       off workspace never has its catalogue read or its vendor contacted. */
    const policy = await loadAutonomyPolicy(args.tenantId);
    const policyVerdict = resolveAutonomy("telecall.place", policy);
    const verdict =
      args.humanApproved && policyVerdict.mode === "hold"
        ? { mode: "auto" as const, reason: `${args.humanApproved.userName} pressed AI call on this lead` }
        : policyVerdict;

    /* ── 2. May we ring this person at all? ──────────────────────────────────
       Run once with an EMPTY history, purely to normalise the number and to catch the
       refusals that do not depend on history at all — no number, our own number, a closed
       subject, a do-not-call. The history query below is keyed by the normalised number, so
       it cannot run before this. */
    const decision = decideTelecall({
      callType: args.callType,
      rawPhone: args.rawPhone,
      at: args.now,
      lastCalledAt: null,
      attemptsSoFar: 0,
      ourNumbers: args.ourNumbers,
      doNotCall: args.doNotCall,
      subjectIsOpen: args.subjectIsOpen,
      subjectClosedReason: args.subjectClosedReason,
    });

    if (!decision.phone) {
      /* No dialable number means no row can be written: `phone_number` is NOT NULL and CHECKed
         against E.164, and inventing a placeholder to satisfy the column would put a number in
         the log that nobody ever rang. The lead's timeline carries it instead. */
      await noteOnTimeline(args, `No AI call placed — ${decision.reason}`);
      await logAiAction({
        tenantId: args.tenantId, action: "telecall.place", outcome: "skipped",
        reason: decision.reason, mode: verdict.mode,
        entity: args.leadId ? "lead" : "subscription",
        entityId: args.leadId ?? args.subscriptionId,
      });
      return { outcome: "refused", detail: decision.reason, callLogId: null };
    }

    /* History is read only once a number exists to read it against — it is keyed by number,
       not by lead. Re-decided with the real history rather than patched, so there is one
       decision function and one set of rules. */
    const history = await callHistoryFor(args.tenantId, decision.phone);
    const finalDecision = decideTelecall({
      callType: args.callType,
      rawPhone: args.rawPhone,
      at: args.now,
      lastCalledAt: history.lastCalledAt,
      attemptsSoFar: history.attempts,
      ourNumbers: args.ourNumbers,
      doNotCall: args.doNotCall,
      subjectIsOpen: args.subjectIsOpen,
      subjectClosedReason: args.subjectClosedReason,
    });

    /* ── 3. Build the whole call, whatever the dial says ─────────────────── */
    const built = buildTelecallPrompt({
      callType: args.callType,
      sellerName: args.sellerName,
      customerName: args.customerName,
      currentPlan: args.currentPlan,
      seats: args.seats,
      renewalDate: args.renewalDate,
      pendingAmount: args.pendingAmount,
      catalogue: args.catalogue,
    });

    const callPlan: Record<string, unknown> = {
      dynamic_variables: built.dynamicVariables,
      authorised_figures: built.authorisedFigures,
      system_prompt: built.systemPrompt,
      decided_at: args.now.toISOString(),
      autonomy_reason: verdict.reason,
    };

    if (!finalDecision.place) {
      const detail = finalDecision.reason;
      const written = await recordTelecall({
        tenantId: args.tenantId,
        leadId: args.leadId,
        subscriptionId: args.subscriptionId,
        callType: args.callType,
        phoneNumber: decision.phone,
        status: "refused",
        provider: "none",
        providerCallId: null,
        callPlan,
        autonomyMode: verdict.mode,
        refusalReason: detail,
      });
      await noteOnTimeline(args, `No AI call placed — ${detail}`);
      await logAiAction({
        tenantId: args.tenantId, action: "telecall.place", outcome: "skipped",
        reason: detail, mode: verdict.mode,
        entity: args.leadId ? "lead" : "subscription",
        entityId: args.leadId ?? args.subscriptionId,
      });
      return { outcome: "refused", detail, callLogId: written.id };
    }

    /* ── 4. THE DIAL ─────────────────────────────────────────────────────── */
    if (verdict.mode !== "auto") {
      const detail =
        `AI call prepared for ${decision.phone} but not placed — ${verdict.reason}. ` +
        "The script and the figures it was allowed to quote are on the call record; ring by " +
        "hand, or turn this on at /automation.";
      const written = await recordTelecall({
        tenantId: args.tenantId,
        leadId: args.leadId,
        subscriptionId: args.subscriptionId,
        callType: args.callType,
        phoneNumber: decision.phone,
        status: "held",
        provider: "none",
        providerCallId: null,
        callPlan,
        autonomyMode: verdict.mode,
        refusalReason: verdict.reason,
      });
      await noteOnTimeline(args, detail);
      await logAiAction({
        tenantId: args.tenantId, action: "telecall.place",
        /* `held` and `skipped` are different queues: one is waiting on a person, the other is
           not going to happen. send.ts draws the same line for exactly this reason. */
        outcome: verdict.mode === "hold" ? "held" : "skipped",
        reason: verdict.reason, mode: verdict.mode,
        entity: args.leadId ? "lead" : "subscription",
        entityId: args.leadId ?? args.subscriptionId,
      });
      return { outcome: "held", detail, callLogId: written.id };
    }

    /* ── 5. Auto. Only now is a vendor contacted. ────────────────────────── */
    const provider = resolveTelecallProvider();
    if (!provider) {
      const missing = missingTelecallEnv().join(", ");
      const detail =
        `AI calling is switched on but no telephony account is configured — ${missing} ` +
        "is not set on this deployment, so nothing was dialled.";
      const written = await recordTelecall({
        tenantId: args.tenantId,
        leadId: args.leadId,
        subscriptionId: args.subscriptionId,
        callType: args.callType,
        phoneNumber: decision.phone,
        status: "failed",
        provider: "none",
        providerCallId: null,
        callPlan,
        autonomyMode: verdict.mode,
        refusalReason: detail,
      });
      await noteOnTimeline(args, detail);
      await logAiAction({
        tenantId: args.tenantId, action: "telecall.place", outcome: "failed",
        reason: detail, mode: verdict.mode,
        entity: args.leadId ? "lead" : "subscription",
        entityId: args.leadId ?? args.subscriptionId,
      });
      return { outcome: "failed", detail, callLogId: written.id };
    }

    const placed = await placeCall(provider, {
      toNumber: decision.phone,
      systemPrompt: built.systemPrompt,
      dynamicVariables: built.dynamicVariables,
      /* Echoed back by both vendors on the post-call webhook. The tenant id travels with the
         call so the webhook never has to take one from its own request body — a webhook that
         trusts a body-supplied tenant_id is a cross-tenant write waiting to happen. */
      metadata: {
        tenant_id: args.tenantId,
        call_type: args.callType,
        lead_id: args.leadId ?? "",
        subscription_id: args.subscriptionId ?? "",
      },
    });

    if (!placed.ok) {
      const written = await recordTelecall({
        tenantId: args.tenantId,
        leadId: args.leadId,
        subscriptionId: args.subscriptionId,
        callType: args.callType,
        phoneNumber: decision.phone,
        status: "failed",
        provider: provider.name,
        providerCallId: null,
        callPlan,
        autonomyMode: verdict.mode,
        refusalReason: placed.error,
      });
      await noteOnTimeline(args, `AI call could not be placed — ${placed.error}`);
      await logAiAction({
        tenantId: args.tenantId, action: "telecall.place", outcome: "failed",
        reason: placed.error, mode: verdict.mode,
        entity: args.leadId ? "lead" : "subscription",
        entityId: args.leadId ?? args.subscriptionId,
      });
      return { outcome: "failed", detail: `The call could not be placed — ${placed.error}`, callLogId: written.id };
    }

    const written = await recordTelecall({
      tenantId: args.tenantId,
      leadId: args.leadId,
      subscriptionId: args.subscriptionId,
      callType: args.callType,
      phoneNumber: decision.phone,
      status: "queued",
      provider: provider.name,
      providerCallId: placed.providerCallId,
      callPlan,
      autonomyMode: verdict.mode,
      refusalReason: null,
    });

    const detail = `AI call placed to ${decision.phone} — ${verdict.reason}.`;
    await noteOnTimeline(args, detail);
    await logAiAction({
      tenantId: args.tenantId, action: "telecall.place", outcome: "did",
      reason: verdict.reason, mode: verdict.mode,
      entity: args.leadId ? "lead" : "subscription",
      entityId: args.leadId ?? args.subscriptionId,
      facts: { provider: provider.name, provider_call_id: placed.providerCallId },
    });

    return { outcome: "queued", detail, callLogId: written.id };
  } catch (err) {
    const why = err instanceof Error ? err.message : "unknown error";
    console.error("[telecall-dispatcher] crashed:", err);
    await logAiAction({
      tenantId: args.tenantId, action: "telecall.place", outcome: "failed",
      reason: `The telecall dispatcher crashed: ${why}`, mode: "hold",
      entity: args.leadId ? "lead" : "subscription",
      entityId: args.leadId ?? args.subscriptionId,
    }).catch(() => undefined);
    return { outcome: "failed", detail: `The AI telecaller crashed — ${why}`, callLogId: null };
  }
}
