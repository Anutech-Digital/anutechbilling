/**
 * The deterministic follow-up draft, used when Gemini is unavailable OR when the
 * money-guard discards an AI draft.
 *
 * ─── WHY THIS IS A MODULE AND NOT A LOCAL FUNCTION ──────────────────────────
 * It was a private function inside `api/ai/draft-followup/route.ts`, which meant
 * nothing could test it — and its three EMAIL variants each ended:
 *
 *     \n\nThanks,\nDemo Co
 *
 * a hardcoded company name in text the operator sends to their own customer.
 * Demo Co is historical (CLAUDE.md §1), so on this tenant it is simply
 * the wrong company; on any other tenant it names a business the customer has no
 * relationship with. `lib/whatsapp.ts` had exactly this defect and fixed it — its
 * test still asserts no message says "Demo Co" — but the fix stopped at
 * WhatsApp. The three WhatsApp variants below carry no signature at all, which is
 * why they were never wrong and why the gap went unnoticed.
 *
 * The sign-off is a required parameter now. Not optional with a default: a default
 * is how the last one survived, and an unset signature must be a compile error
 * rather than a silent fallback to somebody's name.
 *
 * ─── MONEY ──────────────────────────────────────────────────────────────────
 * `outstanding` arrives in WHOLE RUPEES (AGENTS.md / CLAUDE.md §13) and is
 * formatted with `rupee()`. This function never computes a figure — it restates
 * one the caller read from the database, which is the whole reason the caller
 * falls back here when the model invents a number.
 */
import { rupee } from "@/lib/utils";

export interface Draft {
  subject: string;
  message: string;
}

export interface StubDraftArgs {
  channel:   "whatsapp" | "email";
  firstName: string;
  company:   string;
  planLabel: string;
  purpose:   "followup" | "reminder" | "renewal";
  /** Whole rupees. */
  outstanding: number;
  renewalDate?: string | null;
  /**
   * Who the email is from — the SENDING tenant's own name, resolved by the caller.
   * Required, and only used on the email variants; WhatsApp threads already show
   * who is writing, so a signature there is noise.
   */
  signOff: string;
}

export function stubDraft(args: StubDraftArgs): Draft {
  const { channel, firstName, company, planLabel, purpose, outstanding, renewalDate } = args;

  /* No name beats the wrong name — lib/whatsapp.ts's rule. A tenant with no name on
     file gets no signature block at all, rather than "Thanks," trailing into nothing. */
  const sig = args.signOff.trim() ? `\n\nThanks,\n${args.signOff.trim()}` : "";

  if (purpose === "renewal") {
    const on = renewalDate ? new Date(renewalDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "soon";
    if (channel === "whatsapp") {
      return {
        subject: "",
        message: `Hi ${firstName}, your ${planLabel} for ${company} is up for renewal on ${on}. ` +
          `Shall I send across the renewal quote so there's no interruption in service?`,
      };
    }
    return {
      subject: `Renewal due ${on} — ${company}`,
      message: `Hi ${firstName},\n\nYour ${planLabel} is due for renewal on ${on}. ` +
        `To keep the service running without interruption, I can share the renewal quote now — just let me know.${sig}`,
    };
  }

  if (purpose === "reminder") {
    const amt = rupee(outstanding);
    if (channel === "whatsapp") {
      return {
        subject: "",
        message: `Hi ${firstName}, gentle reminder — there's an outstanding balance of ${amt} on your account with us. ` +
          `Happy to share a payment link or answer any questions. Thank you!`,
      };
    }
    return {
      subject: `Payment reminder — ${company}`,
      message: `Hi ${firstName},\n\nA gentle reminder that there's an outstanding balance of ${amt} on your account. ` +
        `Do let me know if you'd like a payment link or have any questions.${sig}`,
    };
  }

  // followup / check-in
  if (channel === "whatsapp") {
    return {
      subject: "",
      message: `Hi ${firstName}, just checking in on ${planLabel} for ${company}. ` +
        `Everything running smoothly? Happy to help with anything — when's a good time for a quick call?`,
    };
  }
  return {
    subject: `Checking in — ${company}`,
    message: `Hi ${firstName},\n\nJust checking in on ${planLabel} for ${company}. ` +
      `Is everything running smoothly? I'd be glad to help with seats, renewals, or anything else.\n\n` +
      `Is there a good time this week for a quick call?${sig}`,
  };
}
