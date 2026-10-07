/**
 * The quote-to-cash lifecycle: Draft → Sent → Signed → Paid → Provisioned → Invoiced.
 *
 * ─── EVERY STEP IS BACKED BY A FACT, NOT BY A GUESS ─────────────────────────
 * A progress bar is the most believable thing on a screen — six ticks and a customer
 * or a rep stops asking questions. So each step here maps to something that either
 * exists in the database or does not:
 *
 *   Draft        the quote row exists
 *   Sent         status left 'draft'
 *   Signed       a quote_signatures row, OR status='accepted'
 *   Paid         the money is in: quoteIsPaid() — 'received', or 'invoiced' with the payments
 *                covering the quote (R-159: invoicing before payment no longer reads as paid)
 *   Provisioned  every provisioning task is done (or there is nothing to provision)
 *   Invoiced     invoice_id is set
 *
 * "Signed" accepts a plain acceptance as well as a click-to-sign record, because
 * quotes accepted before signatures existed are genuinely accepted — showing them as
 * unsigned forever would make the bar lie about history rather than about the future.
 *
 * ─── PROVISIONED AND INVOICED ARE NOT IN SEQUENCE ───────────────────────────
 * They render in that order because the brief asks for it and it reads naturally, but
 * neither waits for the other. Under CGST §31 a tax invoice is issued on supply and
 * cannot be held back while a reseller creates mailboxes; in practice the invoice is
 * often first. A bar that treated Invoiced as unreachable until Provisioned completed
 * would show a correctly-invoiced sale as incomplete.
 *
 * ─── A SKIPPED STEP IS SHOWN AS SKIPPED, NEVER AS DONE ──────────────────────
 * A quote with nothing to provision reaches `not_required`, which renders differently
 * from a green tick. Marking it done would claim work happened that nobody did.
 */

/** "trial" is only ever inserted by lib/trials/start-from-quote.ts withTrialStep (R-282). */
export type LifecycleStage = "draft" | "sent" | "signed" | "trial" | "paid" | "provisioned" | "invoiced";
export type StageState = "done" | "current" | "todo" | "skipped";

export interface LifecycleStep {
  stage: LifecycleStage;
  label: string;
  state: StageState;
  /** What this step is waiting on, or what happened. Shown on hover and to a reader. */
  detail: string;
}

export interface LifecycleInput {
  status: "draft" | "sent" | "viewed" | "accepted" | "rejected" | "expired";
  paymentStatus: "none" | "awaiting" | "partial" | "received" | "invoiced";
  invoiceId: string | null;
  /** True when a quote_signatures row exists. */
  hasSignature: boolean;
  /** From overallProvisionStatus(). "not_required" = nothing to create. */
  provisionStatus: "pending" | "in_progress" | "done" | "failed" | "not_required";
  signerName?: string | null;
  /**
   * R-159: whether the money is in, from quoteIsPaid() (payments recorded vs the quote).
   * Absent → the old reading of paymentStatus alone, for callers that have no amounts.
   */
  paid?: boolean;
}

const LABELS: Record<LifecycleStage, string> = {
  draft: "Draft", sent: "Sent", signed: "Signed", trial: "Trial",
  paid: "Paid", provisioned: "Provisioned", invoiced: "Invoiced",
};

/**
 * Build the bar.
 *
 * A rejected or expired quote gets a bar that stops where it stopped — the remaining
 * steps are `todo`, never `current`, because nothing is in progress on a dead quote and
 * a pulsing "current" step would suggest someone is working on it.
 */
export function quoteLifecycle(input: LifecycleInput): {
  steps: LifecycleStep[];
  /** True when the quote is finished with — rejected or expired. */
  dead: boolean;
} {
  const dead = input.status === "rejected" || input.status === "expired";

  const sent   = input.status !== "draft";
  const signed = input.hasSignature || input.status === "accepted";
  const paid   = input.paid ?? (input.paymentStatus === "received" || input.paymentStatus === "invoiced");
  const invoiced = Boolean(input.invoiceId);

  const steps: LifecycleStep[] = [
    {
      stage: "draft", label: LABELS.draft, state: "done",
      detail: "The quote exists.",
    },
    {
      stage: "sent", label: LABELS.sent,
      state: sent ? "done" : "todo",
      detail: sent ? "Sent to the customer." : "Not sent yet.",
    },
    {
      stage: "signed", label: LABELS.signed,
      state: signed ? "done" : "todo",
      detail: input.hasSignature
        ? `Confirmed online${input.signerName ? ` by ${input.signerName}` : ""}.`
        : input.status === "accepted"
          ? "Marked accepted. No online confirmation was recorded."
          : "Waiting for the customer to accept.",
    },
    {
      stage: "paid", label: LABELS.paid,
      state: paid ? "done" : "todo",
      detail: paid
        ? "Payment received."
        : input.paymentStatus === "partial"
          ? "Part-paid — the balance is still outstanding."
          : input.paymentStatus === "invoiced"
            ? "Invoiced before payment — the money is still due."
            : "No payment recorded.",
    },
    {
      stage: "provisioned", label: LABELS.provisioned,
      state: provisionState(input.provisionStatus),
      detail: provisionDetail(input.provisionStatus),
    },
    {
      stage: "invoiced", label: LABELS.invoiced,
      state: invoiced ? "done" : "todo",
      detail: invoiced ? "Tax invoice issued." : "No invoice yet.",
    },
  ];

  /* Exactly one step may be "current": the first unfinished one. A skipped step is
     never current — there is nothing to do on it. */
  if (!dead) {
    const next = steps.find((s) => s.state === "todo");
    if (next) next.state = "current";
  }

  return { steps, dead };
}

function provisionState(s: LifecycleInput["provisionStatus"]): StageState {
  if (s === "done") return "done";
  if (s === "not_required") return "skipped";
  return "todo";
}

function provisionDetail(s: LifecycleInput["provisionStatus"]): string {
  switch (s) {
    case "done":         return "Seats created.";
    case "in_progress":  return "Being set up.";
    case "failed":       return "Setting up failed — open the provisioning list.";
    case "not_required": return "Nothing on this quote needs setting up.";
    default:             return "Waiting to be set up.";
  }
}

/** One line for a list row: how far along, in words. */
export function lifecycleSummary(steps: readonly LifecycleStep[]): string {
  const current = steps.find((s) => s.state === "current");
  if (current) return `Waiting on: ${current.label}`;
  const lastDone = [...steps].reverse().find((s) => s.state === "done");
  return lastDone ? `${lastDone.label} — complete` : "Draft";
}
