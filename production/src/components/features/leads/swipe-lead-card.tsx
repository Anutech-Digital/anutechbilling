/**
 * SwipeLeadCard — mobile lead card with swipe-action gestures.
 *
 * Replaces the inline card list previously inside LeadListView. Goals:
 *   1. **Density** — fit 3-4 cards per phone screen instead of 2.
 *      The card is now 3 visual rows: header (co + ₹ + seats), contact line,
 *      meta+actions line (stage chip · follow-up · inline action icons).
 *   2. **Swipe gestures (the "power" layer)** —
 *        • Drag right ≥ 80px  →  Contacted (stage → contact; refused if already past it)
 *        • Drag left  ≥ 80px  →  Snooze to tomorrow
 *        • Drag up    ≥ 80px  →  WhatsApp (wa.me with pre-filled msg)
 *      Was right = Call, left = WhatsApp. Two of the three now WRITE rather than merely
 *      opening something, which changes what a mis-swipe costs — the reasoning and every
 *      threshold live in lib/leads/swipe-gesture.ts.
 *      Action labels reveal behind the card as the user drags. Drag
 *      threshold under 80px = no action, card snaps back. Tap (no drag)
 *      = opens the detail drawer as before.
 *   3. **Stage quick-change** — small chip on the card opens a dropdown
 *      to flip stage without entering the drawer (preserved from v1).
 *
 * Built on framer-motion's `<motion.div drag>` so we don't reinvent
 * pointer-capture, momentum, or snap-back physics. The drag is constrained
 * to the X axis so the user can still scroll the list vertically.
 *
 * Action availability:
 *   - No phone on the lead   →  swipe gestures are disabled.
 *   - No email on the lead   →  the inline email icon hides.
 *   - hasContact === false   →  card stays static (drag disabled), tap-only.
 *
 * @example
 *   <SwipeLeadCard
 *     lead={lead}
 *     onTap={openDrawer}
 *     onChangeStage={(s) => updateStage.mutate({ id: lead.id, stage: s })}
 *   />
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { StatusPill } from "@/components/ui/status-pill";
import { motion, useMotionValue, useTransform, type PanInfo } from "framer-motion";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { rupee, cn, formatDate } from "@/lib/utils";
import { intentMeta, staleWarning } from "@/lib/leads/heat";
import { heatScore, heatBadge } from "@/lib/leads/heat-score";
import { decideSwipe, SWIPE_TRIGGER_PX } from "@/lib/leads/swipe-gesture";
import { chipsForStage, type LeadOutcome } from "@/lib/leads/outcomes";
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadListRow } from "@/lib/leads/list-page";
import { istToday } from "@/lib/dates/ist";
import { CloseDateBadge } from "@/components/features/leads/close-date-badge";
import { leadTitle } from "@/lib/leads/display-name";

// LEAD_STAGES mirrors the array in leads/page.tsx — kept here as a small
// constant to avoid coupling the swipe card to that file's internals. If
// these labels diverge in the future we can lift to `lib/lead-stages.ts`.
const LEAD_STAGES: { id: Lead["stage"]; label: string; dot: string }[] = [
  { id: "new",     label: "New",          dot: "bg-slate"   },
  { id: "contact", label: "Contacted",    dot: "bg-amber"   },
  { id: "demo",    label: "Demo Done",    dot: "bg-indigo"  },
  { id: "trial",   label: "Trial Active", dot: "bg-rose"    },
  { id: "quote",   label: "Quote Sent",   dot: "bg-indigo"  },
  { id: "won",     label: "Won",          dot: "bg-emerald" },
  { id: "lost",    label: "Lost",         dot: "bg-ink-3"   },
];

// Drag thresholds now live in lib/leads/swipe-gesture.ts, beside the logic that uses
// them. Two copies of "80" is how a reveal panel ends up appearing at a different point
// from where the action actually fires.

interface SwipeLeadCardProps {
  lead: LeadListRow;
  /** Tap (no drag) → open the lead drawer. */
  onTap: (lead: LeadListRow) => void;
  /** Mutate the lead's stage when the user picks one from the chip menu. */
  onChangeStage: (stage: Lead["stage"]) => void;
  /** Direct "Send quote" — carries lead context into the quote builder. */
  onSendQuote?: (lead: LeadListRow) => void;
  /**
   * Runs a call-outcome (lib/leads/outcomes.ts). Used by BOTH the left swipe and the
   * outcome chip row, so a gesture and a tap can never mean different things.
   */
  onOutcome?: (outcome: LeadOutcome, lead: LeadListRow) => void;
  /**
   * Is lead ki sabse nayi quote (id + status), useLeadQuotes ke map se. Optional —
   * jis caller ke paas map nahi, card waise hi chalta hai. Pardeep, 31 Aug 2026:
   * "lead se pata lage ki quote bheja gaya ya nahi, aur wahin se khule."
   */
  quoteRef?: { id: string; status: string | null };
  /** Earliest open follow-up task on this lead, if any (shows a chip). */
  task?: { due: string; overdue: boolean; count: number };
  /**
   * Whose lead, when it is NOT the viewer's — the caller passes nothing for your own leads.
   * On a phone-width list there is no Owner column, so in Team view someone else's lead
   * looked exactly like yours (29 Sep 2026).
   */
  ownerName?: string | null;
}

export function SwipeLeadCard({ lead, onTap, onChangeStage, onSendQuote, onOutcome, task, quoteRef, ownerName }: SwipeLeadCardProps) {
  // Derived here rather than passed in, so the card is the single place that
  // decides how a lead looks on mobile — callers can't hand it a stale rule
  // that disagrees with the desktop table.
  const intent = intentMeta(lead);
  /* The 0-100 score. Kept alongside intentMeta because they answer different questions:
     intentTier is "should I act on this today", heatScore is "how good is this lead".
     A high-score lead that has gone quiet is the most valuable combination either can
     surface, and one number cannot say both. */
  const heat  = heatScore(lead);
  const badge = heatBadge(heat.band);
  const stale7 = staleWarning(lead);
  const stageMeta = LEAD_STAGES.find((s) => s.id === lead.stage);

  /* Yahan "quote-first funnel gating" ka ek `stageOptions` list tha, jo card ke stage
     dropdown ko khilata tha. Wo dropdown 26 Aug 2026 ko hata diya gaya — stage ab kaam se
     badalta hai, haath se nahi — isliye ye list bhi gayi. Us niyam ka asli ghar ab
     `lib/leads/stage-advance.ts` hai, jahan wo tested hai aur teeno surface ek jaisa
     bartaav karte hain. */

  // Phone normalisation for wa.me + tel: — assume Indian +91 if 10 digits.
  const phoneDigits = (lead.contact_phone ?? "").replace(/\D/g, "");
  const waNumber    = phoneDigits.startsWith("91")
    ? phoneDigits
    : (phoneDigits.length === 10 ? `91${phoneDigits}` : phoneDigits);
  const hasPhone    = phoneDigits.length >= 10;
  const hasEmail    = Boolean(lead.contact_email);

  const waMessage = buildWaMessage(lead);
  const followUp  = followUpLabel(lead.follow_up_date);
  const prio      = priorityDot(lead.priority);

  /* ── Drag state ─────────────────────────────────────────────────────────────
     Right = contacted · left = snooze to tomorrow · up = WhatsApp. Which action a
     gesture means is decided by `decideSwipe` in lib/leads/swipe-gesture.ts — pure and
     fully tested, because you cannot assert on a finger and two of these three now
     WRITE to the lead. Read that file's header for why that changed the stakes. */
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const contactedOpacity = useTransform(x, [0, SWIPE_TRIGGER_PX], [0, 1]);
  const snoozeOpacity    = useTransform(x, [-SWIPE_TRIGGER_PX, 0], [1, 0]);
  const whatsAppOpacity  = useTransform(y, [-SWIPE_TRIGGER_PX, 0], [1, 0]);

  // Track whether the gesture qualified as a drag — used to suppress the
  // tap-open on dragEnd (without this, a swipe also opens the drawer).
  const wasDragRef = React.useRef(false);

  const handleDragEnd = (_e: unknown, info: PanInfo) => {
    const decision = decideSwipe({
      dx: info.offset.x, dy: info.offset.y,
      vx: info.velocity.x, vy: info.velocity.y,
      hasPhone, stage: lead.stage,
    });

    if (decision.wasDrag) {
      wasDragRef.current = true;
      // 250ms after a real action, 150ms after a mere half-swipe — long enough that the
      // pointer-up does not land as a tap, short enough not to eat the next one.
      const settle = decision.action ? 250 : 150;
      setTimeout(() => { wasDragRef.current = false; }, settle);
    }

    /* A refusal is spoken, not swallowed. Without this a rep swipes a quote-stage deal
       right, nothing happens, and they conclude the gesture is broken. */
    if (decision.refusal) { toast.info(decision.refusal); return; }

    switch (decision.action) {
      case "contacted":
        // Writes. onChangeStage is optimistic with rollback (queries/leads.ts).
        onChangeStage("contact");
        break;
      case "snooze":
        // Writes, via the same rule the outcome chips use — a gesture and a tap must
        // not be two different behaviours.
        onOutcome?.("call_tomorrow", lead);
        break;
      case "whatsapp":
        window.open(
          `https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`,
          "_blank",
          "noopener,noreferrer",
        );
        break;
      case null:
        break;
    }
  };

  const handleCardTap = () => {
    if (wasDragRef.current) return;
    onTap(lead);
  };

  return (
    <li className="relative overflow-hidden rounded-lg">
      {/* Behind-card reveal panels — visible only as the card drags out of the way, and
          each one NAMES its action before the gesture completes. That label is the only
          warning a rep gets before a write, which is why it reads "Contacted" and not a
          bare tick. Emerald right = Contacted · amber left = Tomorrow · indigo up =
          WhatsApp. pointer-events-none so they don't intercept taps. */}
      <motion.div
        className="absolute inset-y-0 left-0 w-1/2 flex items-center justify-start px-4 bg-emerald rounded-l-lg text-paper pointer-events-none"
        style={{ opacity: contactedOpacity }}
      >
        <Icon name="check" size={20} />
        <span className="ml-2 font-semibold text-sm">Contacted</span>
      </motion.div>
      <motion.div
        className="absolute inset-y-0 right-0 w-1/2 flex items-center justify-end px-4 bg-amber rounded-r-lg text-paper pointer-events-none"
        style={{ opacity: snoozeOpacity }}
      >
        <span className="mr-2 font-semibold text-sm">Tomorrow</span>
        <Icon name="clock" size={20} />
      </motion.div>
      <motion.div
        className="absolute inset-x-0 bottom-0 h-1/2 flex items-center justify-center bg-indigo rounded-b-lg text-paper pointer-events-none"
        style={{ opacity: whatsAppOpacity }}
      >
        <Icon name="whatsapp" size={20} />
        <span className="ml-2 font-semibold text-sm">WhatsApp</span>
      </motion.div>

      {/* The draggable card itself.
          `dragDirectionLock` is what makes a vertical gesture safe inside a vertically
          scrolling list: Framer commits to the axis the gesture STARTS on, so a page
          scroll can never be mistaken for an upward pull. decideSwipe's dominant-axis
          check is the second gate. Drag stays disabled with no phone — otherwise the
          panels would promise actions that cannot run. */}
      <motion.div
        drag={hasPhone ? true : false}
        dragDirectionLock
        dragConstraints={{ left: -120, right: 120, top: -110, bottom: 0 }}
        dragElastic={0.2}
        dragSnapToOrigin
        onDragEnd={handleDragEnd}
        style={{ x, y, touchAction: "pan-y" }}
        className="relative bg-paper border border-hairline rounded-lg"
        data-lead-id={lead.id}
      >
        {/* A div (not a <button>) so the action buttons inside it are valid HTML
            — a <button> can't contain <button>s (hydration error). Kept
            keyboard-accessible with role/tabIndex + Enter/Space. */}
        <div
          role="button"
          tabIndex={0}
          onClick={handleCardTap}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCardTap(); } }}
          className="block w-full text-left p-3 active:bg-paper-2/50 rounded-lg cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/50"
        >
          {/* ── Row 1 — poori pehchan EK line me (26 Aug 2026, Pardeep ke kehne par) ────
              Pehle ye do line thi: company upar, "contact · phone" neeche, aur email
              kahin bhi nahi. Ab company, contact ka naam, email aur mobile ek hi line me
              hain — card ki ek poori line bach gayi.

              `flex-wrap` jaan-boojh kar: 1200px par ye sach me ek line hai, par 375px ke
              phone par paanch cheezein ek line me nahi aa saktin. Wahan `truncate` lagane
              ka matlab hota email ya number ka aadha gायab hona — yaani wahi cheez chhup
              jati jise dikhane ke liye ye badla gaya. Wrap hone dena imaandar hai. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
                <span className={cn("w-2 h-2 rounded-full shrink-0", prio.color)} title={prio.title} />
                <p className="font-medium text-ink truncate text-[15px]" title={leadTitle(lead).hint ?? undefined}>{leadTitle(lead).label}</p>
                {/* Intent tier + stale nudge — same lib/leads/heat helpers the
                    desktop table uses, so phone and desktop can never disagree
                    about the same lead. (The old `stale` prop used its own
                    14-day rule while the table used another — that drift is why
                    these live in one file now.) */}
                {/* The 0-100 heat score REPLACES the old emoji-only intent tier here
                    rather than sitting next to it. Two temperature badges with two
                    emoji sets (🔥/⚡/❄️ vs 🔥/☀️/❄️) on one card is exactly the drift
                    this file's own comment above warns about. The score is strictly
                    richer: it carries a number, so two hot leads are comparable, and a
                    tooltip that says WHY. `intent.reason` is folded into that tooltip so
                    nothing is lost. A "+" means some input was missing — see
                    lib/leads/heat-score.ts. */}
                <span
                  title={`${heat.score}/100 ${badge.label} · ${heat.reasons.join(" · ")}` +
                    (heat.incomplete ? "\n\nSome inputs are missing, so this is a floor, not a verdict." : "") +
                    `\n\nAct-now signal: ${intent.label} — ${intent.reason}`}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-0.5 rounded-full text-3xs font-semibold px-1.5 py-0.5 leading-none tabular-nums",
                    heat.band === "hot"  && "bg-rose-soft text-rose-ink",
                    heat.band === "warm" && "bg-amber-soft text-amber-ink",
                    heat.band === "cold" && "bg-paper-3 text-ink-3 border border-hairline",
                  )}
                >
                  {badge.emoji} {heat.score}{heat.incomplete ? "+" : ""}
                </span>
                {stale7 && (
                  <span
                    title={stale7.message}
                    className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-soft/70 text-amber-ink text-3xs font-semibold px-1.5 py-0.5 leading-none border border-amber/30"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                    {stale7.days}d
                  </span>
                )}
                {/* Contact ki teen cheezein, usi line me. Separator sirf UN cheezo ke
                    beech aata hai jo maujood hain — warna bina email wali lead par
                    "Pardeep sharma ·  · +91…" jaisa latakta hua dot bachta hai. */}
                {[lead.contact_name, lead.contact_email, lead.contact_phone]
                  .filter((v): v is string => Boolean(v && v.trim()))
                  .map((v, i) => (
                    <span key={v} className="min-w-0 max-w-full truncate text-xs text-ink-3" title={v}>
                      {i > 0 && <span className="text-ink-3"> · </span>}
                      {v}
                    </span>
                  ))}
              </div>
              {ownerName && (
                <span className="mt-1 mr-1 inline-flex items-center gap-1 rounded-full bg-paper-2 px-1.5 py-0.5 text-3xs font-medium text-ink-2" title={`Owner: ${ownerName}`}>
                  <Icon name="user" size={10} />
                  {ownerName}
                </span>
              )}
              {task && (
                <span className={cn(
                  "mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium",
                  task.overdue ? "bg-rose-soft text-rose-ink" : "bg-amber-soft text-amber-ink",
                )}>
                  <Icon name="clock" size={10} />
                  {task.overdue ? "Task overdue" : "Task"} · {formatDate(task.due)}
                  {task.count > 1 ? ` (+${task.count - 1})` : ""}
                </span>
              )}
            </div>
            {/* Right-rail: ₹ value + seats stacked. */}
            <div className="text-right shrink-0">
              <p className="font-serif text-base tabular-nums text-ink leading-none">
                {lead.value ? rupee(lead.value, { compact: true }) : "—"}
              </p>
              <CloseDateBadge lead={lead} className="block text-xs mt-0.5" />
              {lead.seats && (
                <p className="text-xs text-ink-3 tabular-nums mt-0.5">{lead.seats} seats</p>
              )}
              {/* Quote ka sach mobile par bhi — wahi pill jo desktop ke PLAN cell me
                  hai (Pardeep, 31 Aug 2026). Tap quote kholta hai; stopPropagation
                  warna card ka onTap drawer khol deta. Rang ke saath SHABD bhi. */}
              {quoteRef && (
                <Link
                  href={`/quotes/${quoteRef.id}` as never}
                  onClick={(e) => e.stopPropagation()}
                  title={`Open ${quoteRef.id}`}
                  className="mt-1 inline-flex"
                >
                  <StatusPill
                    status={quoteRef.status ?? "draft"}
                    size="sm"
                    label={`…${quoteRef.id.slice(-4)} · ${(quoteRef.status ?? "draft").charAt(0).toUpperCase() + (quoteRef.status ?? "draft").slice(1)}`}
                  />
                </Link>
              )}
            </div>
          </div>

          {/* Row 3 — stage chip + follow-up pill + inline action icons.
              All laid on a single line to compress the card height. */}
          <div className="flex items-center justify-between gap-2 mt-2 min-w-0">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {/* ── Stage: padhne ke liye, badalne ke liye nahi (26 Aug 2026) ──────────
                  Yahan ek "Move {company} to…" wala dropdown tha. Desktop table row se wo
                  us din hata diya gaya tha, par YE chhoot gaya — aur 1280px se chhoti
                  window par card hi dikhta hai, table nahi. Yaani Pardeep ki screen par
                  manual stage change poore din zinda raha jabki maine use hata diya
                  samajh liya tha.

                  Stage ab kaam se badalta hai — ⋯ menu ke outcome, quote jana, ya
                  right-swipe. Sudhaarna ho to lead kholiye: drawer me override hai. */}
              {stageMeta && (
                <span
                  title="Stage updates on its own. To change it, open the lead."
                  className="inline-flex items-center gap-1 text-xs font-medium text-ink-2 px-1.5 py-0.5 shrink-0"
                >
                  <span className={cn("w-1.5 h-1.5 rounded-full", stageMeta.dot)} />
                  {stageMeta.label}
                </span>
              )}
              {followUp && (
                <span
                  className={cn(
                    "text-3xs font-medium rounded-full px-1.5 py-0.5 shrink-0 inline-flex items-center gap-1",
                    followUp.tone === "rose"  && "bg-rose-soft text-rose-ink",
                    followUp.tone === "amber" && "bg-amber-soft text-amber-ink",
                    followUp.tone === "ink-3" && "bg-paper-2 text-ink-3",
                  )}
                >
                  <Icon name="clock" size={9} />
                  {followUp.text}
                </span>
              )}
              {/* An existing customer's new need (leads.customer_id) — says upsell, not stranger. */}
              {lead.customer_id && (
                <span className="text-3xs px-1.5 py-0.5 rounded bg-emerald/10 text-emerald shrink-0">Existing customer</span>
              )}
              {/* Plan text — truncates when space tight. Shown for context. */}
              <span className="text-xs text-ink-3 truncate min-w-0">
                {lead.plan || "No plan"}
              </span>
            </div>

            {/* ── Ek ⋯ menu, jaisa /customers par hai (26 Aug 2026, Pardeep ke kehne par)
                Pehle yahan teen contact icon the (Call / WhatsApp / Email) aur neeche ek
                alag line me saat outcome chips. Do alag jagah, aur card ki teen line me
                se ek poori unhi me chali jati thi.

                LAAGAT SAAF KEHNI CHAHIYE: chips 1-tap the, ab do tap hain. Ek rep call
                list par kaam karte waqt ye mehsoos karega. Do cheezein isse sambhal leti
                hain — right-swipe abhi bhi seedha "contacted" karta hai (neeche hint
                maujood hai), aur menu me sirf wahi outcome aate hain jo is stage par
                sach me agla kadam hain, isliye list chhoti rehti hai.

                Ek hi menu me dono kism: pehle "abhi karo" (call/WhatsApp/email), phir
                "jo hua wo darj karo" (outcomes). Alag-alag menu banane se wahi do-jagah
                wali dikkat wapas aa jati. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Actions for ${leadTitle(lead).label}`}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-3 hover:bg-paper-2 active:bg-paper-2/70"
                >
                  <Icon name="more_h" size={16} />
                </span>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[13rem]"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {(hasPhone || hasEmail) && (
                  <>
                    <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">
                      Contact
                    </DropdownMenuLabel>
                    {hasPhone && (
                      <DropdownMenuItem asChild className="cursor-pointer gap-2.5 py-2">
                        <a href={`tel:${lead.contact_phone}`}>
                          <Icon name="mobile" size={15} className="text-emerald" /> Call
                        </a>
                      </DropdownMenuItem>
                    )}
                    {hasPhone && (
                      <DropdownMenuItem asChild className="cursor-pointer gap-2.5 py-2">
                        <a
                          href={`https://wa.me/${waNumber}?text=${encodeURIComponent(waMessage)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Icon name="whatsapp" size={15} className="text-emerald" /> WhatsApp
                        </a>
                      </DropdownMenuItem>
                    )}
                    {hasEmail && (
                      <DropdownMenuItem asChild className="cursor-pointer gap-2.5 py-2">
                        <a
                          href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.contact_email ?? "")}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          <Icon name="mail" size={15} className="text-indigo" /> Email
                        </a>
                      </DropdownMenuItem>
                    )}
                  </>
                )}

                {onOutcome && (hasPhone || hasEmail) && <DropdownMenuSeparator />}

                {/* Outcomes — wahi component ke rules jo desktop row aur call queue par
                    lagte hain, sirf render alag hai. `chipsForStage` isliye ki menu me
                    wahi cheez aaye jo is stage par sach me agla kadam hai; baaki ko niyam
                    waise bhi mana kar deta, yaani wo aisa button hota jo kuch na kare. */}
                {onOutcome && (
                  <>
                    <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">
                      Log outcome
                    </DropdownMenuLabel>
                    {chipsForStage(lead.stage).map((chip) => {
                      const blocked = chip.needsPhone && !hasPhone;
                      return (
                        <DropdownMenuItem
                          key={chip.id}
                          disabled={blocked}
                          title={blocked
                            ? `${chip.hint}\n\nNo phone number on this lead — add one first.`
                            : chip.hint}
                          onSelect={() => {
                            /* "Send quote" caller ka apna handler pasand karta hai: page ka
                               goSendQuote contact naam, email aur phone bhi quote builder
                               me le jata hai — use-outcome.ts ki generic navigation se
                               zyada. */
                            if (chip.id === "send_quote" && onSendQuote) { onSendQuote(lead); return; }
                            onOutcome(chip.id, lead);
                          }}
                          className={cn(
                            "cursor-pointer gap-2.5 py-2 text-sm",
                            chip.tone === "rose" && "text-rose",
                          )}
                        >
                          <Icon name={chip.icon} size={15} />
                          {chip.label}
                        </DropdownMenuItem>
                      );
                    })}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* ── Gesture hint: SIRF touch device par (26 Aug 2026) ────────────────────
              Ye line har card par chhapti thi, aur Pardeep ne theek poochha — "iski yahan
              kya jarurat hai".

              Wajah ye thi ki ye card `xl` se NEECHE har width par render hota hai, aur
              usme laptop bhi aa jaate hain. Mouse se swipe hoti hi nahi. Yaani ek laptop
              par ye teen shabd ek aise feature ka vigyapan the jo wahan chal hi nahi
              sakta — aur card ki chauthi line kha rahe the.

              Width se nahi, POINTER se pooch rahe hain. `pointer: coarse` ka matlab ungli
              (phone/tablet); mouse wale device par ye line hoti hi nahi. Hatayi isliye
              nahi ki phone par swipe ka pata sirf isi se chalta hai — gesture apne aap me
              invisible hota hai jab tak koi bataye na. */}
          {hasPhone && (
            <p className="mt-1.5 hidden text-xs leading-none text-ink-3 [@media(pointer:coarse)]:block">
              Swipe → contacted · ← tomorrow · ↑ WhatsApp
            </p>
          )}
        </div>
      </motion.div>
    </li>
  );
}

// ============================================================
// Helpers — kept inline to the swipe card so the file is self-contained.
// ============================================================

/** Pre-fill WhatsApp message with greeting + lead context. */
function buildWaMessage(lead: LeadListRow): string {
  const greeting = lead.contact_name ? `Hi ${lead.contact_name},` : "Hello,";
  /* R-279: no company → no dangling "for " in a message the customer reads. */
  const company = lead.company?.trim() ?? "";
  const forCompany = company ? ` for ${company}` : "";
  const ref = lead.plan
    ? `our conversation about ${lead.plan}${forCompany}`
    : `your inquiry${forCompany}`;
  return `${greeting} Following up on ${ref}. When's a good time for a quick call?`;
}

/** Follow-up date label. Returns null if no date set or far future. */
function followUpLabel(
  date: string | null,
): { text: string; tone: "rose" | "amber" | "ink-3" } | null {
  if (!date) return null;
  const today = istToday();
  if (date <  today)  return { text: "Overdue", tone: "rose"  };
  if (date === today) return { text: "Today",   tone: "amber" };
  const d = new Date(date);
  const text = d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  return { text, tone: "ink-3" };
}

/** Priority dot colour. */
function priorityDot(p: Lead["priority"] | undefined): { color: string; title: string } {
  if (p === "high")   return { color: "bg-rose",  title: "High priority"   };
  if (p === "medium") return { color: "bg-amber", title: "Medium priority" };
  return                    { color: "bg-slate", title: "Low priority"    };
}
