"use client";
/**
 * The lead drawer — slide-out detail sheet opened from a card or a row.
 *
 * Moved out of (app)/leads/page.tsx on 28 Sep 2026 (S35). The tabs live in their own
 * files (lead-detail-*-tab.tsx) and the next-step rules in lib/leads/next-action.ts;
 * every hook still runs HERE, exactly as before, and the tabs receive what they read.
 */
import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter, usePathname } from "next/navigation";
import { toast } from "sonner";
import { useDeleteLead, useLeadProject } from "@/lib/queries/leads";
import { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { useLeadActivities, useLogLeadActivity } from "@/lib/queries/lead-activities";
import { useInboundEmails } from "@/lib/queries/inbound-emails";
import { isSentReply } from "@/lib/inbound/sent";
import { buildEmailThread, summariseThread } from "@/lib/leads/email-thread";
import { useQuotesByLead } from "@/lib/queries/quotes";
import { QuoteActionBar } from "@/components/features/quotes/quote-action-bar";
import { useTasksForLead, useCompleteTask, useSnoozeTask, useDeleteTask } from "@/lib/queries/tasks";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { dealDeleteBlock } from "@/lib/deals/delete-rules";
import { useLeadOutcome } from "@/lib/leads/use-outcome";
import { useCallLog } from "@/components/features/leads/call-log-dialog";
import { localDateISO } from "@/lib/leads/outcomes";
import { buildPlanCostIndex } from "@/lib/leads/deal-margin";
import { dealHealth } from "@/lib/leads/deal-health";
import { BattlecardDrawer } from "@/components/features/leads/battlecard-drawer";
import { buildTimeline } from "@/lib/leads/timeline";
import { useItems } from "@/lib/queries/items";
import { Icon } from "@/components/ui/icon";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { Lead } from "@/lib/supabase/database.types";
import { useUserNames } from "@/lib/hooks/useUserNames";
import { LEAD_STAGES } from "@/lib/leads/stage-meta";
import { nextActionFor, type NextAction } from "@/lib/leads/next-action";
import { LeadDetailsTab } from "@/components/features/leads/lead-detail-details-tab";
import { LeadActivityTab } from "@/components/features/leads/lead-detail-activity-tab";
import { LeadEmailTab } from "@/components/features/leads/lead-detail-email-tab";
import { LeadFollowupsTab } from "@/components/features/leads/lead-detail-followups-tab";
import { LeadDetailFooter } from "@/components/features/leads/lead-detail-footer";
import { LeadDetailHeader } from "@/components/features/leads/lead-detail-header";
import { leadTitle } from "@/lib/leads/display-name";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { leadQuoteHref } from "@/lib/leads/lead-quote-href";

type DrawerTab = "email" | "details" | "followups" | "activity";
/* "auto" = no tab chosen yet: the drawer picks one from what the lead has (below). */
const LTAB_CHOICES = ["email", "activity", "followups", "details", "auto"] as const;

const AddTaskDialog = dynamic(() => import("@/components/features/tasks/add-task-dialog").then((m) => m.AddTaskDialog), { ssr: false });
const LeadEmailComposer = dynamic(() => import("@/components/features/leads/lead-email-composer").then((m) => m.LeadEmailComposer), { ssr: false });
const SendWhatsAppDialog = dynamic(() => import("@/components/features/whatsapp/send-whatsapp-dialog"), { ssr: false });

export function LeadDetailSheet({
  lead,
  onClose,
  onEdit,
}: {
  lead: Lead | null;
  onClose: () => void;
  onEdit: (lead: Lead) => void;
}) {
  /* Ids → names for the "Added by" row. Five-minute cache: a colleague's name changes about
     never, and re-fetching per drawer open would be a request per click. */
  const { data: userNames } = useUserNames();
  const router      = useRouter();
  const drawerPath  = usePathname();
  const { changeStage } = useChangeLeadStage();
  const deleteLead  = useDeleteLead();
  /* The project quotation a custom-software lead was quoted on — accepted means Won. */
  const { data: leadProject } = useLeadProject(lead?.enquiry_type === "project" ? lead?.project_id : null);
  const confirm     = useConfirm();
  const { data: currentUser } = useCurrentUser();
  const logActivity = useLogLeadActivity();
  /* Same entry point the row's chips use, so "Baat hui" means one thing everywhere. */
  /* Catalog costs for this drawer's margin figure. Same index the list builds — one
     source, so the pill on the row and the number in the drawer can never disagree. */
  const { data: drawerCatalog } = useItems();
  const drawerPlanCosts = React.useMemo(() => buildPlanCostIndex(drawerCatalog ?? []), [drawerCatalog]);
  const { data: activities = [] } = useLeadActivities(lead?.id);

  /* The mail this lead last SENT US — the thread a reply attaches to.
     Replies we sent are excluded: replying to our own message would thread the conversation
     onto the wrong side of it, and isSentReply is the same test the Sent folder uses, so
     the two cannot disagree about what counts as inbound. */
  const { data: allInbound = [] } = useInboundEmails();
  const replyAnchor = React.useMemo(() => {
    if (!lead?.id) return null;
    return (
      allInbound
        .filter((e) => e.lead_id === lead.id && !isSentReply(e) && e.from_email)
        .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))[0] ?? null
    );
  }, [allInbound, lead?.id]);

  /* The email exchange on this lead, both directions, oldest first. The rows were already
     loaded above for `replyAnchor` — `inbound_emails` holds sent replies alongside the mail
     they answer (lib/inbound/sent.ts), so a two-sided thread needs assembling, not storing.
     Reported by Pardeep on 22 Aug 2026: he could not tell where a reply from the lead's
     address would appear, because email was mixed in with calls, quotes and tasks. */
  const emailThread   = React.useMemo(() => buildEmailThread(allInbound, lead?.id), [allInbound, lead?.id]);
  const threadSummary = React.useMemo(() => summariseThread(emailThread), [emailThread]);
  /* Email sends the timeline recorded but never stored text for — the old Gmail
     hand-off. Counted so the Email tab can explain the gap instead of contradicting the
     timeline beside it. */
  const loggedEmailSends = React.useMemo(
    () => activities.filter((a) => a.kind === "email").length,
    [activities],
  );

  /* ── Default "activity", "details" nahi (26 Aug 2026) ─────────────────────
     Neeche wala auto-pick pehle se samajhdar hai: email thread ho to Email tab, warna
     activity ho to Activity tab. Par jiske paas ABHI KUCH NAHI hai — ek nayi lead — wo
     "details" par reh jati thi. Aur nayi lead ke saath pehla kaam theek wahi hota hai
     jiske liye ye tab bana hai: call karo aur jo baat hui wo likho.

     Yaani sabse aam kaam ek chhupe hue extra click ke peeche tha. Details ek form hai —
     lead banane ke baad usme jaana kabhi-kabhi hi padta hai, aur uske ahem number
     (plan, seats, value) waise bhi header aur table row me dikhte hain. */
  /* R-342: a tab the operator CHOSE is in the URL (?ltab=), so opening a quote from the
     Activity tab and pressing Back lands on Activity again. Until one is chosen the tab is
     the auto-pick below, which is not written to the URL — it is recomputed on return. */
  const [urlTab, setUrlTab] = useUrlChoice<DrawerTab | "auto">("ltab", LTAB_CHOICES, "auto");
  const [autoTab, setAutoTab] = React.useState<DrawerTab>("activity");
  const drawerTab: DrawerTab = urlTab === "auto" ? autoTab : urlTab;
  const setDrawerTab = React.useCallback((t: DrawerTab) => setUrlTab(t), [setUrlTab]);
  /* A different lead (or a closed drawer) starts over on the auto-pick. Only when a lead WAS
     open: on first load the lead is still null while ?ltab= is being read, and resetting
     then would throw away the tab Back is meant to restore. */
  const tabForLead = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = lead?.id ?? null;
    if (tabForLead.current !== null && tabForLead.current !== id) setUrlTab("auto");
    tabForLead.current = id;
  }, [lead?.id, setUrlTab]);
  /* `convoView` lived here until 23 Aug 2026 — the segmented Everything/Email control
     inside the old merged Conversation tab. Email is a tab now, so the state went with the
     control: two ways to be on the email view would have drifted apart, and the tab is the
     one a URL or a keyboard could ever reach. */
  const [emailComposerOpen, setEmailComposerOpen] = React.useState(false);
  /* ── Which tab a lead opens on ─────────────────────────────────────────────
     Was always "details". Moving the tabs to the top was half the fix for
     "Follow-ups and Conversation should be first"; this is the other half — the
     thing an operator opens a lead to DO was one click behind the thing they open
     it to LOOK UP.

     Not a fixed choice either way, because the right answer depends on the lead:
     a brand-new one has no conversation, and landing on an empty Conversation tab
     would be worse than what it replaced. So it opens on the exchange when there
     IS one, and on Details when there is not — which is also the case where the
     fields still need filling in.

     `activities.length` rather than the email thread specifically: a lead whose
     only history is two calls and a quote is still a lead you open to see what
     happened, not to read its address. */
  /* `activities` arrives asynchronously, and that detail is the whole difference
     between this working and looking like it works. Keying the effect on `lead?.id`
     alone runs it once while the list is still empty, lands on Details, and never
     re-runs — so every lead WITH a conversation would still have opened on Details
     and the change would have looked applied.

     So it runs when the count changes too, and `autoPickedFor` makes it fire at most
     once per lead. A second automatic switch is worse than none: it would move the
     tab out from under whoever had just chosen one. */
  const autoPickedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    setEmailComposerOpen(false);
    autoPickedFor.current = null;
  }, [lead?.id]);

  React.useEffect(() => {
    const id = lead?.id;
    if (!id) return;
    if (autoPickedFor.current === id) return;      // already decided for this lead
    /* Email outranks Activity, now that Email is a tab of its own (23 Aug 2026, asked for
       as "email conversation ka tab alag hi bana dete hai"). A live exchange with the
       customer IS what the lead is about; the merged Activity stream is history, and
       history is not what you open a live thread for.

       Both counts are read, not only the winner's: a lead whose history is two calls and
       a quote still lands on Activity rather than on an empty Email tab. */
    if (threadSummary.total > 0) {
      autoPickedFor.current = id;
      setAutoTab("email");
      return;
    }
    if (activities.length === 0) return;           // still loading, or nothing to show
    autoPickedFor.current = id;
    setAutoTab("activity");
  }, [lead?.id, activities.length, threadSummary.total]);

  // Drag-to-resize the drawer (desktop only): the left edge is a grab handle;
  // the chosen width is remembered per browser. Mobile stays full-width.
  const [panelWidth, setPanelWidth] = React.useState<number | null>(null);
  const widthRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    const saved = Number(localStorage.getItem("lead_drawer_w"));
    if (saved >= 360) { setPanelWidth(saved); widthRef.current = saved; }
  }, []);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(360, Math.min(window.innerWidth - ev.clientX, window.innerWidth * 0.95));
      widthRef.current = w;
      setPanelWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      if (widthRef.current) localStorage.setItem("lead_drawer_w", String(Math.round(widthRef.current)));
    };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // History: every quote that's been sent to this lead
  const { data: quotesForLead = [] } = useQuotesByLead(lead?.id);

  // Follow-up tasks linked to this lead — drives the "Follow-ups" drawer section
  const { data: tasksForLead = [] } = useTasksForLead(lead?.id);

  /* The unified stream. Built from sources this drawer already loads — merging is a
     view concern, so no new fetch. Payments are not passed yet: they link to a lead
     only through a quote, and buildTimeline accepts them the day that query exists
     rather than pretending the gap is not there. */
  /** Inline note composer state. Local to the drawer — a note is not worth a dialog. */
  const [noteDraft, setNoteDraft] = React.useState("");
  const runOutcome  = useLeadOutcome();
  /* Bola hua text note box me hi jata hai — mic ek alag box nahi kholta, kyunki phir
     do jagah likha hua text jodna user ka kaam ban jata. */
  /* Popup ka text aur mic ab `call-log-dialog.tsx` ke andar rehte hain. Yahan sirf
     "kholo" bacha hai — aur wahi chaaron surface par ek jaisa hai. */
  const callLog = useCallLog(runOutcome);

  const timeline = React.useMemo(
    () => buildTimeline({ activities, quotes: quotesForLead, tasks: tasksForLead }),
    [activities, quotesForLead, tasksForLead],
  );
  const completeTask = useCompleteTask();
  const snoozeTask   = useSnoozeTask();
  const deleteTask   = useDeleteTask();
  const [addTaskOpen, setAddTaskOpen] = React.useState(false);
  const [whatsOpen,   setWhatsOpen]   = React.useState(false);
  const [cardsOpen,   setCardsOpen]   = React.useState(false);

  /* Deal health. Built from what this drawer already loads — activities give both the
     last touch and whether the customer ever replied, so no extra query. `email_in` is
     the only inbound kind today; a reply logged any other way is invisible here, which
     under-scores the deal rather than over-scoring it. That direction is deliberate: a
     health score that flatters a neglected deal is worse than one that nags. */
  const health = React.useMemo(() => {
    if (!lead) return null;
    const sorted = [...activities].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
    return dealHealth({
      lead,
      lastActivityAt: sorted[0]?.created_at ?? null,
      customerResponded: activities.some((a) => a.kind === "email_in"),
      today: localDateISO(new Date()),
    });
  }, [lead, activities]);

  if (!lead) return null;
  const hasQuotes = quotesForLead.length > 0;
  const openTasks = tasksForLead.filter((t) => t.status === "pending" || t.status === "snoozed");
  const doneTasks = tasksForLead.filter((t) => t.status === "done");

  const handleDelete = async () => {
    /* Owner/manager only, never with a quote (lib/deals/delete-rules.ts, 2 Oct 2026). */
    const block = dealDeleteBlock({ role: currentUser?.role, quoteIds: quotesForLead.map((q) => q.id) });
    if (block) {
      toast.error("This can't be deleted", {
        description: block,
        action: lead.stage !== "lost" && lead.stage !== "won" ? { label: "Mark lost", onClick: () => handleArchive() } : undefined,
      });
      return;
    }
    const confirmed = await confirm({
      title: `Permanently delete lead "${leadTitle(lead).label}"?`,
      body: "This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    deleteLead.mutate(lead.id, {
      onSuccess: () => onClose(),
    });
  };

  const handleSendQuote = () => {
    /* Project lead → the project quotation (or the one it already has). See goSendQuote. */
    if (lead.enquiry_type === "project") {
      /* Another page: push without closing, so Back reopens this drawer (R-342). The
         project quotation sheet is on THIS page, so that one closes the drawer first. */
      if (lead.project_id) { router.push(`/projects/${lead.project_id}` as never); return; }
      onClose();
      router.push(`${drawerPath}?projectQuote=${lead.id}` as never);
      return;
    }
    /* R-389 (F5): the lead id (+ plan/seats) only — the builder loads company and contact
       from the lead, so the customer's email and phone never sit in the URL / history. */
    /* No onClose() before leaving for another page (R-342) — it clears ?lead from the
       history entry, and Back would land on a closed drawer. The page unmounts anyway. */
    router.push(leadQuoteHref(lead) as never);
  };

  // If lead already has a quote, default the primary CTA to "Revise & resend"
  // (duplicate the latest quote, edit, resend). This avoids accidental duplicates
  // and keeps audit history clean.
  const latestQuote = quotesForLead[0]; // sorted by created_date desc
  const handleReviseQuote = () => {
    if (!latestQuote) return handleSendQuote();
    /* The duplicated quote brings its own lines — only the lead id rides along (R-389 F5). */
    router.push(leadQuoteHref({ id: lead.id }, { duplicate: latestQuote.id }) as never);
  };

  /* Opens the in-app composer instead of Gmail.
     ─── WHAT THIS REPLACED, AND WHY ────────────────────────────────────────────
     It used to build a mail.google.com compose URL, open it in a new tab, and log
     "Emailed x@y · subject". The message itself went to Gmail and nowhere else, so the
     lead's Email thread (added 22 Aug 2026) could show the customer's words and only a
     stub for ours — a half conversation, which reads as data loss.
     /api/leads/[id]/email sends through lib/email/send.ts (the tenant's own connected
     Gmail, when they have one) and files the text into inbound_emails the same way the
     enquiry reply route does, so both sides of the thread are real. */
  const handleEmail = () => {
    if (!lead.contact_email) {
      /* §24 — where to fix it, not just what is wrong. */
      toast.error("No email on this lead — add one with Edit, then you can write to them from here.");
      return;
    }
    setEmailComposerOpen(true);
  };

  const handleArchive = () => {
    void changeStage(lead, "lost");
    toast.success(`${leadTitle(lead).label} archived`);
    onClose();
  };

  // Smart "next action" suggestion — tells the rep THE one thing to do next
  // instead of making them stare at 10 buttons trying to decide. Pattern from
  // Linear / Notion: cut decision fatigue by surfacing the most likely next
  // move, ranked by lead state + quote age + payment status.
  // Must be declared AFTER handleSendQuote / handleReviseQuote since it
  // closes over them.
  const latestQuoteForAction = quotesForLead[0]; // sorted desc by created_date
  const quoteAgeDays = latestQuoteForAction
    ? Math.floor((Date.now() - new Date(latestQuoteForAction.created_date).getTime()) / (24 * 60 * 60 * 1000))
    : null;

  /* The rules live in lib/leads/next-action.ts (pure, tested). It says WHAT the button
     is and WHERE it goes; this maps the destination onto the drawer's own handlers, so
     "send quote" is still exactly handleSendQuote and nothing else. */
  const nextAction: NextAction | null = nextActionFor({
    lead, leadProject, latestQuoteForAction, quoteAgeDays, threadSummary, activities,
  });
  const runNextAction = (a: NextAction) => {
    const t = a.target;
    if (t.kind === "stage") { void changeStage(lead, t.stage); return; }
    if (t.kind === "go") { router.push(t.href as never); return; }
    if (t.kind === "send_quote") { handleSendQuote(); return; }
    if (t.kind === "email") { handleEmail(); return; }
    window.location.href = `tel:${t.phone}`;
  };


  const stageLabel = LEAD_STAGES.find((s) => s.id === lead.stage)?.label ?? lead.stage;

  return (
    <Sheet open={!!lead} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:w-[var(--lead-w)] sm:max-w-[95vw] p-0 flex flex-col"
        style={{ ["--lead-w" as string]: panelWidth ? `${panelWidth}px` : "28rem" } as React.CSSProperties}
        hideClose
      >
        {/* Drag handle on the left edge — grab to widen/narrow the panel (desktop). */}
        <div
          onMouseDown={startResize}
          className="hidden sm:block absolute inset-y-0 left-0 z-30 w-2 -ml-1 cursor-ew-resize group"
          title="Drag to resize"
          aria-hidden
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-hairline group-hover:bg-amber group-hover:w-1 transition-all" />
        </div>
        <LeadDetailHeader
          lead={lead}
          stageLabel={stageLabel}
          confirm={confirm}
          changeStage={changeStage}
          onClose={onClose}
        />

        {/* ── Tabs, PINNED ─────────────────────────────────────────────────────
            Asked for on 23 Aug 2026: Follow-ups and Conversation at the top. They
            used to sit inside the scroll container below four blocks, so switching
            tabs meant scrolling back up to find them.

            Outside the scroll now, which is more than a reorder: they are reachable
            from any depth of a long thread. The header above stays put too (it was
            already outside the scroll), so the company name and stage remain visible
            while a reply is being written — a reply composed without knowing who it
            is going to is how the wrong name reaches a customer.

            ORDER IS THE POINT, not just the position. Conversation first, because
            that is what an operator opens a lead to do; Details last, because it is
            reference. The old order put reference first AND defaulted to it.

            EMAIL IS ITS OWN TAB as of 23 Aug 2026 — "email conversation ka tab alag hi
            bana dete hai". It used to be a segmented control INSIDE this tab, and I had
            argued against promoting it: the same conversation would then live in three
            places. The screenshot showed that reasoning was backwards. The control did not
            save a label, it added one — above the first message the reader met
            "Conversation (16)", then "Everything | Email (15)", then "EMAIL CONVERSATION ·
            7 in · 8 out". Three headings, and two unequal numbers with nothing saying the
            15 sat inside the 16. A tab removes the control, one heading and the mismatch
            together.

            "Activity", not "Conversation", now that Email has taken the conversational
            meaning: that tab is the merged stream of calls, quotes, tasks and payments,
            which is history. Two tabs both called Conversation was the confusion.

            Counts sit side by side, so they must not overlap in what they count: Email
            counts messages in the thread, Activity counts logged activities, Follow-ups
            counts OPEN tasks only. A task appears in two of them, once as something that
            happened and once as something outstanding — which is what the words mean.

            The strip SCROLLS rather than trusting arithmetic. Four labels with counts
            measure ~400px against a 375px phone by my estimate, and an estimate is not a
            layout guarantee — a wrapped or clipped tab bar is the exact failure this
            redesign set out to fix. shrink-0 keeps every label whole; the scrollbar is
            hidden because a 15px overshoot with a visible bar reads as broken. */}
        <div className="flex gap-1 overflow-x-auto border-b border-hairline px-3 sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {(["email", "activity", "followups", "details"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setDrawerTab(t)}
              aria-current={drawerTab === t ? "page" : undefined}
              className={cn(
                /* min-h-11 = 44px, the touch-target floor (CLAUDE.md §20). The old
                   py-2 gave ~32px, which on a phone is a miss waiting to happen. */
                "min-h-11 shrink-0 whitespace-nowrap px-2.5 text-xs font-semibold border-b-2 -mb-px transition-colors",
                drawerTab === t ? "border-amber text-amber-ink" : "border-transparent text-ink-3 hover:text-ink",
              )}
            >
              {t === "email"
                ? `Email${threadSummary.total ? ` (${threadSummary.total})` : ""}`
                : t === "activity"
                ? `Activity${activities.length ? ` (${activities.length})` : ""}`
                : t === "followups"
                  ? `Follow-ups${openTasks.length ? ` (${openTasks.length})` : ""}`
                  : "Details"}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* ── WHAT TO DO NOW ───────────────────────────────────────────────────
              Tab-agnostic on purpose. "What is the next step" does not change with
              which tab you are reading, so it sits above all three rather than inside
              one — and it is the first thing in the scroll, where the drawer opens.

              WHAT THIS USED TO BE. A ~300px contact card that carried five unrelated
              things: the contact's name and number, a Log-call button, a note box, an
              AI-draft button, and this. It sat above every tab, so pinning the tabs
              yesterday bought nothing — the thread still began 300px below them. The
              card was split by what each part is FOR:

                identity        → the SheetHeader, because it must never scroll away
                Log call / note → the Conversation tab, because they ARE the thread
                Generate quote  → deleted; the footer's quote button already calls the
                                  same handleSendQuote, ~40px away in the same drawer
                the decision    → here

              AND IT IS NOW THE ONLY PRIMARY. The footer carried its own stage-aware
              primary built from separate logic, so the drawer showed two full-strength
              "the one thing to do" buttons that could disagree — a new lead with a phone
              showed "Call now · first contact" here and "Send Quote" there. Two primaries
              is no primary. The footer's copy of that logic is gone; it keeps reach-out
              and the two secondaries nextAction does not cover.

              A BUG THIS FIXES ON THE WAY. The old card was gated on
              `lead.contact_phone || lead.contact_email || lead.gstin`, and this block was
              inside it — so a lead with no phone, no email and no GSTIN got NO next-step
              CTA at all. Exactly the lead that most needs telling what to do next, since
              there is nobody to call. The decision does not depend on contact details
              existing, and is no longer gated on them.

              Logic in `nextAction` above. When a quote exists the full status-aware
              QuoteActionBar replaces it (Record payment · Mark accepted · Mark rejected ·
              Open full quote) so the rep never leaves the drawer to move a quote forward —
              and note that ITS "Record payment" opens the dialog inline while
              nextAction's only navigates, which is why the two must never both render. */}
          {latestQuoteForAction ? (
            <div className="space-y-1.5">
              <QuoteActionBar
                quote={latestQuoteForAction}
                onOpenFullQuote={() => router.push(`/quotes/${latestQuoteForAction.id}` as never)}
              />
              {(() => {
                const q = latestQuoteForAction;
                const nothingReceivedYet =
                  !q.payment_status || q.payment_status === "none" || q.payment_status === "awaiting";
                const unpaidSent =
                  (q.status === "sent" || q.status === "viewed") && nothingReceivedYet;
                if (!unpaidSent) return null;
                const overdue = quoteAgeDays !== null && quoteAgeDays > 7;
                const ageText =
                  quoteAgeDays === null ? "" : quoteAgeDays === 0 ? "Sent today" : `Sent ${quoteAgeDays}d ago`;
                return (
                  <p className="flex items-start gap-1 text-xs leading-snug text-ink-3">
                    <Icon name="info" size={11} className="mt-0.5 shrink-0" />
                    <span>
                      {ageText}
                      {overdue && <span className="text-rose font-medium"> · overdue — chase them</span>}
                      {ageText && ". "}
                      Record payment when it lands, or mark accepted to convert the lead into a customer now
                      (payment can follow). Chase via Call/WhatsApp above.
                    </span>
                  </p>
                );
              })()}
            </div>
          ) : nextAction ? (
            <>
            <button
              type="button"
              onClick={() => runNextAction(nextAction)}
              className={cn(
                "w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-md text-sm font-semibold transition-colors",
                nextAction.tone === "amber"   && "bg-amber text-white hover:bg-amber/90",
                nextAction.tone === "rose"    && "bg-rose text-white hover:bg-rose/90",
                nextAction.tone === "emerald" && "bg-emerald text-white hover:bg-emerald/90",
                nextAction.tone === "indigo"  && "bg-indigo text-white hover:bg-indigo/90",
              )}
            >
              <Icon name={nextAction.icon} size={14} />
              {nextAction.label}
              {nextAction.hint && (
                <span className="text-xs opacity-90 ml-1">
                  · {nextAction.hint}
                </span>
              )}
            </button>
            {nextAction.help && (
              <p className="mt-1.5 flex items-start gap-1 text-xs leading-snug text-ink-3">
                <Icon name="info" size={11} className="mt-0.5 shrink-0" />
                {nextAction.help}
              </p>
            )}
            </>
          ) : null}

          {/* ── THE STAGE DISAGREES WITH THE HISTORY ──────────────────────────────
              This is the ROOT of the bug that produced "Call now · first contact" on a
              lead with 15 emails: the stage said New, the thread said otherwise, and the
              CTA believed the stage. That CTA now reads the conversation instead, so the
              lie is gone — but the disagreement is still real, and it is still visible
              everywhere the stage IS the data: the Kanban board keeps this lead in the New
              column, stage-age counts from the wrong date, and the forecast weights it at
              New's win probability.

              A NUDGE, NOT AN AUTO-ADVANCE. Pardeep's call, asked on 23 Aug 2026 with the
              alternative on the table: moving the stage on the first logged touch would
              write to the pipeline without anyone deciding to, change stage-age and
              forecast for every lead at once, and raise a backfill question about history
              already recorded. So this states the mismatch and offers one tap. Nothing
              changes until the tap.

              Deliberately quiet — `text-ink-3`, no fill, no icon-in-a-circle. The drawer
              has exactly one primary action and it took a day to get there; a second
              amber button here would undo that on the screen where it was fixed.

              `stage === "new"` only. Every later stage means somebody has already moved
              it by hand, and second-guessing a human's stage choice is a different and
              much worse feature.

              `basis-full sm:basis-0` on the paragraph, not `flex-1` alone. Browser-verified
              at 375px on 23 Aug: with only flex-1 the text kept shrinking to make room for
              the button beside it, wrapping into five narrow lines against a cramped column
              rather than taking the width and pushing the button underneath. flex-wrap
              alone cannot do that — a flex item shrinks before it wraps. */}
          {lead.stage === "new" && (threadSummary.total > 0 || activities.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
              <p className="min-w-0 basis-full sm:basis-0 sm:flex-1 text-xs leading-snug text-ink-3">
                Stage still reads <b className="font-semibold text-ink-2">New</b>, but there
                {threadSummary.total > 0
                  ? ` ${threadSummary.total === 1 ? "is 1 message" : `are ${threadSummary.total} messages`} in the thread`
                  : ` ${activities.length === 1 ? "is 1 logged activity" : `are ${activities.length} logged activities`}`}
                . The pipeline board and the forecast both read the stage, not the history.
              </p>
              <button
                type="button"
                onClick={() => {
                  void changeStage(lead, "contact");
                  toast.success(`${leadTitle(lead).label} → Contacted`);
                }}
                className="min-h-11 w-full shrink-0 rounded-md border border-hairline-strong bg-paper px-3 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-2 sm:w-auto"
              >
                Move to Contacted
              </button>
            </div>
          )}

          {drawerTab === "details" && (
            <LeadDetailsTab
              lead={lead}
              health={health}
              setAddTaskOpen={setAddTaskOpen}
              setCardsOpen={setCardsOpen}
              drawerPlanCosts={drawerPlanCosts}
              userNames={userNames}
              activities={activities}
              setDrawerTab={setDrawerTab}
              hasQuotes={hasQuotes}
              quotesForLead={quotesForLead}
              latestQuote={latestQuote}
              onClose={onClose}
              changeStage={changeStage}
              handleSendQuote={handleSendQuote}
            />
          )}

          {/* Activity timeline — outbound touches + inbound emails — its own tab */}
          {drawerTab === "activity" && (
            <LeadActivityTab
              lead={lead}
              noteDraft={noteDraft}
              setNoteDraft={setNoteDraft}
              logActivity={logActivity}
              callLog={callLog}
              runOutcome={runOutcome}
              timeline={timeline}
            />
          )}

          {/* ── EMAIL — the exchange with the customer, its own tab ──────────────
              Promoted out of the Activity tab on 23 Aug 2026: "email conversation ka tab
              alag hi bana dete hai". The reasoning is on the tab strip above.

              WHAT IT COSTS, and it is not nothing: an email no longer sits in the same
              list as the call that followed it, so "what happened, in order" and "what did
              we actually say" are two clicks apart instead of one scroll. That is the right
              split here, because they are two different questions and the mail was always
              the one being asked — and Activity still lists the mail-shaped entries it
              logged, so the ORDER is not lost. Only the text lives here.

              It renders after Activity in source rather than before it, so that the reply
              composer below can stay where it is instead of being lifted over 200 lines of
              JSX. Tab ORDER is set by the array in the strip, not by this. */}
          {drawerTab === "email" && (
            <LeadEmailTab
              lead={lead}
              emailThread={emailThread}
              threadSummary={threadSummary}
              loggedEmailSends={loggedEmailSends}
              replyAnchor={replyAnchor}
              currentUser={currentUser}
            />
          )}

          {/* ── Follow-ups — its own tab ────────────────────────────────
              Sales rep talks to the lead → captures next-action with date.
              List is split: open (pending/snoozed) shown prominently, done
              tucked away as a collapsed audit trail. Overdue rows tinted
              rose so they pull the eye. */}
          {drawerTab === "followups" && (
            <LeadFollowupsTab
              openTasks={openTasks}
              doneTasks={doneTasks}
              setAddTaskOpen={setAddTaskOpen}
              completeTask={completeTask}
              snoozeTask={snoozeTask}
              deleteTask={deleteTask}
            />
          )}
        </div>

        <LeadDetailFooter
          lead={lead}
          onEdit={onEdit}
          handleArchive={handleArchive}
          handleDelete={handleDelete}
          deletePending={deleteLead.isPending}
          handleEmail={handleEmail}
          setWhatsOpen={setWhatsOpen}
          latestQuote={latestQuote}
          hasQuotes={hasQuotes}
          nextAction={nextAction}
          handleSendQuote={handleSendQuote}
          handleReviseQuote={handleReviseQuote}
        />
      </SheetContent>

      {/* Add Follow-up dialog — mounted as a sibling of the Sheet so its
          own modal stacking doesn't fight the drawer. */}
      <AddTaskDialog
        open={addTaskOpen}
        onOpenChange={setAddTaskOpen}
        linkLabel={leadTitle(lead).label}
        linkTo={{ lead_id: lead.id }}
      />

      {/* Email from inside the app, so the text is kept and the Email thread has both
          sides. Mounted only with an address, because the composer's whole premise is a
          recipient it can show and cannot edit. */}
      {emailComposerOpen && lead.contact_email && (
        <LeadEmailComposer
          open={emailComposerOpen}
          onOpenChange={setEmailComposerOpen}
          leadId={lead.id}
          company={lead.company}
          toEmail={lead.contact_email}
          contactName={lead.contact_name}
          plan={lead.plan}
          senderName={currentUser?.tenantName ?? null}
        />
      )}

      {/* Send-via-WhatsApp — pre-fills contact phone and an opening line
          using the lead's plan/seats context. */}
      {whatsOpen && lead.contact_phone && (
        <SendWhatsAppDialog
          open={whatsOpen}
          onOpenChange={setWhatsOpen}
          defaultTo={lead.contact_phone}
          defaultText={
            `Hi ${lead.contact_name ?? "there"},\n\n` +
            `Thanks for your interest in ${lead.plan ?? "our cloud services"}` +
            (lead.seats ? ` for ${lead.seats} users.` : ".") +
            `\n\nLet me know if you'd like to schedule a quick call or get a tailored quote.\n\n` +
            `— ${currentUser?.tenantName ?? "your team"}`
          }
          title={`WhatsApp · ${leadTitle(lead).label}`}
          related={{ leadId: lead.id }}
        />
      )}

      {/* Battlecards — sibling of the Sheet for the same stacking reason. */}
      <BattlecardDrawer open={cardsOpen} onClose={() => setCardsOpen(false)} plan={lead.plan} />
    </Sheet>
  );
}
