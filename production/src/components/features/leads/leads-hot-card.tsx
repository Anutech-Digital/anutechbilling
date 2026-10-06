"use client";
/**
 * "Lead intelligence · Today" — the top hot lead with Call / Send nudge. Moved verbatim out of
 * (app)/leads/page.tsx (S35, 28 Sep 2026); it was an inline IIFE. The page decides WHEN it
 * renders (loaded, has leads, not the sales role, not searching); the open/closed choice
 * stays in the page too, so it is read from storage before the card first appears.
 *
 * "Hot leads" = highest-value rows in quote/trial stages — these convert at the highest rate
 * per the prototype-era data, and they're the ones a rep should actually touch today.
 */
import * as React from "react";
import { toast } from "sonner";
import { GeminiCard } from "@/components/shared/gemini-card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import type { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { LeadCounts } from "@/lib/leads/list-page";
import { leadTitle } from "@/lib/leads/display-name";

export interface LeadsHotCardProps {
  /** Quote / trial leads in the current list — lead_counts().list.hot (S40). */
  hotCount: number;
  /** The highest-value one of them — lead_counts().list.hot_top. */
  topHot: LeadCounts["list"]["hot_top"];
  currentUser: ReturnType<typeof useCurrentUser>["data"];
  tipsOpen: boolean;
  toggleTips: () => void;
}

/* S40: the count and the top lead come from the server, over the WHOLE list and not the
   page of it that is loaded — same rule as before: quote or trial, highest value first. */
export function LeadsHotCard({ hotCount, topHot, currentUser, tipsOpen, toggleTips }: LeadsHotCardProps) {
  // The new Insight band (KPI pills + pulse) already surfaces "Hot"
  // count at the top of the page. Showing this card with a "0 hot
  // leads" empty state is just noise. Render only when there's
  // actually a hot lead to act on. Sales role gets the band only —
  // this card is owner/manager territory (it surfaces aggregate
  // tenant info beyond the rep's individual book).
  if (hotCount === 0) return null;

  const handleCallTop = () => {
    if (!topHot) { toast.info("No hot leads right now"); return; }
    if (!topHot.contact_phone) {
      toast.error(`${leadTitle(topHot).label} has no phone on record.`, { description: "Open the lead and add a phone number, then call." });
      return;
    }
    // tel: schemes ignore spaces but be defensive
    window.location.href = `tel:${topHot.contact_phone.replace(/\s+/g, "")}`;
  };

  const handleSendNudge = () => {
    if (!topHot) { toast.info("No hot leads right now"); return; }
    if (!topHot.contact_email) {
      toast.error(`${leadTitle(topHot).label} has no email on record.`, { description: "Open the lead and add an email, then send the nudge." });
      return;
    }
    const signoff = currentUser?.tenantName ?? "your team";
    const subject = `Following up · ${leadTitle(topHot).label}`;
    const body =
      `Hi ${topHot.contact_name ?? "there"},\n\n` +
      `Just checking in on ${topHot.plan ? `the ${topHot.plan} discussion` : "your inquiry"}. ` +
      `Let me know if you have any questions or want to set up a quick call.\n\n` +
      `— ${signoff}`;
    window.location.href = `mailto:${topHot.contact_email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  return (
    // Hidden on mobile — eats vertical real estate that sales reps need
    // for the actual lead list. Desktop keeps it visible since there's
    // plenty of width.
    <div className="mb-4 hidden md:block">
      {tipsOpen ? (
        <GeminiCard
          title="Lead intelligence · Today"
          actions={
            <>
              <Button size="sm" variant="primary" icon="phone" disabled={!topHot} onClick={handleCallTop}>
                {topHot ? `Call ${leadTitle(topHot).label.split(/\s+/)[0]}` : "Call top lead"}
              </Button>
              <Button size="sm" icon="mail" disabled={!topHot} onClick={handleSendNudge}>Send nudge</Button>
            </>
          }
          /* Out of the action row and into the corner. It was reading as a third action
             next to "Call" and "Send nudge", which left it unclear what it collapsed. */
          collapse={
            <Button size="sm" variant="ghost" icon="chevron_up" aria-label="Hide tips" onClick={toggleTips} />
          }
        >
          <b className="text-ink">{hotCount} hot lead{hotCount === 1 ? "" : "s"} worth focusing today.</b>{" "}
          {topHot
            ? <>Top: <b>{leadTitle(topHot).label}</b> ({topHot.plan ?? "—"}, {topHot.value ? rupee(topHot.value, { compact: true }) : "value pending"}). Quote/Trial stages convert highest — prioritize today.</>
            : <>No leads in Quote Sent or Trial Active right now. Move some forward to surface hot opportunities.</>}
        </GeminiCard>
      ) : (
        <button
          type="button"
          onClick={toggleTips}
          className="w-full flex items-center justify-between gap-2 rounded-lg border border-hairline bg-paper-2/40 px-3 py-1.5 text-xs text-ink-2 hover:bg-paper-2"
        >
          <span className="inline-flex items-center gap-1.5">
            <Icon name="sparkles" size={13} className="text-amber-ink" />
            Lead intelligence · <b className="text-ink">{hotCount}</b> hot lead{hotCount === 1 ? "" : "s"} today
          </span>
          <span className="inline-flex items-center gap-1 text-ink-3"><Icon name="chevron_down" size={13} /> Show</span>
        </button>
      )}
    </div>
  );
}
