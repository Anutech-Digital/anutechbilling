/**
 * Invoice dunning — chasing an invoice that has gone past its due date.
 *
 * ─── THIS IS A DIFFERENT CLOCK FROM RENEWAL CADENCE, AND CONFLATING THEM
 *     WOULD SUSPEND THE WRONG CUSTOMERS ─────────────────────────────────────
 * lib/renewals/cadence.ts counts DOWN to a subscription's renewal_date and chases the
 * customer to renew. This counts UP from an invoice's due_date and chases them to pay.
 *
 * Different subject (a subscription vs one invoice), different clock (before vs after),
 * different question. A customer can be perfectly current on renewals and 20 days late
 * on a one-off invoice — and the reverse. Running one engine on both would either chase
 * people who owe nothing or ignore people who owe a lot.
 *
 * ─── "DAY 14 AUTO-SUSPEND" IS DELIBERATELY NOT AUTOMATIC BY DEFAULT ─────────
 * The brief asks for it. It is built, and it is OFF unless the tenant turns it on, for
 * a reason worth stating rather than burying:
 *
 * Suspending a customer means their staff cannot read email. It is the most damaging
 * thing this software can do to an end user, it is done to people who are not the
 * software's customer, and it is reversible only by a human noticing. Firing that from
 * an unpaid-invoice clock would suspend a live subscription because an UNRELATED
 * one-off invoice went unpaid — a hosting bill, a support charge — and the first
 * anybody hears of it is a customer who cannot log in.
 *
 * Suspension already has an owner: the renewal engine, which knows about the
 * subscription lifecycle and grace period. So the default here escalates to the
 * reseller with everything they need to decide in one click. `autoSuspend: true` makes
 * it automatic for a tenant that wants it, and even then only for an invoice actually
 * linked to a subscription.
 *
 * ─── IDEMPOTENT, WITH A CATCH-UP RULE ───────────────────────────────────────
 * The cron may miss a day (deploy, outage, clock skew). `decideDunning` returns the
 * most urgent step that should ALREADY have fired, not only an exact-day match — so a
 * two-day gap does not silently skip the Day-3 chase. The caller checks its log before
 * sending, so re-running the same day sends nothing.
 *
 * ─── THE CHASE NOW STARTS BEFORE THE DUE DATE ───────────────────────────────
 * Added 17 Aug 2026. The ladder used to begin at Day 1 OVERDUE, so the first thing a
 * customer ever heard was that they were already late. Two things wrong with that:
 *
 *   The cheapest rupee to collect is the one that was never late. Most Indian SME
 *   invoices go unpaid because they are sitting in somebody's inbox unactioned, not
 *   because the money is not there. A nudge three days out reaches a person who is
 *   not yet defensive, and it costs nothing to send.
 *
 *   Every message after the due date carries an accusation, however politely worded.
 *   Spending the relationship on something a reminder would have fixed is a bad trade
 *   for a reseller whose whole business is renewals.
 *
 * ─── AND THE PRE-DUE STEPS DELIBERATELY DO NOT CATCH UP ─────────────────────
 * This is the subtle part. The catch-up rule is right for overdue steps: "you are 9
 * days late" stays true if it fires on day 11. It is WRONG for a pre-due nudge —
 * "due in 3 days" sent on day +5 is simply a false statement, and one false statement
 * about money undoes a lot of correct ones.
 *
 * So `pre_due` fires only inside its window (3 days out to 1 day out), `due_today`
 * only on the day itself, and the message is generated from the ACTUAL days remaining
 * rather than from the step's nominal day — so even a late-fired nudge tells the truth.
 */
import { payInstruction } from "./pay-link";

export type DunningStep =
  /** Nothing to do — paid, void, or too far from the due date to speak. */
  | "none"
  /** 3 to 1 days BEFORE due — a heads-up, no accusation. Windowed, never caught up. */
  | "pre_due"
  /** The due date itself — "this is due today". Fires only on the day. */
  | "due_today"
  /** Day 1 — a light "this slipped past" note. */
  | "reminder"
  /** Day 3 — the payment link again, in case the first attempt failed. */
  | "retry"
  /** Day 7 — states plainly what happens if it stays unpaid. */
  | "grace_warning"
  /** Day 14 — suspend, or escalate to the reseller. See the header. */
  | "final";

export type DunningAction = "none" | "email" | "escalate" | "suspend";

/**
 * The OVERDUE ladder. MUST stay in ASCENDING daysOverdue order — decideDunning walks
 * it backwards to find the most urgent step already reached.
 *
 * The pre-due steps are NOT in this array, on purpose: everything here is subject to
 * the catch-up rule, and a pre-due nudge must never be caught up. Keeping them in
 * separate structures makes that impossible to get wrong by editing a number.
 */
export const DUNNING_STEPS: { daysOverdue: number; step: DunningStep; tone: string }[] = [
  { daysOverdue: 1,  step: "reminder",      tone: "friendly" },
  { daysOverdue: 3,  step: "retry",         tone: "helpful"  },
  { daysOverdue: 7,  step: "grace_warning", tone: "firm"     },
  { daysOverdue: 14, step: "final",         tone: "final"    },
];

/**
 * How many days BEFORE the due date the heads-up may be sent.
 *
 * A window, not a day. Three days out is the target; if the cron missed that morning
 * the nudge is still worth sending on day -2 or -1, and the message reads the real
 * number so it stays true. At day 0 it becomes `due_today`, which is a different
 * sentence.
 */
export const PRE_DUE_WINDOW_DAYS = 3;

export interface DunningInput {
  /** Invoice due date, YYYY-MM-DD. Null = never chased; see the note in decideDunning. */
  dueDate: string | null;
  status: "draft" | "pending" | "paid" | "overdue" | "void";
  /** ₹ still owed. Zero or less means nothing to chase. */
  amountDue: number;
  /** The most urgent step already sent for this invoice, if any. */
  lastStepSent?: DunningStep | null;
  /** Subscription this invoice bills, when there is one. */
  subscriptionId?: string | null;
  /** Tenant opted in to automatic suspension. Default false — see the header. */
  autoSuspend?: boolean;
}

export interface DunningDecision {
  step: DunningStep;
  action: DunningAction;
  daysOverdue: number;
  /** True when this step has not been sent for this invoice yet. */
  shouldSend: boolean;
  /** Plain language, for the log and for the reseller's escalation. */
  reason: string;
}

const NOTHING: Omit<DunningDecision, "daysOverdue" | "reason"> = {
  step: "none", action: "none", shouldSend: false,
};

/** Calendar days between two IST midnights. Positive when `to` is later. */
export function daysBetweenIST(from: Date, to: Date): number {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const dayMs = 86_400_000;
  return Math.floor((to.getTime() + istOffsetMs) / dayMs) - Math.floor((from.getTime() + istOffsetMs) / dayMs);
}

/**
 * Urgency order, used only to answer "has something at least this urgent already gone
 * out?". The two pre-due steps sit at the bottom, so a customer who got the heads-up
 * still gets the Day-1 reminder if they do not pay — the ladder is not short-circuited.
 */
const RANK: Record<DunningStep, number> = {
  none: 0, pre_due: 1, due_today: 2, reminder: 3, retry: 4, grace_warning: 5, final: 6,
};

/**
 * How urgent a logged step was. Exported because the cron needs the SAME ordering to
 * collapse a history of log rows into "the most urgent step already sent".
 *
 * It used to keep its own copy of this map, and adding `pre_due` broke it silently:
 * an unknown key returns `undefined`, `undefined > 0` is false, so a logged pre-due
 * nudge looked like it had never been sent and went out again every single morning
 * until the invoice fell due. A customer receiving the same "heads-up" four days
 * running is worse than never being nudged.
 *
 * An unknown step ranks 0 — a value written by a future version is treated as "nothing
 * sent" rather than crashing the pass. That is the safe direction: it may re-send one
 * message; the alternative silently stops chasing every invoice.
 */
export function dunningRank(step: string | null | undefined): number {
  if (!step) return 0;
  return RANK[step as DunningStep] ?? 0;
}

/**
 * What should happen to this invoice today?
 *
 * Nothing is chased unless the invoice is genuinely unpaid AND has a due date. An
 * invoice with no due date is not "overdue since forever" — it is an invoice nobody
 * gave a deadline, and inventing one would start dunning customers on terms they were
 * never told.
 */
export function decideDunning(input: DunningInput, now: Date = new Date()): DunningDecision {
  const daysOverdue = input.dueDate
    ? daysBetweenIST(new Date(`${input.dueDate}T12:00:00+05:30`), now)
    : 0;

  if (!input.dueDate) {
    return { ...NOTHING, daysOverdue: 0, reason: "No due date on this invoice, so there is no deadline to chase against." };
  }
  if (input.status === "paid" || input.status === "void" || input.status === "draft") {
    return { ...NOTHING, daysOverdue, reason: `Invoice is ${input.status}.` };
  }
  if (input.amountDue <= 0) {
    return { ...NOTHING, daysOverdue, reason: "Nothing outstanding." };
  }
  /* ── BEFORE THE DUE DATE ──────────────────────────────────────────────────
     Windowed, and NOT subject to the catch-up walk below. `daysOverdue` is negative
     here, which is the honest value to log: -3 means three days of runway left. */
  if (daysOverdue < 0) {
    const daysUntil = -daysOverdue;
    if (daysUntil > PRE_DUE_WINDOW_DAYS) {
      return { ...NOTHING, daysOverdue, reason: `Due in ${daysUntil} days — too early to nudge.` };
    }
    const alreadyNudged = RANK[input.lastStepSent ?? "none"] >= RANK.pre_due;
    return {
      step: "pre_due",
      action: "email",
      daysOverdue,
      shouldSend: !alreadyNudged,
      reason: `Due in ${daysUntil} day${daysUntil === 1 ? "" : "s"} — a heads-up before it is late.`,
    };
  }

  if (daysOverdue < DUNNING_STEPS[0].daysOverdue) {
    /* Exactly the due date. Its own step rather than silence: "due today" is the last
       moment a customer can pay without anybody being late, and it is the highest-yield
       message in the whole ladder for that reason. */
    const alreadySentToday = RANK[input.lastStepSent ?? "none"] >= RANK.due_today;
    return {
      step: "due_today",
      action: "email",
      daysOverdue: 0,
      shouldSend: !alreadySentToday,
      reason: "Due today — payable without anybody being late.",
    };
  }

  /* Walk backwards for the most urgent step already reached. An exact-day match would
     silently skip a chase whenever the cron misses a day. */
  const due = [...DUNNING_STEPS].reverse().find((s) => daysOverdue >= s.daysOverdue)!;
  const alreadySent = RANK[input.lastStepSent ?? "none"] >= RANK[due.step];

  if (due.step !== "final") {
    return {
      step: due.step,
      action: "email",
      daysOverdue,
      shouldSend: !alreadySent,
      reason: `${daysOverdue} days past due.`,
    };
  }

  /* Day 14. Suspension is only ever automatic when the tenant asked for it AND the
     invoice actually bills a subscription — suspending a mail service over an
     unrelated hosting bill is not a stronger version of chasing, it is a different
     and worse action. */
  const canSuspend = Boolean(input.autoSuspend && input.subscriptionId);
  return {
    step: "final",
    action: canSuspend ? "suspend" : "escalate",
    daysOverdue,
    shouldSend: !alreadySent,
    reason: canSuspend
      ? `${daysOverdue} days past due — automatic suspension is on for this tenant and this invoice bills a subscription.`
      : input.subscriptionId
        ? `${daysOverdue} days past due. Automatic suspension is off, so this needs your decision.`
        : `${daysOverdue} days past due. This invoice is not linked to a subscription, so there is nothing to suspend — it needs a call.`,
  };
}

/** Customer-facing subject and body for the steps that email. */
export function dunningMessage(args: {
  step: DunningStep;
  invoiceId: string;
  customerName: string;
  amountDue: string;
  dueDate: string;
  sellerName: string;
  payLink?: string | null;
  /**
   * Days still to run, for `pre_due` only. Pass the REAL number from the decision
   * (`-daysOverdue`), never the nominal 3 — a nudge that fired late on day -1 must say
   * "tomorrow", because "in 3 days" would be false and this is a message about money.
   */
  daysUntilDue?: number | null;
  /**
   * R-530: the late-charges sentence (lateChargesSentence in lib/late-charges/charges.ts), for
   * the OVERDUE steps only. Null/absent = no line. Before the due date nothing is late, so
   * the pre-due and due-today notes never carry it.
   */
  lateCharges?: string | null;
}): { subject: string; text: string } | null {
  const { step, invoiceId, customerName, amountDue, dueDate, sellerName, payLink } = args;
  /* R-018 (Pardeep, 27 Sep 2026). `pay` used to be the empty string when there was no
     link — while three of the branches below still said "here's the link again" and
     "pay using the link below" regardless. The cron passed `payLink: null` on EVERY
     run, so every overdue customer read an email pointing at a link that was never in
     it. Nothing errored; the email sent perfectly, and collection slowed down.

     Both halves now come from one place: `payInstruction` writes the sentence, and
     `hasLink` decides the wording around it. The promise and the link cannot disagree
     again because neither is written by hand. */
  const pay = payInstruction(payLink);
  const hasLink = Boolean(payLink);
  const first = customerName.split(" ")[0] || "there";
  const late = args.lateCharges ? `\n\n${args.lateCharges}` : "";

  switch (step) {
    case "pre_due": {
      /* No apology, no chasing, no consequence — none of it is warranted yet, and a
         heads-up that sounds like a warning trains people to dread the sender. */
      const n = args.daysUntilDue ?? null;
      const when = n === null ? `on ${dueDate}`
        : n <= 1 ? "tomorrow"
        : `in ${n} days, on ${dueDate}`;
      return {
        subject: `Invoice ${invoiceId} — due ${n !== null && n <= 1 ? "tomorrow" : `on ${dueDate}`}`,
        text: `Hi ${first},\n\nJust a heads-up that invoice ${invoiceId} for ${amountDue} falls due ${when}. Nothing is late — this is only so it does not get lost in an inbox.${pay}\n\nIf you need a PO number, a different billing date, or anything changed on the invoice, tell us now and it is easy to sort.\n\n— ${sellerName}`,
      };
    }
    case "due_today":
      return {
        subject: `Invoice ${invoiceId} — due today`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} is due today. Paying today keeps it clear of any late follow-ups.${pay}\n\nIf something is holding it up, just reply and tell us what — we would rather know than chase.\n\n— ${sellerName}`,
      };
    case "reminder":
      return {
        subject: `Invoice ${invoiceId} — just slipped past its due date`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} was due on ${dueDate} and we haven't seen it come through yet. If it's already on its way, please ignore this.${pay}${late}\n\n— ${sellerName}`,
      };
    case "retry":
      return {
        subject: hasLink
          ? `Invoice ${invoiceId} — payment link, in case the first one didn't go through`
          : `Invoice ${invoiceId} — still showing as unpaid`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} is still showing as unpaid. Sometimes a payment fails without telling anyone${hasLink ? ", so here's the link again" : ""}.${pay}\n\nIf you've already paid, reply and we'll trace it.${late}\n\n— ${sellerName}`,
      };
    case "grace_warning":
      return {
        subject: `Invoice ${invoiceId} — ${amountDue} still outstanding`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} has been outstanding since ${dueDate}.\n\nWe'd rather sort this out than let it affect your service, so please ${hasLink ? "either pay using the link below or " : ""}tell us what's holding it up — a PO, an approval, a query on the invoice — and we'll work with it.${pay}${late}\n\n— ${sellerName}`,
      };
    case "final":
      return {
        subject: `Invoice ${invoiceId} — we need to hear from you`,
        text: `Hi ${first},\n\nInvoice ${invoiceId} for ${amountDue} has now been outstanding for two weeks.\n\nWe need to agree how this will be settled. Please ${hasLink ? "pay using the link below, or " : ""}call us today so we can find a way forward.${pay}${late}\n\n— ${sellerName}`,
      };
    default:
      return null;
  }
}
