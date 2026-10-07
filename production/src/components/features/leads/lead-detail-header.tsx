"use client";
/**
 * The drawer's pinned header — company, stage (with the one manual override), and the
 * contact identity line that must never scroll away. Moved verbatim out of LeadDetailSheet
 * (S35, 28 Sep 2026).
 */
import * as React from "react";
import { IconButton } from "@/components/ui/button";
import { SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import type { useConfirm } from "@/components/providers/confirm-provider";
import type { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import type { Lead } from "@/lib/supabase/database.types";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";
import { leadTitle } from "@/lib/leads/display-name";

export interface LeadDetailHeaderProps {
  lead: Lead;
  stageLabel: string;
  confirm: ReturnType<typeof useConfirm>;
  changeStage: ReturnType<typeof useChangeLeadStage>["changeStage"];
  onClose: () => void;
}

export function LeadDetailHeader({ lead, stageLabel, confirm, changeStage, onClose }: LeadDetailHeaderProps) {
  return (
  <SheetHeader className="!p-5 flex flex-row items-start justify-between gap-3 border-b border-hairline">
    <div className="min-w-0 flex-1">
      <SheetTitle className="text-xl" title={leadTitle(lead).hint ?? undefined}>{leadTitle(lead).label}</SheetTitle>
      <SheetDescription className="text-xs mt-1">
        {lead.id} · <b className="text-ink">{stageLabel}</b>
      </SheetDescription>

      {/* ── Stage ka ekmatra manual raasta (26 Aug 2026) ────────────────────
          Row ka dropdown hata diya gaya: stage ab us baat se badalta hai jo lead ke
          saath sach me hui — "Baat hui", demo, trial, quote jana.

          Par SIRF-automatic ek jaal hai. Lead pehle se demo stage par aa sakti hai,
          ya koi chip galti se dab sakta hai, aur phir use theek karne ka koi tarika
          nahi bachta — CLAUDE.md §24 aise dead-end ko saaf mana karta hai. Isliye
          yahan raasta khula hai, par jaan-boojh kar MEHNGA: lead kholo, phir
          confirm karo.

          Ye peechhe bhi le ja sakta hai — yahi iska poora maqsad hai. Forward-only
          guard chips par lagta hai, taaki ek tap galti se pipeline na hilaye; ye
          insaan ka soch-samajh kar liya gaya faisla hai, tap nahi.

          `changeStage` hi wo darwaza hai jo `lost` par loss-reason poochhta hai. */}
      <div className="mt-1.5 flex items-center gap-1.5">
        <label htmlFor="lead-stage-override" className="text-3xs uppercase tracking-wider text-ink-3">
          Change stage
        </label>
        <select
          id="lead-stage-override"
          value={lead.stage}
          onChange={async (e) => {
            const next = e.target.value as Lead["stage"];
            if (next === lead.stage) return;
            const ok = await confirm({
              title: `Change stage to ${STAGE_LABEL[next]}?`,
              body:
                `${leadTitle(lead).label} is at ${STAGE_LABEL[lead.stage]}.\n\n` +
                "Stages normally update on their own — after a call, demo, trial or quote. " +
                "A manual change may not match what actually happened.",
              confirmLabel: "Change stage",
            });
            if (ok) await changeStage(lead, next);
          }}
          aria-label={`Stage for ${leadTitle(lead).label}`}
          className="text-2xs bg-transparent px-1 py-0.5 rounded border border-hairline hover:border-hairline-strong cursor-pointer focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
        >
          {(Object.keys(STAGE_LABEL) as Lead["stage"][]).map((s) => (
            <option key={s} value={s}>{STAGE_LABEL[s]}</option>
          ))}
        </select>
      </div>

      {/* Contact identity, moved up here 23 Aug 2026 out of a card at the top of
          the scroll. The header does not scroll, and this is the one fact that must
          not scroll away: it is what stops a reply going to the wrong person. Down
          in the scroll it vanished the moment you opened the thread you were
          answering. Costs one line permanently, which is the right trade for
          something always true against something visible only at scroll-top. */}
      {(lead.contact_name || lead.contact_phone || lead.contact_email || lead.gstin) && (
        <div className="mt-1.5 flex items-center gap-2 min-w-0">
          <p className="min-w-0 flex-1 truncate text-xs text-ink-2">
            {lead.contact_name && (
              <span className="font-medium text-ink">{lead.contact_name}</span>
            )}
            {lead.contact_name && (lead.contact_phone || lead.contact_email) && " · "}
            <span className="font-mono text-xs text-ink-3">
              {lead.contact_phone}
              {lead.contact_phone && lead.contact_email && " · "}
              {lead.contact_email}
            </span>
          </p>
          {lead.gstin && (
            /* Full GSTIN in the tooltip. The badge shows the state code only, and
               the old title said just "GST Identification Number" — so the number
               itself was not readable anywhere in the drawer. */
            <span
              className="shrink-0 inline-flex items-center gap-1 rounded border border-indigo/20 bg-indigo-soft px-1.5 py-0.5 font-mono text-3xs font-semibold uppercase text-indigo-ink"
              title={`GSTIN ${lead.gstin}`}
            >
              GST {lead.gstin.slice(0, 2)}…
            </span>
          )}
        </div>
      )}
    </div>
    <IconButton icon="x" aria-label="Close" onClick={onClose} />
  </SheetHeader>
  );
}
