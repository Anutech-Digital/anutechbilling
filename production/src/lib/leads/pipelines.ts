/**
 * Sales motions — the three ways a deal reaches this business, and how each one differs.
 *
 * ─── WHY THE STAGE FLOW DIFFERS PER MOTION ──────────────────────────────────
 * A new-logo deal has to earn every stage: nobody has heard of you, so a demo is real
 * work. A renewal starts from a customer who already pays you — running a "demo" for
 * them is theatre, and a pipeline that demands one produces stages nobody fills in
 * honestly. So each motion declares which stages it actually uses, and the UI offers
 * only those.
 *
 * ─── WHAT IS NOT CLAIMED ────────────────────────────────────────────────────
 * The stage lists here are a starting shape, not measured practice. Nobody has yet
 * looked at how this tenant's renewals really move. They live in one constant so
 * correcting them is a one-line change — the same treatment given to the forecast
 * probabilities, and for the same reason.
 */
import type { Lead } from "@/lib/supabase/database.types";

export type Pipeline = Lead["pipeline"];

export interface PipelineDef {
  id: Pipeline;
  label: string;
  /** One line, shown as a tooltip — a switcher whose options need explaining is a bad one. */
  hint: string;
  /** Stages this motion actually uses, in order. */
  stages: Lead["stage"][];
}

export const PIPELINES: readonly PipelineDef[] = [
  {
    id: "new_logo",
    label: "New Logo",
    hint: "Winning a customer who is not ours yet — the full funnel, demo included.",
    stages: ["new", "contact", "quote", "demo", "trial", "won", "lost"],
  },
  {
    id: "migration",
    label: "Migrations",
    hint: "Moving a customer off another reseller or vendor. They already use the product, so the work is the switch, not the demo.",
    /* No `demo`: they are already using the thing. A trial matters here because the
       migration itself is what has to be proven. */
    stages: ["new", "contact", "quote", "trial", "won", "lost"],
  },
  {
    id: "renewal",
    label: "Renewals & Expansion",
    hint: "An existing customer renewing or buying more. They know the product — this is a price and paperwork conversation.",
    /* Neither demo nor trial: running either for a paying customer is theatre, and a
       stage nobody fills in honestly is worse than no stage. */
    stages: ["new", "contact", "quote", "won", "lost"],
  },
];

const BY_ID = new Map(PIPELINES.map((p) => [p.id, p]));

/** Falls back to new_logo — the default motion — rather than returning undefined. */
export function pipelineDef(id: Pipeline | null | undefined): PipelineDef {
  return BY_ID.get(id ?? "new_logo") ?? PIPELINES[0];
}

export function pipelineLabel(id: Pipeline | null | undefined): string {
  return pipelineDef(id).label;
}

/** The stages a given motion offers. */
export function stagesFor(id: Pipeline | null | undefined): Lead["stage"][] {
  return pipelineDef(id).stages;
}

/**
 * Is this stage valid for this motion?
 *
 * Used to decide whether to show a warning, NOT to block. A deal already sitting in
 * `demo` when somebody switches it to the renewal motion must keep its stage — silently
 * moving it would rewrite history, and refusing the switch would trap the rep. The UI
 * says "this stage is unusual here" and lets them decide.
 */
export function stageFitsPipeline(stage: Lead["stage"], id: Pipeline | null | undefined): boolean {
  return stagesFor(id).includes(stage);
}

/** Count leads per motion, for the switcher's badges. Junk is the caller's to exclude. */
export function pipelineCounts(
  leads: ReadonlyArray<Pick<Lead, "pipeline">>,
): Record<Pipeline, number> {
  const out: Record<Pipeline, number> = { new_logo: 0, migration: 0, renewal: 0 };
  for (const l of leads) out[l.pipeline ?? "new_logo"]++;
  return out;
}
