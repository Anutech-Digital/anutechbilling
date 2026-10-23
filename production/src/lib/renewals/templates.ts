/**
 * Renewal email templates — tone escalation from soft → final + grace.
 *
 * Each template is pure data (no I/O). Caller renders by interpolating
 * the placeholder fields. Subject + body kept in the same object so a
 * future "preview email" UI can show both side-by-side.
 *
 * Tones (matches CADENCE_TRIGGERS):
 *   • soft       — T-15 + T-12. Heads-up tone, customer-friendly.
 *   • friendly   — T-9. "Just a reminder."
 *   • firm       — T-6. "Please confirm to keep service active."
 *   • urgent     — T-3. "Interruption ahead."
 *   • final      — T-0. "Today is the day. Service suspends without payment."
 *   • grace      — T+1..T+grace. "You're in the grace window. Pay now."
 */

import type { CadenceTone } from "./cadence";

export interface RenewalTemplateContext {
  customerName:   string;
  customerCompany?: string;
  tenantName:     string;
  tenantEmail?:   string | null;
  tenantPhone?:   string | null;
  planName:       string;
  seats:          number;
  amount:         number;          // ₹ integer
  amountInWords?: string;          // optional pre-formatted
  renewalDate:    string;          // e.g. "15 Jun 2026"
  daysUntil:      number;          // positive future, negative past
  graceDays:      number;          // this subscription's grace (effectiveGraceDays)
  /**
   * R-1621: the IST day the service stops if still unpaid (e.g. "23 Oct 2026") —
   * serviceStopDate(renewal, grace). The urgent, final and grace mails name this exact day.
   */
  stopDate?:      string;
  paymentLink?:   string | null;   // Razorpay link (Phase 2)
  acceptLink?:    string;          // /quote/[id]/accept link
}

export interface RenewalTemplate {
  subject: string;
  /** Plain-text body — works in any client. HTML version comes when we wire Resend. */
  body:    string;
}

const rupee = (n: number) => "₹" + n.toLocaleString("en-IN");

export function renderTemplate(tone: CadenceTone, ctx: RenewalTemplateContext): RenewalTemplate {
  switch (tone) {
    // T-30 (migration 0228). Deliberately the least pushy message in the ladder:
    // a month out nothing is wrong yet, and what the customer actually needs is
    // lead time to raise a PO or get a budget signed off — not urgency.
    //
    // It quotes NO price. At T-30 the renewal quote may not exist yet (the cron
    // only creates one when entering notice_sent at T-15), and a figure invented
    // here is the single way this email could do harm: a customer who plans around
    // a number that later changes has been misled, however politely.
    case "early":
      return {
        subject: `Heads-up: your ${ctx.planName} renews on ${ctx.renewalDate}`,
        body:
`Hi ${ctx.customerName},

Nothing to action today — this is just early notice that your ${ctx.planName} subscription (${ctx.seats} seats) is due for renewal on ${ctx.renewalDate}, about ${ctx.daysUntil} days away.

I'm sending it a month ahead in case a purchase order or budget approval needs arranging at your end. If you'd like the renewal quote now, or want to change the seat count before we prepare it, just reply and I'll sort it out.

Thanks,
${ctx.tenantName}${ctx.tenantPhone ? `\n${ctx.tenantPhone}` : ""}${ctx.tenantEmail ? `\n${ctx.tenantEmail}` : ""}`,
      };

    case "soft":
      return {
        subject: `Your ${ctx.planName} renewal is coming up — ${ctx.renewalDate}`,
        body:
`Hi ${ctx.customerName},

Quick heads-up — your ${ctx.planName} subscription (${ctx.seats} seats) renews on ${ctx.renewalDate}. That's about ${ctx.daysUntil} days away.

Renewal amount (1 year, single payment): ${rupee(ctx.amount)}

We've prepared a renewal quote, attached as PDF for your records.

${ctx.acceptLink ? `Review and accept online: ${ctx.acceptLink}\n\n` : ""}There's no action needed right now — this is just a friendly notice so nothing catches you off-guard. Reply to this email if you want to discuss plan changes, additional seats, or any other adjustments before renewal.

Thanks for being with us.

— ${ctx.tenantName}${ctx.tenantPhone ? `\n   ${ctx.tenantPhone}` : ""}${ctx.tenantEmail ? `\n   ${ctx.tenantEmail}` : ""}`,
      };

    case "friendly":
      return {
        subject: `Reminder · ${ctx.planName} renewal in ${ctx.daysUntil} days`,
        body:
`Hi ${ctx.customerName},

A friendly reminder that your ${ctx.planName} subscription renews in ${ctx.daysUntil} days (${ctx.renewalDate}).

Renewal amount: ${rupee(ctx.amount)} for ${ctx.seats} seats. PDF quote attached.

${ctx.acceptLink ? `Renew online: ${ctx.acceptLink}\n\n` : ""}If you have any questions or want to update the plan / seat count before renewal, just reply to this email and we'll handle it together.

— ${ctx.tenantName}${ctx.tenantPhone ? `\n   ${ctx.tenantPhone}` : ""}`,
      };

    case "firm":
      return {
        subject: `Action needed · ${ctx.planName} renewal in ${ctx.daysUntil} days`,
        body:
`Hi ${ctx.customerName},

Your ${ctx.planName} subscription renews in ${ctx.daysUntil} days, on ${ctx.renewalDate}.

To keep your service running without interruption, please confirm renewal by paying ${rupee(ctx.amount)} for ${ctx.seats} seats. The renewal quote is attached.

${ctx.acceptLink ? `Renew now: ${ctx.acceptLink}\n\n` : ""}If renewal is no longer needed, just reply and we'll close it cleanly. Otherwise we'd appreciate confirmation soon.

— ${ctx.tenantName}${ctx.tenantPhone ? `\n   Phone: ${ctx.tenantPhone}` : ""}`,
      };

    case "urgent":
      return {
        subject: `URGENT · ${ctx.planName} suspends in ${ctx.daysUntil} days without payment`,
        body:
`Hi ${ctx.customerName},

This is an urgent reminder. Your ${ctx.planName} subscription (${ctx.seats} seats) is due to renew on ${ctx.renewalDate} — just ${ctx.daysUntil} days from now.

If payment is not received by then${ctx.graceDays > 0 ? ` (plus the ${ctx.graceDays}-day grace period that follows)` : ""}, your service will be suspended${ctx.stopDate ? ` on ${ctx.stopDate}` : ""}. That means mailboxes will stop accepting mail, calendars stop syncing, and team access pauses.

Renewal amount: ${rupee(ctx.amount)}. Quote attached.

${ctx.acceptLink ? `Pay now to avoid interruption: ${ctx.acceptLink}\n\n` : ""}If you're facing any blocker — internal approval, finance cycle, budget — please reach out and we'll work it out. We want to keep your team running.

— ${ctx.tenantName}${ctx.tenantPhone ? `\n   Direct: ${ctx.tenantPhone}` : ""}${ctx.tenantEmail ? `\n   ${ctx.tenantEmail}` : ""}`,
      };

    case "final":
      return {
        subject: `FINAL NOTICE · ${ctx.planName} renewal due today`,
        body:
`Hi ${ctx.customerName},

Today is your renewal day. Your ${ctx.planName} subscription (${ctx.seats} seats) is due for renewal at ${rupee(ctx.amount)}.

${ctx.graceDays > 0
  ? `If payment is not received by end of day, your subscription will enter a ${ctx.graceDays}-day grace period. After that, service is suspended${ctx.stopDate ? ` on ${ctx.stopDate}` : ""} — mailboxes stop accepting mail, calendar invites bounce, and shared drives become read-only.`
  : `Without payment today, your subscription will be suspended ${ctx.stopDate ? `on ${ctx.stopDate}` : "starting tomorrow"} — mailboxes stop accepting mail, calendar invites bounce, and shared drives become read-only.`
}
${ctx.stopDate ? `\nService stops on: ${ctx.stopDate} (IST), unless payment reaches us before then.\n` : ""}

This is the last reminder we'll send before suspension.

Renewal quote attached. ${ctx.acceptLink ? `\n\nPay now to keep service active: ${ctx.acceptLink}\n` : ""}

If you've already paid, please ignore this — and apologies for the cross-over.

— ${ctx.tenantName}${ctx.tenantPhone ? `\n   Direct: ${ctx.tenantPhone}` : ""}${ctx.tenantEmail ? `\n   ${ctx.tenantEmail}` : ""}`,
      };

    case "grace":
      return {
        /* R-1621: the stop DATE, not a day count. The count was graceDays + daysUntil, where
           daysUntil is the days PAST renewal (absolute) — day 2 of a 7-day grace said "suspends
           in 9 days" when it was 6. A date cannot be added up wrong by the reader either. */
        subject: ctx.stopDate
          ? `Grace period · ${ctx.planName} payment overdue · service stops on ${ctx.stopDate}`
          : `Grace period · ${ctx.planName} payment overdue · suspends in ${Math.max(1, ctx.graceDays - ctx.daysUntil + 1)} days`,
        body:
`Hi ${ctx.customerName},

Your ${ctx.planName} renewal payment hasn't reached us yet. Your subscription has entered the ${ctx.graceDays}-day grace period — service is still running for now, but it WILL be suspended ${ctx.stopDate ? `on ${ctx.stopDate} (IST)` : `in ${Math.max(1, ctx.graceDays - ctx.daysUntil + 1)} day(s)`} if payment isn't received.

Amount due: ${rupee(ctx.amount)}. Renewal quote attached.

${ctx.acceptLink ? `Pay immediately to avoid suspension: ${ctx.acceptLink}\n\n` : ""}If there's anything blocking payment on your end, please call us today — we'd rather work it out than suspend service.

— ${ctx.tenantName}${ctx.tenantPhone ? `\n   Direct: ${ctx.tenantPhone}` : ""}`,
      };
  }
}
