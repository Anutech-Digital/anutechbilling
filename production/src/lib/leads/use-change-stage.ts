/**
 * useChangeLeadStage — the single entry point for moving a lead between stages.
 *
 * A lead's stage can be changed from seven places (kanban drag, drawer button,
 * drawer dropdown, bulk bar, mobile card, list-row select, quick actions) spread
 * across three components, each of which used to call the mutation directly.
 * Asking "why lost?" at each site is precisely how this codebase ended up with
 * four conflicting definitions of "stale" — so the rule lives here instead.
 *
 * Behaviour:
 *   • moving to `lost` → prompt for a reason first; dismissing CANCELS the move
 *   • any other stage  → straight through
 *   • returns true when the stage actually changed, so callers know whether to
 *     show their success toast
 */
"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateLeadStage } from "@/lib/queries/leads";
import { useLossReason } from "@/components/providers/loss-reason-provider";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { checkWonExit } from "@/lib/leads/deal-rules";
import type { Lead } from "@/lib/supabase/database.types";

type StageTarget = Pick<Lead, "id" | "stage" | "company">;

/**
 * R-1762: a Won deal leaves Won only when none of its quotes has a payment, invoice or
 * subscription. Asked BEFORE the lost-reason prompt, so nobody types a reason for a move the
 * database (trg_r1762_won_exit_guard) would refuse anyway. False = refused, already toasted.
 */
async function wonExitAllowed(lead: StageTarget, stage: Lead["stage"]): Promise<boolean> {
  if (lead.stage !== "won" || stage === "won") return true;
  const { data, error } = await createClient().rpc("lead_has_money", { p_lead_id: lead.id });
  if (error) {
    toastError(error, { fallback: "Could not check the deal's payments — nothing was changed" });
    return false;
  }
  const verdict = checkWonExit(lead, stage, data === true);
  if (!verdict.ok) {
    toast.error(verdict.title, { description: verdict.description });
    return false;
  }
  return true;
}

export function useChangeLeadStage() {
  const updateStage = useUpdateLeadStage();
  const askLossReason = useLossReason();
  const qc = useQueryClient();

  const changeStage = React.useCallback(
    async (lead: StageTarget, stage: Lead["stage"]): Promise<boolean> => {
      if (lead.stage === stage) return false;
      if (!(await wonExitAllowed(lead, stage))) return false;

      if (stage === "lost") {
        const reason = await askLossReason(lead.company);
        // Dismissed. A loss with no reason is the exact thing this feature
        // exists to prevent, so we leave the lead where it is rather than
        // recording an unexplained one.
        if (!reason) return false;
        await updateStage.mutateAsync({
          id: lead.id, stage, lostReason: reason.code, lostNote: reason.note,
        });
        // R-1762: Won → Lost rejected the accepted quote in the database — refresh it.
        if (lead.stage === "won") void qc.invalidateQueries({ queryKey: ["quotes"] });
        return true;
      }

      await updateStage.mutateAsync({ id: lead.id, stage });
      return true;
    },
    [askLossReason, updateStage, qc],
  );

  /**
   * Bulk version. Asks for the reason ONCE and applies it to every selected
   * lead — prompting twenty times for a twenty-row selection would guarantee
   * the rep just stops using the bulk bar.
   *
   * Returns the number of leads actually moved (0 if the prompt was dismissed).
   */
  const changeStageBulk = React.useCallback(
    async (leads: readonly StageTarget[], stage: Lead["stage"]): Promise<number> => {
      const targets: StageTarget[] = [];
      for (const l of leads) {
        if (l.stage === stage) continue;
        // R-1762: a Won deal with money stays Won (toasted); the others still move.
        if (await wonExitAllowed(l, stage)) targets.push(l);
      }
      if (targets.length === 0) return 0;

      let lostReason: string | null = null;
      let lostNote: string | null = null;
      if (stage === "lost") {
        const reason = await askLossReason(
          targets.length === 1 ? targets[0].company : `${targets.length} deals`,
        );
        if (!reason) return 0;
        lostReason = reason.code;
        lostNote = reason.note;
      }

      await Promise.all(
        targets.map((l) => updateStage.mutateAsync({ id: l.id, stage, lostReason, lostNote })),
      );
      if (stage === "lost" && targets.some((l) => l.stage === "won")) {
        void qc.invalidateQueries({ queryKey: ["quotes"] });
      }
      return targets.length;
    },
    [askLossReason, updateStage, qc],
  );

  return { changeStage, changeStageBulk, isPending: updateStage.isPending };
}
