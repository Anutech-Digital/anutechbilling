/**
 * useLeadOutcome — performs the effect that `applyOutcome` describes.
 *
 * The split is deliberate: outcomes.ts holds the RULES (pure, tested, no React), this
 * holds the plumbing (mutations, toast, navigation). Every one of the seven places a
 * lead's stage used to be changed from had its own copy of the rules, which is how this
 * codebase ended up with four definitions of "stale" — noted in use-change-stage.ts's
 * own header. One entry point, one behaviour.
 *
 * Responsiveness: both underlying mutations write optimistically with rollback
 * (`useUpdateLead` and `useSetLeadJunk` in queries/leads.ts), so the row reflects the
 * tap on the next render rather than after the round-trip. The activity row is logged
 * fire-and-forget — a failed log must never undo a follow-up date the rep can see has
 * moved.
 */
"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useUpdateLead, useSetLeadJunk } from "@/lib/queries/leads";
import { useLogLeadActivity } from "@/lib/queries/lead-activities";
import { applyOutcome, type LeadOutcome } from "./outcomes";
import { useChangeLeadStage } from "./use-change-stage";
import type { Lead } from "@/lib/supabase/database.types";
import { leadQuoteHref } from "./lead-quote-href";

type OutcomeTarget = Pick<
  Lead,
  | "id" | "company" | "contact_phone" | "follow_up_date" | "plan" | "seats" | "value"
  // `stage` decides every forward-only refusal in outcomes.ts. Required, not optional:
  // an undefined stage reads as "no stage recorded" and silently refuses every move.
  | "stage"
  // Needed only by the quote-builder prefill, but required here rather than optional:
  // a caller passing a narrower object would silently prefill less.
  | "contact_name" | "contact_email"
>;

export function useLeadOutcome() {
  const updateLead = useUpdateLead({ quiet: true });   // this hook owns the toast
  const setJunk    = useSetLeadJunk();
  const logActivity = useLogLeadActivity();
  // the ONE door a stage change goes through — it owns the loss-reason prompt
  const { changeStage } = useChangeLeadStage();
  const router = useRouter();

  return React.useCallback(
    async (outcome: LeadOutcome, lead: OutcomeTarget, note = ""): Promise<void> => {
      /* `note` = call me kya baat hui. Wo activity ke SAATH jata hai, alag row me nahi —
         wajah outcomes.ts me likhi hai. Row ke chips ise khaali chhodte hain (1-tap fast
         path); drawer note box ka likha hua bhejta hai. */
      const eff = applyOutcome(outcome, lead, new Date(), note);

      if (eff.navigate === "quote") {
        /* Carries the lead's context into the builder. The stage stays where it is until
           a quote row actually exists — see outcomes.ts.

           One link for every surface (lib/leads/lead-quote-href.ts), so the same chip
           prefills the same everywhere. R-389 (F5): id + plan/seats only — the builder
           loads company and contact from the lead, so no email or phone sits in the URL. */
        router.push(leadQuoteHref(lead) as Route);
        return;
      }

      const previousFollowUp = lead.follow_up_date ?? null;

      /* ── Stage: apne hi darwaze se ──────────────────────────────────────────
         `useChangeLeadStage` hi ekmatra jagah hai jahan se stage badalta hai, kyunki wahi
         `lost` par loss-reason poochhta hai aur reason na milne par move cancel kar deta
         hai. Yahan seedha patch likhna us feature ko chup-chaap maar deta.

         Ye stage ko PEHLE chalata hai: agar user loss-reason wale dialog ko band kar deta
         hai, to move hua hi nahi — aur uske baad "Lost" ka toast dikhana jhooth hota. */
      let stageMoved = true;
      if (eff.stage?.nextStage) {
        stageMoved = await changeStage(
          { id: lead.id, stage: lead.stage, company: lead.company },
          eff.stage.nextStage,
        );
        if (!stageMoved) return;   // reason dialog dismissed — kuch nahi hua, aur wo theek hai
      } else if (eff.stage && eff.stage.code !== "already") {
        /* Chip ne stage badalna CHAHA aur niyam ne roka. User ne tap dekha hai aur kuch
           hota nahi dekha; bina wajah ke wo "app ne kuch nahi kiya" jaisa lagta hai
           (CLAUDE.md §24).

           `already` YAHAN SE BAHAR hai, aur ye 26 Aug 2026 ko Pardeep ke sawaal se aaya:
           "phone par hogi to usko kaise record karenge". Ek Contacted lead ko dobara call
           karna roz ka kaam hai — us par har baar "stage nahi badla" chipkana shor hai,
           khabar nahi. Call phir bhi darj hoti hai; wahi to poochha gaya tha.

           `return` nahi — chip ka baaki kaam (activity log) phir bhi hona chahiye. */
        toast.info(`Stage unchanged — ${eff.stage.reason}`);
      }

      try {
        if (eff.patch && "is_junk" in eff.patch) {
          await setJunk.mutateAsync({ ids: [lead.id], isJunk: true });
          // setJunk toasts on its own; don't double up.
        } else if (eff.patch) {
          await updateLead.mutateAsync({ id: lead.id, patch: eff.patch });
          toast.success(eff.toast, eff.undoable ? {
            action: {
              label: "Undo",
              /* Restores the exact previous value, including null. "Undo" that reset
                 the field to today would be a second change wearing the label of a
                 reversal. */
              onClick: () => {
                updateLead.mutate({ id: lead.id, patch: { follow_up_date: previousFollowUp } });
              },
            },
          } : undefined);
        } else if (eff.toast) {
          /* Sirf-stage wale chip ("Baat hui", "Demo hua", "Trial shuru") ka koi patch nahi
             hota, isliye upar wali koi shakha nahi chalti — aur bina is line ke unka tap
             chup rehta.

             Shart me pehle `eff.stage?.nextStage` bhi tha, aur wo GALAT tha: Contacted
             lead par "Baat hui" dabane se stage nahi hilta (wo pehle se aage hai), to
             confirmation gायab ho jata aur tap bekaar laga — jabki call darj ho chuki
             hoti. Call ka darj hona hi wo cheez hai jo poochhi gayi thi.

             Undo yahan jaan-boojh kar nahi: in sab par `undoable: false` hai, aur upar
             wala Undo `follow_up_date` lautata hai, jise inhone chhua hi nahi. */
          toast.success(eff.toast);
        }
      } catch {
        // Both mutations roll their optimistic write back and toast the error.
        return;
      }

      if (eff.activity) {
        // Fire-and-forget: a failed log must not undo a visible follow-up change.
        logActivity.mutate({ leadId: lead.id, kind: eff.activity.kind, detail: eff.activity.detail });
      }
    },
    [updateLead, setJunk, logActivity, changeStage, router],
  );
}
