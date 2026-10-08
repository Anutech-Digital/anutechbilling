/**
 * R-260 — what a wizard button does. Pure, so the rule that broke is tested:
 * "Skip for now" on the last content step used to just move to the Done screen
 * without stamping setup_completed_at, so the dashboard's setup prompt never closed.
 *
 * Every way of reaching Done (Finish, Skip, tapping the last progress segment)
 * now finishes setup; every way of leaving step 1 saves the company first.
 */
export const DONE_STEP = 4;

export type WizardMove = "save-company" | "finish" | "advance";

export function wizardMove(step: number, target: number = step + 1): WizardMove {
  if (step === 0 && target > 0) return "save-company";
  if (target >= DONE_STEP) return "finish";
  return "advance";
}
