"use client";
/**
 * LeadListView — table view for scanning leads at scale (50+). Same data source + same
 * row-click drawer as Kanban; just a different lens.
 *
 * Moved out of (app)/leads/page.tsx on 28 Sep 2026 (S35). The sort is
 * lib/leads/list-selectors.ts#sortLeads (tested), one row is lead-list-row.tsx, the column
 * sizing is use-lead-list-columns.tsx and the strip under the grid is lead-list-footer.tsx.
 */
import * as React from "react";
import { toast } from "sonner";
import { useListKeys } from "@/lib/hooks/useKeyboard";
import { useDeleteLead, useSetLeadJunk, useUpdateLead, useLeadQuotes } from "@/lib/queries/leads";
import { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { LeadsBulkBar } from "@/components/features/leads/leads-bulk-bar";
import { useOpenTasksForLeads } from "@/lib/queries/tasks";
import { useLeadOutcome } from "@/lib/leads/use-outcome";
import { useLeadFirstReplies } from "@/lib/queries/lead-first-reply";
import { useTeamMembers } from "@/lib/queries/team";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useCallLog } from "@/components/features/leads/call-log-dialog";
import { buildPlanCostIndex } from "@/lib/leads/deal-margin";
import { useItems } from "@/lib/queries/items";
import { SwipeLeadCard } from "@/components/features/leads/swipe-lead-card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import type { LeadListRow as LeadRowData } from "@/lib/leads/list-page";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";
import { openTaskIndex, sortLeads, type SortCol } from "@/lib/leads/list-selectors";
import {
  DENSITY_PY, GRID_TH, LEADLIST_COL_ORDER, LEADLIST_COL_WIDTHS, STICK_HEAD, STICK_L_IDENTITY,
  STICK_L_SELECT, STICK_R_ACTIONS,
} from "@/components/features/leads/lead-list-grid";
import { useLeadListColumns } from "@/components/features/leads/use-lead-list-columns";
import { LeadListRow } from "@/components/features/leads/lead-list-row";
import { LeadListFooter } from "@/components/features/leads/lead-list-footer";

export type { SortCol };

/** The list is paged (S40): how many rows the view holds, and how to load the next page. */
export interface LeadListPaging {
  /** Rows the whole view holds — lead_counts().list.matching. */
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}

/* "Showing 50 of 1,240 · Load 50 more". The count is the server's, so the rep knows how
   much of the view is on screen — a paged list that does not say so reads as the whole
   list, which is the same mistake as a chip counting a window. When the rows were sorted
   in the browser (any column but Wait / Created), it also says the sort covers only the
   rows loaded so far. */
function LeadListPager({ paging, shown, sortedLocally }: { paging: LeadListPaging; shown: number; sortedLocally: boolean }) {
  if (!paging.hasMore && shown >= paging.total) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-3 py-2 text-xs text-ink-3">
      <span className="tabular-nums">
        Showing {shown.toLocaleString("en-IN")} of {paging.total.toLocaleString("en-IN")}
        {sortedLocally && paging.hasMore ? " · this sort covers only the loaded rows" : ""}
      </span>
      {paging.hasMore && (
        <button
          type="button"
          onClick={paging.onLoadMore}
          disabled={paging.loadingMore}
          className="rounded border border-hairline px-2 py-0.5 font-semibold text-ink-2 hover:bg-paper-2 disabled:opacity-60"
        >
          {paging.loadingMore ? "Loading…" : "Load 50 more"}
        </button>
      )}
    </div>
  );
}

export function LeadListView({
  leads,
  serverSorted = false,
  paging,
  sortBy,
  sortDir,
  onSort,
  onRowClick,
  onSendQuote,
  onFollowUp,
  onWhatsApp,
  onMerge,
  dupIds,
}: {
  leads: LeadRowData[];
  /** The rows already arrive in the chosen order (the server's wait / created order) —
   *  re-sorting them in the browser could only disagree with the next page. */
  serverSorted?: boolean;
  paging?: LeadListPaging;
  sortBy: SortCol;
  sortDir: "asc" | "desc";
  onSort: (col: SortCol) => void;
  onRowClick: (l: LeadRowData) => void;
  onSendQuote: (l: LeadRowData) => void;
  onFollowUp: (l: LeadRowData) => void;
  onWhatsApp?: (l: LeadRowData) => void;
  onMerge: (l: LeadRowData) => void;
  dupIds: Set<string>;
}) {
  /* WC-scale: the three per-row lookups below (quote pill, task chip, first reply) read
     only the leads ON SCREEN — they used to read whole tables, which PostgREST cut at 1000
     rows, so rows past that silently lost their pill / chip / wait time. */
  const leadIds = React.useMemo(() => leads.map((l) => l.id), [leads]);

  /* Har lead ki quote — PLAN cell ka pill isi se banta hai. Ek map, ek query. */
  const { data: leadQuotes } = useLeadQuotes(leadIds);

  /* Stage options now come from the LEAD, not from the page — rowStageOptions() in
     lib/leads/stage-options.ts (17 tests), which is where the quote-first gate and the
     reason for it are written down. Choosing by page was correct while /leads and /deals
     held two halves of the pipeline; after the merge it rendered a `won` deal inside a
     select of new/contact/lost, and the browser showed the first option. */
  // Stage-mutation hook for quick-change chips on cards. Tapping the stage
  // badge on a mobile card opens a dropdown to flip the stage without
  // needing to open the full detail drawer.
  const { changeStage, changeStageBulk } = useChangeLeadStage();
  // quiet: the saved value is visible in the cell itself, so a toast per edit
  // would just be noise while working down a 50-row list.
  const updateLead = useUpdateLead({ quiet: true });
  const deleteLead  = useDeleteLead();
  const setJunkBulk = useSetLeadJunk();
  /* Same entry point the call queue uses, so the mobile card's chips and swipes behave
     identically to the queue's. Declared here rather than threaded down as a prop — the
     rules live in lib/leads/outcomes.ts, so there is nothing for two call sites to
     disagree about. */
  const runOutcome  = useLeadOutcome();
  const callLog     = useCallLog(runOutcome);

  /* Catalog costs for the margin pill. Built once per render of the whole list rather
     than per row — the index is a Map over ~19 products, and rebuilding it 200 times
     would be the kind of quiet waste nobody profiles until the list is long. */
  const { data: catalogItems } = useItems();
  const planCosts = React.useMemo(
    () => buildPlanCostIndex(catalogItems ?? []),
    [catalogItems],
  );

  // Open follow-up tasks per lead — surfaced as a chip on the row so the rep
  // sees at a glance which leads have a pending task (earliest/most-overdue).
  const { data: allTasks = [] } = useOpenTasksForLeads(leadIds);
  const openTaskByLead = React.useMemo(() => openTaskIndex(allTasks, Date.now()), [allTasks]);


  // Bulk-select state — desktop power-table only. A Set of lead IDs makes
  // toggle / has() / size O(1). Resets on the leads array changing
  // identity (e.g. after a refetch) to avoid keeping stale IDs.
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const toggleId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  /** Bulk-mutate stage on all selected leads. Routed through changeStageBulk so
   *  a bulk move to Lost asks for the reason ONCE, not once per row. */
  const bulkChangeStage = async (stage: Lead["stage"]) => {
    const picked = sorted.filter((l) => selectedIds.has(l.id));
    try {
      const moved = await changeStageBulk(picked, stage);
      if (moved === 0) return;                      // dismissed, or nothing to do
      toast.success(`Moved ${moved} lead${moved === 1 ? "" : "s"} to ${STAGE_LABEL[stage]}`);
    } catch {
      toast.error("Some leads failed to update.", { description: "The rest moved. Refresh to see which stayed, then move them again." });
    }
    clearSelection();
  };

  /** Bulk-delete selected leads. The LeadsBulkBar already has a two-step
   *  confirm, so we proceed without an additional prompt. */
  const bulkDelete = async () => {
    const ids = Array.from(selectedIds);
    try {
      await Promise.all(ids.map((id) => deleteLead.mutateAsync(id)));
      toast.success(`Deleted ${ids.length} lead${ids.length === 1 ? "" : "s"}`);
    } catch {
      toast.error("Some leads failed to delete.", { description: "The rest were deleted. Refresh to see which stayed, then try again." });
    }
    clearSelection();
  };

  /** Bulk-mark selected leads as junk — one update, they leave the working views. */
  const bulkMarkJunk = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try { await setJunkBulk.mutateAsync({ ids, isJunk: true }); } catch { /* hook toasts */ }
    clearSelection();
  };
  // Apply sort (memo so we don't resort on every render).
  // Pre-sort layer (always wins): leads with follow_up_date <= today get
  // hoisted to the top regardless of the user's chosen column sort. Within
  // that group, overdue (older follow_up_date) comes first. After due-today,
  // the user's sort applies normally. This makes the "morning worklist"
  // mental model match the visual order without a separate filter.
  /* Pehla jawab, poori list ke liye ek query me — dekho queries/lead-first-reply.ts.
     Ek hi `now` sab rows par: har row apna `new Date()` lene par ek hi render me do rows
     ka intezaar ek-do second alag nikalta, aur wo sort ko hila deta. */
  const { data: firstReplies = new Map<string, string>() } = useLeadFirstReplies(leadIds);

  /* Owner ka naam — `useTeamMembers` isi ke liye hai ("show who owns what", team.ts:3).
     Map isliye ki har row par `.find()` chalana 50 leads × 10 members = 500 chakkar hai
     har render me. */
  const { data: teamMembers = [] } = useTeamMembers();
  const { data: me } = useCurrentUser();
  const meId = me?.userId ?? null;
  const ownerById = React.useMemo(
    () => new Map(teamMembers.map((m) => [m.id, m])),
    [teamMembers],
  );
  const nowForWait = React.useMemo(() => new Date(), [firstReplies]);

  /* The sort itself is lib/leads/list-selectors.ts#sortLeads (tested). The dependency
     list is the one this memo always had. */
  const sorted = React.useMemo(
    () => serverSorted ? leads : sortLeads(leads, sortBy, sortDir, {
      firstReplies,
      now: nowForWait,
      ownerName: (id) => ownerById.get(id)?.full_name,
    }),
    [leads, serverSorted, sortBy, sortDir, firstReplies, nowForWait],
  );


  /* ── j / k over the list view ─────────────────────────────────────────────
     Keyed against `sorted`, so re-sorting a column re-clamps the cursor rather than
     leaving it pointing at whatever row slid into that position. Enter opens the same
     drawer a click does — one path, so the keyboard cannot reach a different screen from
     the mouse. */
  const leadKeys = useListKeys({
    count: sorted.length,
    onOpen: (i) => { const l = sorted[i]; if (l) onRowClick(l); },
  });
  const selectedLeadRef = React.useRef<HTMLTableRowElement | null>(null);
  React.useEffect(() => {
    selectedLeadRef.current?.scrollIntoView({ block: "nearest" });
  }, [leadKeys.index]);

  // NOTE: buildWaMessage / followUpLabel / priorityDot helpers used to live
  // here for the inline mobile card. They've been lifted into SwipeLeadCard
  // (the new component handles its own formatting). Desktop / tablet table
  // doesn't need them so they're gone from this file.

  const {
    density, setDensity, hidden, setHidden, colW, colRefs, tableWrapRef, resetWidths, ResizeGrip,
  } = useLeadListColumns(leads);


  const SortHeader = ({ col, label, align = "left", sticky = false }: { col: SortCol; label: string; align?: "left" | "right"; sticky?: boolean }) => (
    <th
      onClick={() => onSort(col)}
      className={cn(
        GRID_TH, "relative cursor-pointer select-none hover:text-ink",
        align === "right" && "text-right",
        sticky && cn("bg-paper-2", STICK_L_IDENTITY, STICK_HEAD),
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortBy === col && (
          <Icon name={sortDir === "asc" ? "chevron_up" : "chevron_down"} size={11} />
        )}
      </span>
      <ResizeGrip col={col} />
    </th>
  );

  return (
    <>
    {/* Mobile card ka "Call log" isme khulta hai. Card ke ANDAR nahi: swipe par card
        khud animate/unmount hota hai, aur uske andar rakha popup uske saath gायab ho
        jata. */}
    {callLog.dialog}

    {/* Adaptive card list — viewports < 1280px */}
    {/* ── THE CARD LIST MUST SCROLL ITSELF ──────────────────────────────────────
        `flex-1 min-h-0 overflow-y-auto` is not styling, it is the difference between
        seeing 2 leads and seeing 17. The page wrapper is a fixed-height flex column with
        `overflow-hidden` (line 716), so a child that does not scroll gets CLIPPED — and
        clipped silently: no scrollbar appears anywhere, the rows are all in the DOM, and
        the page simply ends.

        Reported 21 Aug 2026 on a 1051px window: "All open 17" with two cards under it.
        Measured in the running page — 20 card action-rows in the DOM, content 3217px tall
        inside a 666px box, and `document.scrollingElement.scrollHeight === clientHeight`,
        so nothing could scroll at all.

        The table branch below has carried `overflow-auto flex-1 min-h-0` all along, which
        is exactly why this went unseen: on a monitor ≥1280px the list works. The bug lived
        only under `xl` — the tablet and narrow-laptop band CLAUDE.md §20 warns about, and
        where a phone-shaped card list is the ONLY way to read this page. */}
    {/* ── Card list ab `lg` se NEECHE (26 Aug 2026) ─────────────────────────────
        Pehle ye `xl` (1280px) tha, yaani laptop par bhi card dikhta tha aur table kabhi
        nahi. Pardeep ne header wali table maangi — aur wo pehle se bani hui thi, bas uske
        saamne kabhi aayi hi nahi.

        `lg` (1024px) par utar rahe hain, `md` par nahi: 7 column 768px me thoosne ka
        matlab hai har cell ka ellipsis me badal jana, jo CLAUDE.md §20 ka apna
        anti-pattern hai ("hiding important columns… operator still loses data"). 1024 se
        neeche card hi rehta hai, isliye §20 ka "table ko card ka jodidaar chahiye" niyam
        bhi kayam hai. */}
    <ul className="lg:hidden flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-3 pb-2 pr-0.5">
      {sorted.map((lead) => {
        // `stale` used to be computed here on a >14-day rule and passed in. The
        // card now derives it from lib/leads/heat itself, so phone and desktop
        // can't disagree — see SwipeLeadCard.
        return (
          <SwipeLeadCard
            key={lead.id}
            lead={lead}
            quoteRef={leadQuotes?.[lead.id]}
            task={openTaskByLead.get(lead.id)}
            ownerName={lead.owner_id && lead.owner_id !== meId
              ? ownerById.get(lead.owner_id)?.full_name || ownerById.get(lead.owner_id)?.email || "Unknown user"
              : null}
            onTap={onRowClick}
            onChangeStage={(s) => void changeStage(lead, s)}
            onSendQuote={onSendQuote}
            onOutcome={(o, l) => callLog.run(o, l)}
          />
        );
      })}
      {sorted.length === 0 && (
        <li className="py-8 text-center text-sm text-ink-3">No leads match.</li>
      )}
      {paging && (
        <li><LeadListPager paging={paging} shown={sorted.length} sortedLocally={!serverSorted} /></li>
      )}
    </ul>
    {/* ─── End of mobile list — old inline card markup retired ─── */}

    {/* Desktop / tablet power table — viewports >= 1280px */}
    <div ref={tableWrapRef} className="hidden lg:block w-full max-w-full border border-hairline rounded-md overflow-auto bg-paper flex-1 min-h-0">
      {/* Fluid percentage columns — the table fills the container width with no
          horizontal scrollbar at desktop widths. */}
      {/* Jab tak koi column kheencha nahi gaya, table container bhar deta hai (`w-full`).
          Ek baar kheenchne ke baad chaudai user ki hai.

          `width` SAAF-SAAF dena zaroori hai, aur ye naap kar pata chala: sirf `w-full`
          hata dene se chaudai state aur localStorage me to badalti thi par screen par
          nahi — email 328px saheja gaya aur 206px render hua, kyunki `table-fixed` table
          `width:auto` par apne container me nichud jata hai. Yogfal dene par wo bahar
          nikalta hai aur wrapper ka `overflow-auto` use horizontal scroll de deta hai —
          theek jaise spreadsheet me hota hai. */}
      <table
        className={cn("leads-grid table-fixed", Object.keys(colW).length === 0 && "w-full")}
        style={{
          ...(Object.keys(colW).length === 0
            ? {}
            : {
                /* Sirf DIKHNE WALE column gine jate hain — chhupe hue ko jodne par table
                   apni jagah se chauda reh jata aur daayen ek khaali patti bach jati. */
                width: LEADLIST_COL_ORDER
                  .filter((id) => !hidden.has(id))
                  .reduce((sum, id) => sum + (colW[id] ?? 0), 0),
              }),
          /* Har cell isi ko padhta hai — dekho DENSITY_PY. */
          ["--cell-py" as string]: DENSITY_PY[density],
        } as React.CSSProperties}
      >
        {/* ── Chhupe hue column, CSS se ────────────────────────────────────────────
            Har cell par `{!hidden.has(...) && ...}` lagane ka matlab hota 12 cells ko
            dobara likhna — aur is file me wahi kaam do baar galat ho chuka hai (column
            hatate waqt colgroup chhoot jata tha, aur phir har agla column apne padosi ki
            chaudai pehen leta tha).

            `display:none` cell ko layout se poori tarah nikaal deta hai, to browser bache
            hue cells se columns dobara ginta hai — aur colgroup me se bhi wahi hataye gaye
            hain, isliye dono ka kram mel khata hai. Ek jagah se dono. */}
        {hidden.size > 0 && (
          <style>{LEADLIST_COL_ORDER
            .map((id, i) => (hidden.has(id)
              ? `.leads-grid > * > tr > *:nth-child(${i + 1}){display:none}`
              : ""))
            .filter(Boolean)
            .join("")}</style>
        )}
        {/* Chaudai: user ne kheenchi hui (px) pehle, warna default (%). Jab tak koi drag
            nahi hua, table container ke saath bada-chhota hota hai — jo aam haalat me
            sahi hai. */}
        <colgroup>
          {LEADLIST_COL_ORDER.filter((id) => !hidden.has(id)).map((id) => (
            <col
              key={id}
              ref={(el) => { colRefs.current[id] = el; }}
              style={{ width: colW[id] != null ? `${colW[id]}px` : LEADLIST_COL_WIDTHS[id] }}
            />
          ))}
        </colgroup>
        <thead className="bg-paper-2 border-b border-hairline">
          <tr>
            {/* Select-all checkbox — checked when every row is selected,
                indeterminate when only some are. */}
            <th className={cn("sticky top-0 bg-paper-2 px-3 py-2", STICK_L_SELECT, STICK_HEAD)}>
              <input
                type="checkbox"
                aria-label="Select all leads"
                checked={sorted.length > 0 && selectedIds.size === sorted.length}
                ref={(el) => {
                  if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < sorted.length;
                }}
                onChange={(e) => {
                  if (e.target.checked) setSelectedIds(new Set(sorted.map((l) => l.id)));
                  else clearSelection();
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 accent-amber cursor-pointer"
              />
            </th>
            {/* CONTACT jama hua hai (sticky) — scroll karte waqt yahi batata hai ki row
                kiski hai. 29 Aug 2026 tak yahan Company thi; badla isliye ki bina company
                ke lead ban sakti hai, bina contact ke nahi. Dekho STICK_L_IDENTITY. */}
            <SortHeader col="contact" label="Contact" sticky />
            {/* Intezaar — company ke theek baad, kyunki ye hi tay karta hai ki aaj kis
                row par kaam karna hai. Research: 5 minute me jawab = 21 guna sambhavna. */}
            <SortHeader col="wait" label="Wait" />
            {/* Contact — naam AUR email ek hi column me, do line par. Phone table se
                nikal gaya (29 Aug 2026).

                Kyun: us din browser me naapa gaya ki 13 column us jagah me aate hi nahi.
                Table ko 1414px chahiye the aur mili 1247px — 167px bahar. Aur ye sirf
                kinare ki dikkat nahi thi: **har ek content column apni zaroorat se chhota
                tha.**

                    Company  chahiye 366, mili 228      Contact   150 / 113
                    Email            277 / 210          Phone     152 / 118
                    Owner            171 / 109          Follow-up 120 /  90
                    Value            146 /  70          Plan      186 / 161

                Yaani Company ka naam bhi poora nahi dikh raha tha, aur Follow-up ki tareekh
                — jo is screen par sabse kaam ki cheez hai — daayin taraf scroll ke peeche
                chhupi thi. Chaudai thoda-thoda badalne se ye theek nahi hota; kam column
                hi ek matra hal hai.

                Email ko Contact ke neeche rakha, hataya nahi — wo scan karne ke liye
                zaroori hai (kaun sa lead kis domain se aaya). Phone HATAYA gaya kyunki wo
                sirf padhne ke liye tha: row ke menu me "Call" (`tel:`) pehle se maujood
                hai, aur poora number lead kholne par Details me hai. Ek number jo dekha
                hi jata hai, dial nahi — usko 118px dena mehnga sauda tha. */}
            <SortHeader col="company" label="Company" />
            <SortHeader col="stage" label="Stage" />
            <SortHeader col="plan" label="Plan" />
            <SortHeader col="seats" label="Seats" align="right" />
            <SortHeader col="value" label="Value" align="right" />
            <SortHeader col="followup" label="Follow-up" />
            {/* Owner — ye pehle se FILTER chalata tha ("My assigned", unassigned ki ginti)
                par kahin dikhta nahi tha. Jis cheez par filter lagta hai, wo dikhni chahiye.

                29 Aug 2026: SABSE AAKHIR me chala gaya (Pardeep ke kehne par). Wo ek baar
                pehle bhi hil chuka hai, aur dono baar wajah ek hi hai — is screen par baayen
                se daayen kram "kaun · kab · kya" hai, aur owner un teeno me nahi aata. Row
                par kaam karne ka faisla naam, intezaar aur tareekh se hota hai; owner tab
                dekha jata hai jab kaam kisi aur ko dena ho. */}
            <SortHeader col="owner" label="Owner" />
            {/* Actions column — quick action icons on row hover. */}
            <th className={cn("sticky top-0 bg-paper-2 px-3 py-2 text-xs font-semibold text-ink-3 uppercase tracking-wider text-right", STICK_R_ACTIONS, STICK_HEAD)}>
              <span className="sr-only">Quick actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((lead, rowIndex) => (
            <LeadListRow
              key={lead.id}
              lead={lead}
              rowIndex={rowIndex}
              selectedIds={selectedIds}
              leadKeys={leadKeys}
              selectedLeadRef={selectedLeadRef}
              onRowClick={onRowClick}
              toggleId={toggleId}
              openTaskByLead={openTaskByLead}
              firstReplies={firstReplies}
              nowForWait={nowForWait}
              leadQuotes={leadQuotes}
              planCosts={planCosts}
              updateLead={updateLead}
              ownerById={ownerById}
              dupIds={dupIds}
              onMerge={onMerge}
              onSendQuote={onSendQuote}
              onFollowUp={onFollowUp}
              onWhatsApp={onWhatsApp}
            />
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <div className="p-8 text-center text-sm text-ink-3 italic">No leads match.</div>
      )}
      {paging && <LeadListPager paging={paging} shown={sorted.length} sortedLocally={!serverSorted} />}
      <LeadListFooter
        density={density}
        setDensity={setDensity}
        hidden={hidden}
        setHidden={setHidden}
        colW={colW}
        resetWidths={resetWidths}
      />
    </div>

    {/* Floating bulk action toolbar — only renders when ≥1 row selected. */}
    <LeadsBulkBar
      count={selectedIds.size}
      onChangeStage={bulkChangeStage}
      onDeselectAll={clearSelection}
      onDelete={bulkDelete}
      onMarkJunk={bulkMarkJunk}
    />
    </>
  );
}
