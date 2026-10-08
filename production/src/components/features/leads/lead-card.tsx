/* Explicit, now that this card reads the tenant identity through a hook. It was
   already only ever imported from client trees, so this changes nothing at runtime —
   it just stops the next reader wondering whether the hook is legal here. */
"use client";

import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { rupee, initials, formatDate } from "@/lib/utils";
import { getLeadWhatsAppUrl } from "@/lib/whatsapp";
import { useWhatsAppSender } from "@/lib/hooks/useWhatsAppSender";
import { intentMeta, staleWarning, isHighValueLead } from "@/lib/leads/heat";
import { CloseDateBadge } from "@/components/features/leads/close-date-badge";
import type { LeadListRow } from "@/lib/leads/list-page";
import { cn } from "@/lib/utils";
import { leadTitle } from "@/lib/leads/display-name";

interface LeadCardProps {
  lead: LeadListRow;
  isDragging?: boolean;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
  onClick?: (lead: LeadListRow) => void;
  onQuickQuote?: (lead: LeadListRow) => void;
  dupCount?: number;
  onOpenMerge?: (lead: LeadListRow) => void;
}


export function LeadCard({ lead, isDragging, onDragStart, onDragEnd, onClick }: LeadCardProps) {
  const waSender = useWhatsAppSender();
  const ownerInitials = lead.contact_name ? initials(lead.contact_name) : "—";
  const age = formatDate(lead.created_at, "relative");
  const isHighValue = isHighValueLead(lead);

  // Intent + staleness come from lib/leads/heat — the SAME helpers the list view
  // and the mobile card use. This card used to carry its own third definition
  // (`isHot` required priority==="high" AND an advanced stage, `isWarm` keyed off
  // demo/medium), so one lead could read "Hot" on the board and plain in the
  // list. heat.ts exists precisely to stop that; the local copy is gone.
  const intent = intentMeta(lead);
  const stale7 = staleWarning(lead);

  const handleWhatsApp = (e: React.MouseEvent) => {
    e.stopPropagation();
    /* Signed with THIS tenant. The message used to end "*Excel Technologies*" for
       every reseller who ever used the app — see lib/whatsapp.ts. */
    const url = getLeadWhatsAppUrl(lead, null, waSender);
    window.open(url, "_blank");
  };

  return (
    <div
      data-lead-id={lead.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", lead.id);
        onDragStart?.(lead.id);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onClick?.(lead)}
      className={cn(
        "bg-paper border rounded-lg p-3 group relative transition-all duration-150 hover:shadow-sm",
        "cursor-grab active:cursor-grabbing",
        isHighValue
          ? "border-emerald/50 ring-1 ring-emerald/15 shadow-sm"
          : "border-hairline hover:border-hairline-strong",
        isDragging && "opacity-40 -rotate-[1.5deg] shadow-md"
      )}
    >
      {/* Top row: Company name + Intent micro-badge + Owner Avatar */}
      <div className="flex justify-between items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[13px] font-semibold text-ink leading-tight truncate" title={leadTitle(lead).hint ?? leadTitle(lead).label}>
              {/* R-279: company, else the contact's name — never a blank title. */}
              {leadTitle(lead).label}
            </span>
            {/* Design tokens, not raw Tailwind palette values (§5) — the old
                bg-rose-100/dark:bg-rose-950 pair bypassed the theme. */}
            <span
              title={`${intent.label} — ${intent.reason}`}
              className={cn(
                "px-1 py-0.5 rounded text-3xs font-bold leading-none",
                intent.tier === "hot"  && "bg-rose-soft text-rose-ink",
                intent.tier === "warm" && "bg-amber-soft text-amber-ink",
                intent.tier === "cold" && "bg-paper-3 text-ink-3 border border-hairline",
              )}
            >
              {intent.tier === "hot" ? "🔥 Hot" : intent.tier === "warm" ? "⚡ Warm" : "❄️ Cold"}
            </span>
            {stale7 && (
              <span
                title={stale7.message}
                className="inline-flex items-center gap-1 px-1 py-0.5 rounded text-3xs font-bold leading-none bg-amber-soft/70 text-amber-ink border border-amber/30"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                {stale7.days}d
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* 1-Click WhatsApp Quick Action */}
          {lead.contact_phone && (
            <button
              type="button"
              onClick={handleWhatsApp}
              className="p-1 text-emerald hover:bg-emerald-50 dark:hover:bg-emerald-950/40 rounded transition-colors"
              title={`WhatsApp ${lead.contact_name || leadTitle(lead).label}`}
            >
              <Icon name="whatsapp" size={13} />
            </button>
          )}

          {lead.contact_name && (
            <Avatar initials={ownerInitials} color="indigo" size="sm" />
          )}
        </div>
      </div>

      {/* Seats · plan */}
      <div className="text-xs text-ink-3 mt-1.5 truncate" title={`${lead.seats ?? "—"} seats · ${lead.plan ?? "—"}`}>
        {lead.seats ?? "—"} seats · {lead.plan ?? "—"}
      </div>

      {/* Bottom row: Value (serif) | Age & Stale Indicator */}
      {/* WHY THE AI STOPPED — the reason, not a badge saying there is one.
          The agent already writes a sentence a non-engineer can act on ("38 seats is above
          the 50-seat ceiling for automatic quoting"). Until 24 Aug 2026 that sentence lived
          only in the database, and the rep's only route to it was opening the lead and
          reading its timeline. A queue you have to open to triage is not a queue.
          Rendered above the value line and clamped to two lines: it is the reason this card
          is in front of you, so it outranks the money. */}
      {lead.requires_human_attention === true && (
        <div className="mt-2 rounded-md bg-rose-soft/60 px-2 py-1.5">
          <p className="text-3xs font-semibold uppercase tracking-wide text-rose">
            AI stopped — needs you
          </p>
          {lead.human_attention_reason ? (
            <p className="mt-0.5 text-xs leading-snug text-ink-2 line-clamp-2"
               title={lead.human_attention_reason}>
              {lead.human_attention_reason}
            </p>
          ) : (
            /* Flagged with no reason should not happen — the dispatcher writes both together.
               Said plainly rather than rendered as an empty box, because a blank explanation
               reads as "no reason to worry" when it means the opposite. */
            <p className="mt-0.5 text-xs leading-snug text-ink-3">
              No reason was recorded — open the lead&apos;s timeline.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-2.5 pt-2 border-t border-hairline">
        <span className={cn("font-serif tabular-nums text-sm font-bold inline-flex items-center gap-1", isHighValue ? "text-emerald" : "text-amber-ink")}>
          {isHighValue && <span aria-hidden className="text-xs">★</span>}
          {lead.value !== null ? rupee(lead.value, { compact: true }) : "—"}
        </span>

        {/* The stale badge lives next to the company name above (one per card).
            A second one used to sit here computed from `created_at`, so a lead
            created 30 days ago but worked on yesterday was labelled "30d" —
            it measured the lead's AGE, not neglect. */}
        <div className="flex items-center gap-1.5 text-xs text-ink-3">
          <CloseDateBadge lead={lead} />
          <span>{age}</span>
        </div>
      </div>
    </div>
  );
}
