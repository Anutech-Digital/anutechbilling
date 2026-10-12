/**
 * Which pipeline steps did this deal REALLY go through? Drives the ✓ on the deal page stepper.
 *
 * 1 Oct 2026, Pardeep, on Demo Co: first "jo kaam is deal me hue hi nahi unhe tick ke
 * saath kyo dikha raha hai" (it showed ✓ Demo Done and ✓ Trial Active because those come before
 * Won in the list), then, once the ticks were gone, "kya is deal ko quote nahi gaya — mere khayal
 * se gaya hai" (it had: an accepted project quotation). So a ✓ needs evidence, never position:
 *
 *   quote — a subscription quote that left draft, a project quotation past draft, or a recorded
 *           move into Quote Sent
 *   demo  — a recorded move into Demo Done
 *   trial — a recorded move into Trial Active, or the lead's trial_started_at
 *
 * The current stage is not "reached" here — the stepper highlights it on its own.
 */
export type ReachedStep = "quote" | "demo" | "trial";

export interface StagesReachedInput {
  /** Stages the lead was moved INTO, from activity_log (oldest/newest order doesn't matter). */
  stageMoves: readonly string[];
  /** Subscription quotes on the lead. */
  quotes?: ReadonlyArray<{ status?: string | null }>;
  /** Project quotation rows (lib/deals/deal-quotes.ts) — statusLabel "Draft" means not sent. */
  projectQuotes?: ReadonlyArray<{ kind: string; statusLabel: string }>;
  trialStartedAt?: string | null;
}

export function stagesReached(src: StagesReachedInput): Set<ReachedStep> {
  const out = new Set<ReachedStep>();
  const moved = new Set(src.stageMoves);
  const quoteLeft = (src.quotes ?? []).some((q) => !!q.status && q.status !== "draft");
  const projectLeft = (src.projectQuotes ?? []).some((p) => p.kind === "project" && p.statusLabel !== "Draft");
  if (quoteLeft || projectLeft || moved.has("quote")) out.add("quote");
  if (moved.has("demo")) out.add("demo");
  if (moved.has("trial") || !!src.trialStartedAt) out.add("trial");
  return out;
}
