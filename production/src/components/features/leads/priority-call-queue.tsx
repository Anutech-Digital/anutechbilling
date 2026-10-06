/**
 * PriorityCallQueue — "🔥 Today's Priority Call Queue".
 *
 * The top of the Leads page: the three leads to ring right now, each with a Call and a
 * WhatsApp button big enough for a thumb, plus the four outcome chips so the rep can
 * record what happened without leaving the bar.
 *
 * ─── WHY THE BUTTONS ARE LINKS AND NOT AN INTEGRATION ───────────────────────
 * `tel:` and `https://wa.me/…` hand off to the phone's own dialler and WhatsApp app.
 * That is not a shortcut around a missing feature — it is the right mechanism for a rep
 * on a phone, and critically it needs NO credentials. The Gupshup WhatsApp keys on this
 * project are unset; a "send" button routed through the API would have failed or, worse,
 * fallen back to a stub and reported success for a message nobody received.
 *
 * ─── WHY IT SHOWS THE COUNT IT IS HIDING ────────────────────────────────────
 * The bar shows 3 of however many are due and says so ("3 of 11"). A queue that
 * silently truncates reads as "that's everything today" — which is how a rep finishes
 * their list at 11am and stops.
 *
 * ─── AND WHY IT MENTIONS THE UNREACHABLE ONES ───────────────────────────────
 * Leads due today with no phone number cannot be in a call queue. They are named
 * anyway, with a link, because a missing number is a two-second fix that nobody makes
 * if nothing ever mentions it.
 *
 * Self-hiding: nothing due, nothing rendered. A permanent "no calls today" panel is
 * the fastest way to teach someone to ignore the top of the page.
 *
 * ─── COLLAPSIBLE — AND WHAT COLLAPSING IS NOT ALLOWED TO HIDE ───────────────
 * Three rows plus the footers is roughly 360px, which pushed the Kanban board below the
 * fold on a laptop. So the panel folds, and the choice is remembered per browser.
 *
 * The rule that makes that safe: **collapsing hides the DETAIL, never the ALARM.** The
 * header keeps the count, and the "N late" badge stays on it in red. A rep who folds this
 * away still sees "3 of 8 due · 1 late" every time they open the page — they have chosen
 * not to look at the rows, not to stop being told.
 *
 * That is the whole reason this is a fold and not a dismiss. A "hide for today" button
 * would let a rep clear the warning without clearing the work, and the queue would be
 * lying by 11am — the same failure the truncation note above exists to prevent.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn, rupee, cleanDisplayName } from "@/lib/utils";
import { buildCallQueue, queueWhatsAppMessage, dialable, type QueueEntry } from "@/lib/leads/call-queue";
import { heatBadge } from "@/lib/leads/heat-score";
import { OutcomeChips } from "./outcome-chips";
import type { LeadOutcome } from "@/lib/leads/outcomes";
import type { LeadListRow } from "@/lib/leads/list-page";
import { leadTitle } from "@/lib/leads/display-name";

/** Remembered per browser, not per user — it is a layout preference, not a setting. */
const STORAGE_KEY = "ros_call_queue_open";
/** Ties the header button to the panel it controls, for screen readers. */
const PANEL_ID = "priority-call-queue-panel";

function overdueLabel(days: number): { text: string; kind: "danger" | "warning" } {
  if (days <= 0) return { text: "Due today", kind: "warning" };
  if (days === 1) return { text: "1 day late", kind: "danger" };
  return { text: `${days} days late`, kind: "danger" };
}

function QueueRow({
  entry, tenantName, onOutcome, onOpen, onLogCall, onLogWhatsApp,
}: {
  entry: QueueEntry;
  tenantName?: string | null;
  onOutcome: (o: LeadOutcome, l: LeadListRow) => void;
  onOpen: (l: LeadListRow) => void;
  onLogCall: (l: LeadListRow) => void;
  onLogWhatsApp: (l: LeadListRow) => void;
}) {
  const { lead, heat, daysOverdue } = entry;
  const badge = heatBadge(heat.band);
  const late  = overdueLabel(daysOverdue);
  const num   = dialable(lead.contact_phone);
  const waMsg = queueWhatsAppMessage(lead, tenantName);

  return (
    <li className="border-b border-hairline px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => onOpen(lead)}
              className="truncate text-sm font-semibold text-ink hover:underline"
            >
              {cleanDisplayName(leadTitle(lead).label)}
            </button>
            {/* Score AND band. The number is what makes two hot leads comparable. */}
            <Badge
              kind={badge.kind}
              size="sm"
              title={`${heat.score}/100 · ${heat.reasons.join(" · ")}${heat.incomplete ? "\n\nSome inputs are missing, so this is a floor, not a verdict." : ""}`}
            >
              {badge.emoji} {heat.score}{heat.incomplete ? "+" : ""}
            </Badge>
            <Badge kind={late.kind} size="sm">{late.text}</Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-ink-3">
            {lead.contact_name && leadTitle(lead).source !== "contact" ? `${lead.contact_name} · ` : ""}
            {lead.contact_phone}
            {lead.plan ? ` · ${lead.plan}` : ""}
            {lead.seats ? ` · ${lead.seats} seats` : ""}
            {(lead.value ?? 0) > 0 ? ` · ${rupee(lead.value ?? 0)}` : ""}
          </p>
        </div>

        {/* The two big ones. Anchors, so the OS handles them — and so a long-press
            gives the rep "copy number" for free. */}
        <div className="flex items-center gap-2">
          <a
            href={`tel:${num ?? ""}`}
            onClick={(e) => {
              if (!num) { e.preventDefault(); toast.error(`${leadTitle(lead).label} has no usable phone number.`, { description: "Open the lead and add a 10-digit number, then call." }); return; }
              onLogCall(lead);
            }}
            className={cn(
              "inline-flex min-h-[38px] items-center gap-1.5 rounded-lg px-3 text-xs font-bold",
              "bg-primary text-white hover:opacity-90",
            )}
          >
            <Icon name="mobile" size={14} /> Call now
          </a>
          <a
            href={num ? `https://wa.me/${num}?text=${encodeURIComponent(waMsg)}` : "#"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => {
              if (!num) { e.preventDefault(); toast.error(`${leadTitle(lead).label} has no usable phone number.`, { description: "Open the lead and add a 10-digit number, then message on WhatsApp." }); return; }
              onLogWhatsApp(lead);
            }}
            title={waMsg}
            className={cn(
              "inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border px-3 text-xs font-bold",
              "border-emerald/50 bg-emerald-soft/40 text-emerald hover:bg-emerald-soft/70",
            )}
          >
            <Icon name="whatsapp" size={14} /> WhatsApp
          </a>
        </div>
      </div>

      {/* Record the outcome without leaving the bar — the whole point of a call list. */}
      <OutcomeChips
        className="mt-2"
        hasPhone={Boolean(num)}
        stage={lead.stage}
        onPick={(o) => onOutcome(o, lead)}
      />
    </li>
  );
}

export function PriorityCallQueue({
  /* 5 by default (was 3) — AI Help report, 5 Oct 2026: "show at least 5 priority call tasks". */
  leads, tenantName, onOutcome, onOpen, onLogCall, onLogWhatsApp, limit = 5,
}: {
  /** Due follow-ups (slim rows — queries/leads.ts#useDueLeads, S40); buildCallQueue re-checks them. */
  leads: readonly LeadListRow[];
  tenantName?: string | null;
  onOutcome: (o: LeadOutcome, l: LeadListRow) => void;
  onOpen: (l: LeadListRow) => void;
  onLogCall: (l: LeadListRow) => void;
  onLogWhatsApp: (l: LeadListRow) => void;
  limit?: number;
}) {
  const queue = React.useMemo(() => buildCallQueue(leads, limit), [leads, limit]);

  /* Open by default, and the choice is remembered. Reading localStorage in an effect
     rather than in useState's initialiser keeps the server and the first client render
     identical — reading it inline hydrates to a different tree and React discards the
     markup. Same idiom as the tips panel on the leads page. */
  const [open, setOpen] = React.useState(true);
  React.useEffect(() => {
    try { if (localStorage.getItem(STORAGE_KEY) === "0") setOpen(false); } catch { /* private mode */ }
  }, []);
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, next ? "1" : "0"); } catch { /* private mode */ }
      return next;
    });
  };

  // Nothing due and nobody unreachable → render nothing at all.
  if (queue.entries.length === 0 && queue.dueWithoutPhone.length === 0) return null;

  const hidden = queue.dueCount - queue.entries.length;

  return (
    <Card flush className="border-amber/40">
      {/* The header IS the control — a chevron alone is a target a thumb misses, and this
          sits at the top of a page a rep uses on a phone. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={PANEL_ID}
        /* ─── WEIGHT, BECAUSE THIS IS A PRIMARY TASK CONTAINER ─────────────────
           A thin border on the page background put this behind the high-contrast "Call" button
           above it, so the one bar naming today's work receded. `bg-amber/5` plus a left rule in
           the brand accent — existing tokens, no new colour (CLAUDE.md §5) — is enough to make it
           read as a container rather than a divider.

           ── 26 Aug 2026: DO line se EK line ──────────────────────────────────────────
           Pehle title aur "N of M due" upar-neeche the aur band `py-3` leta tha — folded
           haalat me bhi ~62px, jo leads ki jagah kha raha tha. Ab dono ek hi line par
           hain aur `py-2` kaafi hai (~38px).

           Count HATAYA nahi gaya, sirf bagal me aaya: wo wahi ginti hai jo rep folded
           panel me bhi dekhta rehta hai, aur use gिराना is band ka matlab hi kam kar deta. */
        className="flex w-full items-center gap-2 border-l-2 border-amber bg-amber/5 px-4 py-2 text-left transition-colors hover:bg-amber/10"
      >
        <Icon
          name="chevron_right"
          size={14}
          className={cn("shrink-0 text-ink-3 transition-transform", open && "rotate-90")}
        />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-semibold text-ink">
            🔥 Today&apos;s priority call queue
          </span>
          {/* Stays visible when folded. This is the count a rep must keep seeing. */}
          <span className="text-xs text-ink-3">
            {queue.entries.length > 0
              ? `${queue.entries.length} of ${queue.dueCount} due`
              : "Everything due today is missing a phone number"}
          </span>
        </span>
        {/* The alarm, never folded away — see the header note. Red, on the outside, in
            both states, because "1 already late" is the one fact that changes the order
            of a rep's morning. */}
        {queue.overdueCount > 0 && (
          <Badge kind="danger" size="sm">
            {queue.overdueCount} late
          </Badge>
        )}
        {/* amber-ink, not `text-primary`. That alias resolves to --amber, and this row sits
            on `bg-amber/5` over paper — composited, rgb(248,240,233) — where amber reads
            4.22:1 at 11px against a 4.5 floor. Worth knowing: `text-primary` is a
            shadcn-compat alias for the same colour under another name, which is why a grep
            for `text-amber` never found this, and there is no `primary-ink` to reach for. */}
        {!open && (
          <span className="shrink-0 text-xs font-semibold text-amber-ink">Show</span>
        )}
      </button>

      <div id={PANEL_ID} hidden={!open}>
      {queue.entries.length > 0 && (
        <ul>
          {queue.entries.map((e) => (
            <QueueRow
              key={e.lead.id}
              entry={e}
              tenantName={tenantName}
              onOutcome={onOutcome}
              onOpen={onOpen}
              onLogCall={onLogCall}
              onLogWhatsApp={onLogWhatsApp}
            />
          ))}
        </ul>
      )}

      {/* The truncation, stated. Not "and more" — the actual number. */}
      {hidden > 0 && (
        <p className="border-t border-hairline bg-paper-2 px-4 py-2 text-xs text-ink-3">
          {hidden} more due today, below the top {queue.entries.length}. Work through these
          first — the list re-sorts as you clear them.
        </p>
      )}

      {/* The unreachable ones, named. */}
      {queue.dueWithoutPhone.length > 0 && (
        <p className="border-t border-hairline px-4 py-2.5 text-xs leading-relaxed text-ink-2">
          <b>{queue.dueWithoutPhone.length} due today with no phone number</b> —{" "}
          {queue.dueWithoutPhone.slice(0, 3).map((l) => cleanDisplayName(leadTitle(l).label)).join(", ")}
          {queue.dueWithoutPhone.length > 3 ? ` +${queue.dueWithoutPhone.length - 3} more` : ""}.
          They cannot be called until someone adds one.{" "}
          {/* `as Route` because typedRoutes cannot know a query string is valid —
              the codebase's existing idiom, and NOT `as any` (CLAUDE.md §17). */}
          <Link href={"/leads?view=all" as Route} className="font-semibold text-primary hover:underline">
            Open the inbox
          </Link>{" "}
          to fill them in.
        </p>
      )}
      </div>
    </Card>
  );
}
