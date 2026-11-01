"use client";
/**
 * One row of the lead list's desktop grid — moved verbatim out of LeadListView (S35,
 * 28 Sep 2026). Every value it reads is handed in by the list, which still owns the
 * queries; this component only draws.
 */
import * as React from "react";
import Link from "next/link";
import type { useUpdateLead, LeadQuoteRef } from "@/lib/queries/leads";
import { StatusPill } from "@/components/ui/status-pill";
import { InlineCell } from "@/components/features/leads/inline-cell";
import { parseRupeeInput, parseFollowUpDate } from "@/lib/leads/inline-edit";
import { waitState, waitLabel } from "@/lib/leads/waiting";
import type { useTeamMembers } from "@/lib/queries/team";
import { Avatar } from "@/components/ui/avatar";
import { isStageLocked } from "@/lib/leads/stage-options";
import { dealMargin, marginBadge, type buildPlanCostIndex } from "@/lib/leads/deal-margin";
import { stageAge } from "@/lib/leads/velocity";
import { shortPlan, planWasShortened } from "@/lib/leads/short-plan";
import { isHotLead, isHighValueLead, intentMeta, staleWarning } from "@/lib/leads/heat";
import { leadDisplayName, leadContactLines, leadCompanyCell } from "@/lib/leads/display-name";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, cn } from "@/lib/utils";
import type { LeadListRow } from "@/lib/leads/list-page";
import { STAGE_DOT, STAGE_LABEL } from "@/lib/leads/stage-meta";
import { daysSince, type OpenTaskChip } from "@/lib/leads/list-selectors";
import {
  AVATAR_TOKENS, GRID_TD, GRID_TD_ATOM, STICK_L_IDENTITY, STICK_L_SELECT, type AvatarColor,
} from "@/components/features/leads/lead-list-grid";
import { RowActions } from "@/components/features/leads/lead-row-actions";
import { CloseDateBadge } from "@/components/features/leads/close-date-badge";
import { LeadAiStatusBadge } from "@/components/features/leads/lead-ai-status";

type TeamMember = NonNullable<ReturnType<typeof useTeamMembers>["data"]>[number];

export interface LeadListRowProps {
  lead: LeadListRow;
  rowIndex: number;
  selectedIds: ReadonlySet<string>;
  leadKeys: { index: number };
  selectedLeadRef: React.MutableRefObject<HTMLTableRowElement | null>;
  onRowClick: (l: LeadListRow) => void;
  toggleId: (id: string) => void;
  openTaskByLead: ReadonlyMap<string, OpenTaskChip>;
  firstReplies: ReadonlyMap<string, string>;
  nowForWait: Date;
  leadQuotes: Record<string, LeadQuoteRef> | undefined;
  planCosts: ReturnType<typeof buildPlanCostIndex>;
  updateLead: ReturnType<typeof useUpdateLead>;
  ownerById: ReadonlyMap<string, TeamMember>;
  dupIds: ReadonlySet<string>;
  onMerge: (l: LeadListRow) => void;
  onSendQuote: (l: LeadListRow) => void;
  onFollowUp: (l: LeadListRow) => void;
  onWhatsApp?: (l: LeadListRow) => void;
  /** R-2042: leads.ai_status (useLeadAiStatuses in the list view) — the "AI: …" badge. */
  aiStatus?: string | null;
}

export function LeadListRow({
  lead, rowIndex, selectedIds, leadKeys, selectedLeadRef, onRowClick, toggleId, openTaskByLead,
  firstReplies, nowForWait, leadQuotes, planCosts, updateLead, ownerById, dupIds, onMerge,
  onSendQuote, onFollowUp, onWhatsApp, aiStatus,
}: LeadListRowProps) {
    const isSelected  = selectedIds.has(lead.id);
    // Heat → visual hierarchy. High-value (big money) wins the emerald
    // treatment; else a hot lead (priority high OR late-funnel stage)
    // gets a rose accent. Same isHotLead/isHighValueLead helpers drive
    // the Hot chip + filter, so counts and tags never disagree.
    const isHighValue = isHighValueLead(lead);
    const isHot       = isHotLead(lead);
    // Intent tier (Hot / Warm / Cold) + the stale nudge. Both come from
    // lib/leads/heat so the badge, the warning and the smart-view chips
    // can never disagree about the same lead.
    const intent = intentMeta(lead);
    /* Row ki pehchan: company, warna contact ka naam, warna email. Kahan se aaya
       ye bhi saath aata hai — dono cell use alag dikhate hain. Dekho
       lib/leads/display-name.ts. */
    const leadName     = leadDisplayName(lead);
    const contactLines = leadContactLines(lead, leadName.source);
    const companyCell  = leadCompanyCell(lead, leadName.source);
    const stale7 = staleWarning(lead);
    /* Hot first: high value is a fact about the deal, hot is a job for today. 4px
       rather than 2 because at 2 it was there and nobody saw it. */
    const railCls     = isHot       ? "border-l-4 border-rose"
                      : isHighValue ? "border-l-4 border-emerald"
                      :               "border-l-4 border-transparent";
    const isDup       = dupIds.has(lead.id);
    // Phone/email affordances now live inside <RowActions/>.
    const kbSelected = rowIndex === leadKeys.index;
    return (
      <tr
        key={lead.id}
        data-lead-id={lead.id}
        ref={kbSelected ? selectedLeadRef : undefined}
        /* aria-selected as well as the tint — a screen reader has to know which
           row Enter will open. `selectedIds` is a different thing: that is the
           bulk-action checkbox set, and conflating the two would make Enter act
           on a tick rather than on the cursor. */
        aria-selected={kbSelected}
        onClick={() => onRowClick(lead)}
        tabIndex={0}
        aria-label={`Open ${lead.company}`}
        onKeyDown={(e) => {
          // Keyboard parity with the mouse row-click (WCAG AA). Ignore
          // when focus is on an inner control (checkbox / stage select /
          // action link) so their own keys aren't hijacked.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onRowClick(lead);
          }
        }}
        className={cn(
          "border-b border-hairline last:border-0 cursor-pointer transition-colors group",
          // Selected rows pick up the brand accent. Hover state
          // layered on top so it still reacts to mouse-over.
          /* Solid rang, aadhe-paardarshi nahi. Sticky cell ke neeche se baaki
             cells guzarti hain, to use apna OPAQUE background chahiye — aur wo
             row se hu-ba-hu milna chahiye. Aadhi opacity (`bg-amber-soft/60`,
             `bg-paper-2/40`) ko cell par dohraya nahi ja sakta — cell ke paas
             pehle se `bg-paper` hai aur do background ek saath nahi lagte, to
             dono taraf solid rakha gaya. Nateeja thoda gehra hai, par mila hua
             hai; aur na-mila hua
             solid. Nateeja thoda gehra hai, par mila hua hai; aur na-mila hua
             sticky column tootne jaisa dikhta hai. */
          isSelected
            ? "bg-amber-soft"
            : "hover:bg-paper-2",
        )}
      >
        {/* Checkbox aur company — dono jame hue (sticky). Background row ki
            haalat se hu-ba-hu milta hai; dekho tr ka comment upar. */}
        <td
          className={cn(
            /* px-2, p-3 nahi: p-3 (24px) + border-l-4 + checkbox 16px = 44px,
               jo 40px ke column se bahar nikal kar padosi cell me jhalakta tha. */
            "px-2 py-[var(--cell-py)]", railCls, STICK_L_SELECT, "overflow-hidden",
            isSelected ? "bg-amber-soft" : "bg-paper group-hover:bg-paper-2",
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            aria-label={`Select ${lead.company}`}
            checked={isSelected}
            onChange={() => toggleId(lead.id)}
            className="w-4 h-4 accent-amber cursor-pointer"
          />
        </td>
        <td
          className={cn(
            GRID_TD, STICK_L_IDENTITY,
            isSelected ? "bg-amber-soft" : "bg-paper group-hover:bg-paper-2",
          )}
        >
          <div className="flex items-center gap-2">
            {/* The stale signal now rides as a labelled badge next to the
                company name (with the day count), so this second, unlabelled
                rose dot on its own >14-day rule is gone. */}
            {isHighValue ? (
              <span className="shrink-0 inline-flex" title="High-value lead (≥ ₹1L)">
                <Icon name="star" size={13} className="text-emerald" />
              </span>
            ) : null}
            <div className="min-w-0">
              {/* Above the name rather than beside it: it reads first, and it cannot push a
              long company name into an ellipsis the way an inline badge did. */}
              <div className="flex items-start gap-1.5">
                {/* ── Heat: company ke naam se PEHLE, apna column nahi ──────────
                    Ye do baar hila hai, aur dono baar sahi wajah se. Pehle ye
                    "⚡ Warm" wali pill thi jo 166px ke cell ki aadhi jagah kha kar
                    naam ko doosri line me tod deti thi — isliye alag column me
                    gayi. Phir label hata kar ye sirf 16px ka indicator ban gaya,
                    aur us naap par ek poore column ki koi wajah nahi bachi.

                    Emoji hai, rang ka dot nahi: sirf rang se matlab batana
                    colour-blind padhne wale ke liye teeno ko ek jaisa kar deta hai
                    (WCAG 1.4.1). 🔥/⚡/❄️ shakl se alag hain.

                    Poora matlab do jagah: hover par tooltip, aur screen reader ke
                    liye `sr-only` — kyunki emoji khud "high voltage sign" bolta
                    hai, wo baat nahi jo hum keh rahe hain. */}
                <span
                  title={`${intent.label} — ${intent.reason}`}
                  className="shrink-0 cursor-help text-sm leading-none"
                >
                  <span aria-hidden="true">
                    {intent.tier === "hot" ? "🔥" : intent.tier === "warm" ? "⚡" : "❄️"}
                  </span>
                  <span className="sr-only">{intent.label}</span>
                </span>
                {/* ── Company khaali ho to bhi row ki PEHCHAN rahe (29 Aug 2026) ──
                    Pardeep: "kai baar contact ka naam to hota hai lekin company ka
                    naam nahi hota". Enquiry form wala raasta `company: ""` bharta
                    hai (inbound-email/route.ts:130) — `NOT NULL` khaali string nahi
                    rokta — aur us row me sabse zaroori column khaali reh jata tha.

                    Naam `lib/leads/display-name.ts` chunta hai, yahan nahi: wo
                    batata bhi hai ki naam KAHAN se aaya. Contact ka naam chup-chaap
                    company ke khaane me daal dena jhooth hota — wahi naam aage quote
                    aur invoice par company ban kar jayega. Isliye majboori wale naam
                    ka rang alag hai aur hover par wajah likhi hai.

                    Lamba naam DO line me tootta hai, teen me nahi.
                    `break-words` pehle se tha, to naam tootta to tha — par bina
                    hadd ke. Ek chaar-shabdon wala naam row ko teen-chaar line ka
                    kar deta, aur us row ke saath baaki har cell bhi lamba ho jata,
                    jisse grid ki wo ek khoobi hi chali jati jiske liye wo banaya
                    gaya tha: aankh ka ek hi cheez ko upar-neeche scan karna.
                    `line-clamp-2` do line deta hai aur uske baad "…", to har row
                    ki oonchai ki ek hadd hai.

                    `items-center` ki jagah `items-start` (parent me) isliye ki do
                    line ke saath badge naam ke BEECH me chipak jate the.

                    ⚠️ `title` yahan `lead.id` tha — yaani hover par company ka naam
                    nahi, ek UUID dikhta tha. Jo cell me kata, wo hover par poora
                    milna chahiye (accessibility-review §4); ek id dikhana us waade
                    ko poora karta hua LAGTA hai aur karta nahi. */}
                <span
                  className={cn(
                    "min-w-0 font-medium line-clamp-2",
                    /* Sirf CONTACT hi asli pehchan hai. Baaki teeno (company, email,
                       "(no name)") majboori hain, aur italic + halka rang batata hai
                       ki ye wo naam nahi hai jo hona chahiye tha. Ye shart 29 Aug ko
                       `company` par thi — swap ke baad wo hi na badalne se har row
                       italic ho gayi thi, aur wo screen par turant dikh gaya. */
                    leadName.source === "contact" ? "text-ink" : "text-ink-2 italic",
                  )}
                  title={leadName.hint ?? leadName.label}
                >
                  {leadName.label}
                </span>
                {/* Stale nudge — fires at 7 days, BEFORE Cold at 10, so
                    there is still a window to save the deal. */}
                {stale7 && (
                  <span
                    title={stale7.message}
                    className="shrink-0 inline-flex items-center gap-1 rounded-full bg-amber-soft/70 text-amber-ink text-3xs font-semibold px-1.5 py-0.5 leading-none border border-amber/30 cursor-help"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
                    {stale7.days}d
                  </span>
                )}
                {isDup && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onMerge(lead); }}
                    title="Possible duplicate — click to review & merge"
                    className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-amber-soft text-amber-ink text-3xs font-semibold px-1.5 py-0.5 leading-none border border-amber/30 hover:bg-amber-soft/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber"
                  >
                    <Icon name="copy" size={9} /> Duplicate?
                  </button>
                )}
              </div>
              {/* Email — naam ke theek neeche, DOOSRI line par (29 Aug 2026).
                  Apna column nahi: teen alag column (contact · email · phone) hi wo
                  wajah the jinse table 167px bahar nikal rahi thi aur Follow-up ki
                  tareekh scroll ke peeche chhup jati thi.

                  Yahan hone ki wajah ye hai ki ye USI aadmi ki cheez hai jiska naam
                  upar likha hai — do line, ek pehchan. Rang se alag, size se nahi:
                  is screen par pehle se 2,000+ element 12px se neeche hain, aur ek
                  aur chhota size padhna aasan nahi karta.

                  Jo naam pehle hi upar chhap chuka ho wo yahan dobara nahi aata —
                  `leadContactLines` wahi tay karta hai. */}
              {contactLines.email ? (
                <span className="block truncate text-xs text-ink-3" title={contactLines.email}>
                  {contactLines.email}
                </span>
              ) : null}
              {/* R-2042: own line, so it never pushes the name into an ellipsis. */}
              {aiStatus ? <div className="mt-0.5"><LeadAiStatusBadge status={aiStatus} /></div> : null}
              {/* Contact ka naam aur phone 26 Aug 2026 ko yahan se NIKAL kar apne
                  column me gaye the ("jaise excel sheet banti hai"). Naam 29 Aug ko
                  wapas AAYA — par pehchan bankar, ek line ke roop me nahi; aur phone
                  nahi aaya, wo row ke menu me "Call" ban kar rehta hai. */}
              {(() => {
                const tk = openTaskByLead.get(lead.id);
                if (!tk) return null;
                return (
                  <span className={cn(
                    "mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium",
                    tk.overdue ? "bg-rose-soft text-rose-ink" : "bg-amber-soft text-amber-ink",
                  )}>
                    <Icon name="clock" size={10} />
                    {tk.overdue ? "Task overdue" : "Task"} · {formatDate(tk.due)}
                    {tk.count > 1 ? ` (+${tk.count - 1})` : ""}
                  </span>
                );
              })()}
            </div>
          </div>
        </td>

        {/* ── Intezaar ka waqt ────────────────────────────────────────────────
            Do alag cheezein, ek column: jawab ja chuka hai to KITNI DER LAGI (ek
            record, muted), aur jawab baaki hai to KAB SE RUKI HAI (aaj ka kaam,
            rang ke saath). Inhe ek jaisa dikhana wahi galti hoti jo
            `follow_up_date` ke saath hui — wo yojana hai, ye karz. */}
        <td className={cn(GRID_TD_ATOM, "text-right")}>
          {(() => {
            const w = waitState(lead.created_at, firstReplies.get(lead.id) ?? null, nowForWait);
            if (w.kind === "unknown") return <span className="text-xs text-ink-3">—</span>;
            if (w.kind === "answered") {
              return (
                <span
                  className="text-xs tabular-nums text-ink-3"
                  title={`First reply sent in ${waitLabel(w.minutes)}`}
                >
                  ✓ {waitLabel(w.minutes)}
                </span>
              );
            }
            return (
              <span
                title={
                  `No reply for ${waitLabel(w.minutes)}.\n\n` +
                  "Replying within 5 minutes makes a lead 21× likelier to qualify."
                }
                className={cn(
                  "inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-semibold tabular-nums",
                  w.band === "fresh"    && "bg-emerald-soft text-emerald-ink",
                  w.band === "slipping" && "bg-amber-soft text-amber-ink",
                  w.band === "late"     && "bg-rose-soft text-rose-ink",
                  /* `cold` par rang HATA diya gaya, gehra nahi kiya. Industry ka
                     average 42 ghante hai, to `cold` aam haalat hai — use sabse
                     chamakdar dikhane par poori list laal ho jati aur rang ka
                     matlab hi khatam ho jata. */
                  w.band === "cold"     && "border border-hairline text-ink-3",
                )}
              >
                {waitLabel(w.minutes)}
              </span>
            );
          })()}
        </td>


        {/* Contact — naam upar, email neeche. Ek column, do line. Header par
            wajah aur naap likhe hain.

            `title` dono par rakha hai: jo cell me kata, wo hover par poora milta
            hai (accessibility-review §4 — truncate kiya hua text screen reader ke
            liye hamesha ke liye chala jata hai). Khaali par "—" chhapta hai, kyunki
            khaali cell aur "data hai par dikha nahi" grid me ek jaise lagte hain.

            Farq rang se hai, size se nahi. Dono line `text-xs` hain — naam `ink-2`,
            email `ink-3`. Chhota size dena aasan tha, par is screen par pehle se
            2,000+ element 12px se neeche hain aur WCAG AA ka 4.5:1 unpar poora
            lagta hai; ek aur size jodne se wo ginti badhti, padhna nahi. */}
        {/* Company — ab ek saada vivaran, pehchan nahi (29 Aug 2026). Khaali ho
            sakti hai, aur us par "—" chhapta hai: khaali cell aur "data hai par
            dikha nahi" grid me ek jaise lagte hain.

            Jab company hi pehchan ban kar upar chali gayi ho (contact ka naam nahi
            tha), to yahan DOBARA nahi chhapti — ek hi naam ek row me do baar
            dikhna galti jaisa lagta hai. Faisla `leadCompanyCell` karta hai. */}
        <td className={GRID_TD}>
          {companyCell ? (
            <span className="block truncate text-xs text-ink-2" title={companyCell}>
              {companyCell}
            </span>
          ) : (
            <span className="block text-xs text-ink-3">—</span>
          )}
        </td>

        {/* ── Stage: PADHNE ke liye, badalne ke liye nahi (26 Aug 2026) ────────
            Pehle yahan ek <select> tha. Pardeep ne use hataane ko kaha: stage us
            baat se badle jo lead ke saath sach me hui, kisi dropdown se nahi.

            Ab stage sirf teen jagah se hilta hai, aur teeno ek asli ghatna hain:
              · outcome chips  — "Baat hui", "Demo hua", "Trial shuru", "Lost"
              · quote bhejna   — stage-after-quote-sent.ts
              · swipe (mobile) — swipe-gesture.ts

            Sudhaar ka raasta band nahi hai: lead kholne par drawer me override
            maujood hai, confirmation ke saath. Wo jaan-boojh kar ek soch-samajh
            kar kiya jane wala kaam hai, table cell nahi (CLAUDE.md §24 — koi
            dead end nahi). Wahi tarq jo pehle se `won` par lagta tha, ab har
            stage par lagta hai. */}
        {/* Stage ek ikai hai ("Quote Sent" ko todna use padhne me mushkil karta
            hai), isliye ATOM. */}
        <td className={GRID_TD_ATOM}>
          <div className="flex items-center gap-1.5 flex-nowrap">
            <span className={cn("w-1.5 h-1.5 rounded-full flex-shrink-0", STAGE_DOT[lead.stage])} />
            <span
              className="text-xs px-1 py-0.5 font-medium"
              title={
                isStageLocked(lead.stage)
                  ? "Closed. Reopening a won deal touches recorded money, so it cannot be done from this cell."
                  : "Stage updates on its own. To change it, open the lead."
              }
            >
              {STAGE_LABEL[lead.stage]}
            </span>
            {/* How long it has sat here. Beside the stage, because "Quote Sent"
                and "Quote Sent for 20 days" are different facts and only the
                second one asks for action. Unknown ages render as nothing at all
                rather than as "0d" — see lib/leads/velocity.ts. */}
            {(() => {
              const a = stageAge(lead);
              if (a.days === null) return null;
              return (
                <span
                  title={a.title}
                  className={cn(
                    "shrink-0 rounded px-1 py-px text-3xs font-semibold tabular-nums leading-none",
                    a.stale ? "bg-rose-soft text-rose-ink" : "text-ink-3",
                  )}
                >
                  {a.days}d
                </span>
              );
            })()}
          </div>
        </td>
        {/* Email is kept off the row to keep it tight — it shows on hover
            (title) with a small mail glyph as the cue. Phone stays visible
            as it's the primary call-to-action in the pipeline. */}
        {/* Plan. Seats yahan se apne column me chale gaye (26 Aug 2026) — pehle
            dono ek cell me the aur us cell ki doosri line har row ko unchi kar
            deti thi. Grid me har cell ek line ka hona chahiye. */}
        <td className={cn(GRID_TD,"text-sm text-ink-2")}>
          {/* Vendor shortened, never dropped: this catalogue has a Google, a Microsoft AND a
              Zoho "Standard", so stripping the vendor would print the same label for three
              different products on a page of rupee figures. See short-plan.ts. */}
          <span className="block" title={planWasShortened(lead.plan) ? (lead.plan ?? undefined) : undefined}>
            {shortPlan(lead.plan) || "—"}
          </span>
          {/* ── Quote ka sach, list par hi (Pardeep, 31 Aug 2026) ─────────
              "lead to banti hai par ye nahi pata lagta ki isko quote bheja
              gaya hai ya nahi… related quote wahin se open bhi hona chahiye."
              Pill quote ke STATUS ka hai (draft/sent/accepted — wahi rang jo
              /quotes par hain), click quote kholta hai. stopPropagation,
              warna row-click drawer bhi khol deta. Rang ke saath SHABD bhi
              hai — rang-andha padhne wala bhi Draft/Sent padh sake. */}
          {leadQuotes?.[lead.id] && (() => {
            const q: LeadQuoteRef = leadQuotes[lead.id];
            const word = (q.status ?? "draft").charAt(0).toUpperCase() + (q.status ?? "draft").slice(1);
            return (
              <Link
                href={`/quotes/${q.id}` as never}
                onClick={(e) => e.stopPropagation()}
                title={`Open ${q.id}`}
                className="mt-0.5 inline-flex"
              >
                <StatusPill status={q.status ?? "draft"} size="sm" label={`…${q.id.slice(-4)} · ${word}`} />
              </Link>
            );
          })()}
        </td>

        {/* Seats — apna column, daayen taraf aligned kyunki ye ginti hai. "seats"
            shabd header me hai, isliye har cell me dohrana sirf jagah kha raha
            tha (aur 10 rows me wo 10 baar chhapta tha). */}
        <td className={cn(GRID_TD_ATOM, "text-right text-sm tabular-nums text-ink-2")}>
          {lead.seats ?? "—"}
        </td>
        {/* Value — the money, given visual precedence (serif, bold), and
            editable in place. Parsing lives in lib/leads/inline-edit.ts:
            this figure feeds the Open Pipeline KPI, so an unparseable
            entry is refused rather than coerced. */}
        <td className={cn(GRID_TD_ATOM,"text-right tabular-nums")} onClick={(e) => e.stopPropagation()}>
          <InlineCell<number | null>
            value={lead.value ?? null}
            ariaLabel={`Deal value for ${lead.company}`}
            className="text-right"
            toInput={(v) => (v == null ? "" : String(v))}
            parse={parseRupeeInput}
            onSave={(v) => updateLead.mutate({ id: lead.id, patch: { value: v } })}
            display={
              lead.value
                ? <span className="inline-flex flex-col items-end gap-0.5">
                    <span className={cn("font-serif text-[15px] font-semibold", isHighValue ? "text-emerald" : "text-ink")}>{rupee(lead.value)}</span>
                    {/* Gross margin, right beside the value it is a margin ON.
                        A separate column would let a rep read the deal size
                        without ever meeting the number that says whether it is
                        worth having. Cost comes from the catalogue — never a
                        percentage assumed off the sell price. */}
                    {(() => {
                      const m = dealMargin(lead, planCosts);
                      const b = marginBadge(m);
                      if (m.band === "unknown") return null;
                      return (
                        <span
                          title={b.title}
                          className={cn(
                            "rounded px-1 py-px text-3xs font-semibold tabular-nums leading-none",
                            b.kind === "danger"  && "bg-rose-soft text-rose-ink",
                            b.kind === "warning" && "bg-amber-soft text-amber-ink",
                            b.kind === "success" && "bg-paper-2 text-ink-3",
                          )}
                        >
                          {b.label}
                        </span>
                      );
                    })()}
                    {/* Expected close under the money — rose + "overdue" once it has passed. */}
                    <CloseDateBadge lead={lead} className="text-3xs" />
                  </span>
                : <span className="inline-flex flex-col items-end gap-0.5">
                    <span className="text-ink-3">—</span>
                    <CloseDateBadge lead={lead} className="text-3xs" />
                  </span>
            }
          />
        </td>
        {/* Priority — inline select. */}
        {/* Follow-up date — inline date picker. Overdue reads rose so the
            column doubles as a "who needs chasing today" scan. */}
        {/* Follow-up. `GRID_TD` ka nowrap zaroori hai — iske bina "26 Aug 2026"
            83px me teen tukdo me tootta tha aur us ek row ki unchai baaki sab se
            alag ho jati thi. */}
        <td className={cn(GRID_TD_ATOM, "text-sm")} onClick={(e) => e.stopPropagation()}>
          <InlineCell<string | null>
            value={lead.follow_up_date ?? null}
            ariaLabel={`Follow-up date for ${lead.company}`}
            inputType="date"
            toInput={(v) => v ?? ""}
            parse={parseFollowUpDate}
            onSave={(v) => updateLead.mutate({ id: lead.id, patch: { follow_up_date: v } })}
            display={
              lead.follow_up_date
                ? <span className={cn(
                    "text-xs tabular-nums",
                    daysSince(lead.follow_up_date) > 0 ? "text-rose font-medium" : "text-ink-2",
                  )}>
                    {formatDate(lead.follow_up_date)}
                  </span>
                : <span className="text-ink-3 text-xs">—</span>
            }
          />
        </td>
        {/* Expected close date. An empty one is not styled as an error — most
            leads legitimately have none — but the forecast counts it as undated
            and says so, so the gap is visible somewhere rather than nowhere. */}
        {/* ── Owner ─────────────────────────────────────────────────────────────
            Initials ka rang `users.color` se aata hai — wahi jo /team aur tasks
            par lagta hai, isliye ek hi aadmi har screen par ek jaisa dikhta hai.

            Bina owner wali lead "—" nahi, "Unassigned" dikhati hai: khaali cell
            "data nahi hai" jaisa padha jata hai, jabki bina owner hona ek ASLI
            haalat hai jispar kaam karna hai (page ki apni "unassigned" ginti isi
            par chalti hai). */}
        <td className={GRID_TD_ATOM}>
          {(() => {
            const o = lead.owner_id ? ownerById.get(lead.owner_id) : undefined;
            if (!lead.owner_id) {
              return <span className="text-xs text-ink-3">Unassigned</span>;
            }
            if (!o) {
              /* owner_id hai par us naam ka user nahi mila — nikala hua ya
                 deactivate kiya gaya member. Chup rehne se behtar hai kehna. */
              return <span className="text-xs text-ink-3" title={lead.owner_id}>Unknown user</span>;
            }
            return (
              <span
                className="inline-flex items-center gap-1.5"
                title={`${o.full_name ?? "—"}${o.email ? ` · ${o.email}` : ""}`}
              >
                {/* ── `<Avatar>`, apna gol daayra NAHI (26 Aug 2026) ────────────
                    Pehla version ek haath se bana span tha jo `o.color` ko seedha
                    `backgroundColor` me daal deta tha. Wo TOOTA hua tha, aur
                    Pardeep ne pakda: "owner ko alag sa show kyo kar raha hai" —
                    ek row me badge tha, doosri me nahi.

                    Wajah: `users.color` me CSS colour nahi, TOKEN ka naam hai.
                    `indigo` sanyog se ek asli CSS colour bhi hai (isliye Darshan
                    ka circle ban gaya), par `amber` CSS me hai hi nahi — to
                    Pardeep ka circle transparent ho gaya. Ek adha-chalta hua bug,
                    jo isi wajah se "styling ki asangati" jaisa dikha.

                    `<Avatar>` isi ke liye bana hai — uske apne docstring ka example
                    `<Avatar initials="PA" color="amber" />` hai. Maine use dekha hi
                    nahi (CLAUDE.md §14: pehle maujood component dhoondho), aur
                    uske saath ek hardcoded `#6b7280` bhi daal diya tha, jo §5 saaf
                    mana karta hai. Dono galtiyan ek hi line me thin. */}
                <Avatar
                  size="xs"
                  initials={o.initials ?? undefined}
                  name={o.full_name ?? o.email ?? undefined}
                  color={AVATAR_TOKENS.includes(o.color ?? "") ? (o.color as AvatarColor) : "muted"}
                />
                <span className="truncate text-xs text-ink-2">{o.full_name ?? o.email ?? "—"}</span>
              </span>
            );
          })()}
        </td>

        {/* Quick actions — dark panel that opens from the ⋯ (hover/click/
            focus) and stays open while the panel itself is hovered. */}
        <RowActions lead={lead} isSelected={isSelected} onSendQuote={onSendQuote} onFollowUp={onFollowUp} onWhatsApp={onWhatsApp} />
      </tr>
    );
}
