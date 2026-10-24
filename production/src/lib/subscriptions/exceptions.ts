/**
 * Subscription exception flags — the facts that stay invisible until they matter.
 *
 * WHY THIS IS A PURE FUNCTION AND NOT JUST JSX. Measured against production on
 * 13 Aug 2026: across all 54 of the tenant's subscriptions, `auto_renew` is true
 * on every row, `renewal_state` is 'pending' on every row, and `reminder_count`,
 * `outstanding_amount`, `used`, `suspended_at` and `written_off_at` are
 * zero/empty on every row.
 *
 * So NONE of these branches render in production today. A bug in any of them
 * would be invisible on screen — which is precisely the failure mode this
 * project keeps hitting: built, looks configured, does nothing. Pulling the
 * decision out of the component is what makes it testable at all.
 *
 * WHY CONDITIONAL RATHER THAN ALWAYS-ON. Rendering these unconditionally would
 * put 54 identical badges on screen: pure noise, zero information. Rendering
 * them only on deviation costs nothing today and makes each one the loudest
 * thing on the row the day it goes wrong.
 */
import { rupee, formatDate } from "@/lib/utils";
import { renewalStateLabel, renewalStateTone, type RenewalState } from "@/lib/renewals/cadence";
import { paymentDueState, paymentDueChipLabel, todayIST } from "./payment-due";
import { subscriptionEnded } from "./renewal-display";

export type ExceptionTone = "muted" | "info" | "warning" | "danger" | "success";

export interface SubExceptionFlag {
  /** Stable React key / test handle. */
  key: string;
  label: string;
  tone: ExceptionTone;
  /** Hover explanation. §24: a signal that only alarms is a dead end. */
  title?: string;
}

/** Only the fields this decision reads — so tests need not build a whole row. */
export interface SubExceptionFields {
  /** R-1685: an ended (cancelled / expired) subscription has no renewal and no payment clock. */
  status?: string | null;
  auto_renew?: boolean | null;
  renewal_state?: RenewalState | null;
  reminder_count?: number | null;
  last_reminder_sent_at_v2?: string | null;
  outstanding_amount?: number | null;
  /** Postpaid credit clock (migration 20260910060000). Null = no agreed date. */
  payment_due_date?: string | null;
  /** R-1689: when the money is due — the oldest unpaid invoice's due date, else the agreed date
   *  (OutstandingRow.pay_by). Absent = not read; the agreed date alone is used. */
  pay_by?: string | null;
  seats?: number | null;
  used?: number | null;
  suspended_at?: string | null;
  written_off_at?: string | null;
}

const n = (v: number | null | undefined): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

export function subscriptionExceptions(s: SubExceptionFields): SubExceptionFlag[] {
  const out: SubExceptionFlag[] = [];
  const ended = subscriptionEnded(s.status);

  // Auto-renew off means the renewals cron generates no quote and the
  // subscription lapses to `expired` on its date with nobody told. This was
  // not surfaced anywhere in the app — mobile or desktop.
  if (s.auto_renew === false && !ended) {
    out.push({
      key: "auto_renew_off",
      label: "Won't auto-renew",
      tone: "danger",
      title: "Auto-renew is off — no renewal quote will be generated and this will lapse on its renewal date",
    });
  }

  // Where the renewal chase has actually reached, so nobody rings a customer
  // unaware that four reminders already went out under their name.
  // `pending` is the resting state and carries no news.
  if (s.renewal_state && s.renewal_state !== "pending" && !ended) {
    const sent = n(s.reminder_count);
    out.push({
      key: "renewal_state",
      label: renewalStateLabel(s.renewal_state) + (sent > 0 ? ` · ${sent} sent` : ""),
      tone: renewalStateTone(s.renewal_state),
      title: s.last_reminder_sent_at_v2
        ? `Last reminder ${formatDate(s.last_reminder_sent_at_v2)}`
        : undefined,
    });
  }

  // Service can be live with money still owed.
  /* R-1685: an ended subscription that still owes says so — as owed, with no "service is
     active" and no payment countdown (a closed record is not on a credit clock). */
  if (n(s.outstanding_amount) > 0 && ended) {
    out.push({
      key: "outstanding",
      label: `${rupee(n(s.outstanding_amount))} still owed`,
      tone: "warning",
      title: "The subscription has ended but this amount is still unpaid",
    });
  } else if (n(s.outstanding_amount) > 0) {
    out.push({
      key: "outstanding",
      label: `${rupee(n(s.outstanding_amount))} due`,
      tone: "warning",
      title: "Service is active but this amount is still unpaid",
    });

    /* ── WHEN it is due, directly under WHAT is due ──────────────────────────
       This chip started life next to the customer's name, and Abhishek moved it
       here on 11 Sep 2026 for a concrete reason: a long company name and the chip
       fought for the same column, and the chip lost. Under the amount owed is
       where it belongs anyway — the two facts are one thought ("₹26,168 due · pay
       by 15 Sept"), and putting them apart made the reader join them.

       Living in this function rather than in the table means the MOBILE CARD gets
       it too, for free, and it is tested in exceptions.test.ts alongside the other
       branches — none of which fire against today's production data, which is
       exactly why they are tested here and not eyeballed on screen. */
    /* R-1689: credit / "invoice now, pay later" raise an invoice with a due date and leave
       payment_due_date empty — the row read "No payment due date" while the invoice fell due on
       3 Nov. The date the money is due is the oldest unpaid invoice's (pay_by, from the dues
       read — lib/queries/payments.ts subscriptionPayBy), else the agreed date. */
    const payBy = s.pay_by ?? s.payment_due_date ?? null;
    const fromInvoice = !!s.pay_by && s.pay_by !== s.payment_due_date?.slice(0, 10);
    const state = paymentDueState(payBy, todayIST(), n(s.outstanding_amount));
    out.push({
      key: "payment-due",
      label: paymentDueChipLabel(
        state,
        payBy ? formatDate(payBy) : "",
      ),
      /* Red only once it is actually late. Amber inside the last three days, quiet
         before that, and MUTED when no date was ever agreed — that last one is a
         gap to fill, not an alarm to raise. */
      tone: state.kind === "overdue" ? "danger"
          : state.kind === "none"    ? "muted"
          : state.kind === "upcoming" ? "muted"
          : "warning",
      title: state.kind === "none"
        ? "No agreed payment date — set one via the row's ⋯ menu → Correct subscription, and the countdown starts"
        : fromInvoice
          ? `Unpaid invoice — ${rupee(n(s.outstanding_amount))} due, the invoice falls due on ${formatDate(payBy!)}`
          : `Postpaid — ${rupee(n(s.outstanding_amount))} due on ${formatDate(payBy!)}`,
    });
  }

  // Seat utilisation is gated on `used > 0` DELIBERATELY. `used` is 0 on every
  // production row because seat counts are not synced from the vendor yet — so
  // "0 of 5 in use" would assert idle licences that are probably being used
  // perfectly well. Silence is the honest output for untracked data.
  const used = n(s.used), seats = n(s.seats);
  if (used > 0 && seats > 0 && used / seats < 0.5) {
    out.push({
      key: "low_utilisation",
      label: `Only ${used}/${seats} seats used`,
      tone: "warning",
      title: "Unused licences are a churn risk at renewal — or a downgrade the customer will ask for",
    });
  }

  if (s.suspended_at) {
    out.push({
      key: "suspended",
      label: "Auto-suspended",
      tone: "danger",
      title: `Suspended ${formatDate(s.suspended_at)} for non-payment after the grace period`,
    });
  }

  if (s.written_off_at) {
    out.push({
      key: "written_off",
      label: "Written off",
      tone: "danger",
      title: `Written off ${formatDate(s.written_off_at)} as uncollectable`,
    });
  }

  return out;
}
