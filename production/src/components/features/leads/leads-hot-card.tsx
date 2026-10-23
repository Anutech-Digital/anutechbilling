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
import { dialable } from "@/lib/leads/call-queue";
import { followRevealed, isMaskedContact, usableContact } from "@/lib/contacts/reveal-client";
import type { Lead } from "@/lib/supabase/database.types";

/**
 * R-1476 (Pawan, 16 Oct 2026, Deals): the button read "Call DEMO" — the first word of the
 * company label "DEMO · Prospect 5". You call a PERSON, so the label is the contact's first
 * name; with no contact name it is a plain "Call now", never a fragment of the company.
 */
export function hotCallLabel(lead: { contact_name?: string | null }): string {
  const first = (lead.contact_name ?? "").trim().split(/\s+/)[0];
  return first ? `Call ${first}` : "Call now";
}

export interface LeadsHotCardProps {
  /** Quote / trial leads in the current list — lead_counts().list.hot (S40). */
  hotCount: number;
  /** The highest-value one of them — lead_counts().list.hot_top. */
  topHot: LeadCounts["list"]["hot_top"];
  currentUser: ReturnType<typeof useCurrentUser>["data"];
  tipsOpen: boolean;
  toggleTips: () => void;
  /** R-1476: "Add phone number" opens the top lead so the number can be filled in. */
  onOpenLead: (lead: Pick<Lead, "id">) => void;
}

/* S40: the count and the top lead come from the server, over the WHOLE list and not the
   page of it that is loaded — same rule as before: quote or trial, highest value first. */
export function LeadsHotCard({ hotCount, topHot, currentUser, tipsOpen, toggleTips, onOpenLead }: LeadsHotCardProps) {
  // The new Insight band (KPI pills + pulse) already surfaces "Hot"
  // count at the top of the page. Showing this card with a "0 hot
  // leads" empty state is just noise. Render only when there's
  // actually a hot lead to act on. Sales role gets the band only —
  // this card is owner/manager territory (it surfaces aggregate
  // tenant info beyond the rep's individual book).
  if (hotCount === 0) return null;

  /* R-1476: same rule as R-1426's call queue — a number that cannot be dialled (none, "NA",
     five digits) gets no Call button that can only fail (CLAUDE.md §24); it gets the fix. */
  /* R-1009: a masked phone ("••••••3210") still gets the Call button; the tap fetches the real
     number (logged) first. */
  const phoneMasked = Boolean(topHot) && isMaskedContact(topHot?.contact_phone);
  const num = topHot ? (phoneMasked ? "masked" : dialable(topHot.contact_phone)) : null;

  const handleSendNudge = async () => {
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
    const to = await usableContact(topHot.contact_email, { table: "leads", id: topHot.id, field: "contact_email" }, "email");
    if (!to) return;
    window.location.href = `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
              {!topHot ? (
                <Button size="sm" variant="primary" icon="phone" disabled>Call top lead</Button>
              ) : num ? (
                <Button size="sm" variant="primary" icon="phone" asChild>
                  <a
                    href={`tel:+${num}`}
                    onClick={(e) => followRevealed(e, topHot.contact_phone, { table: "leads", id: topHot.id, field: "contact_phone" }, "call",
                      (real) => { const d = dialable(real); return d ? `tel:+${d}` : null; })}
                  >
                    {hotCallLabel(topHot)}
                  </a>
                </Button>
              ) : (
                <Button
                  size="sm"
                  icon="edit"
                  onClick={() => onOpenLead(topHot)}
                  title={`No usable phone number on this lead${topHot.contact_phone ? ` ("${topHot.contact_phone}")` : ""} — open it and add a 10-digit number to call.`}
                >
                  Add phone number
                </Button>
              )}
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
