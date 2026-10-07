"use client";
/**
 * /deals/[id] — one deal, everything about it on one screen (Pardeep, 30 Sep 2026: "deal ke
 * click karne par usse related har activity show honi chahiye, ek deal detail page bhi banao").
 *
 * Built from the lead drawer's parts, not a second copy of them: the same query hooks,
 * the same stage door (changeStage + checkBoardMove, via DealStageStepper), the same
 * expected-close field, follow-ups tab, Call-log popup, email composer and WhatsApp dialog.
 * What is new is the merge — lib/deals/timeline.ts — and the rows the drawer never read
 * (lib/queries/deal-history.ts).
 *
 * The /leads drawer is untouched; /deals opens this page instead.
 */
import * as React from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useLead, useDeleteLead } from "@/lib/queries/leads";
import { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { useConfirm } from "@/components/providers/confirm-provider";
import { dealDeleteBlock } from "@/lib/deals/delete-rules";
import { useLeadActivities, useLogLeadActivity } from "@/lib/queries/lead-activities";
import { useQuotesByLead } from "@/lib/queries/quotes";
import { useTasksForLead, useCompleteTask, useSnoozeTask, useDeleteTask } from "@/lib/queries/tasks";
import { useDealLeadSources, useDealQuoteSources, useDealProjectSources } from "@/lib/queries/deal-history";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useUserNames } from "@/lib/hooks/useUserNames";
import { useLeadOutcome } from "@/lib/leads/use-outcome";
import { useCallLog } from "@/components/features/leads/call-log-dialog";
import { canSeeDeals } from "@/lib/deals/access";
import { buildDealHistory, dealMoney } from "@/lib/deals/timeline";
import { dealQuoteRows } from "@/lib/deals/deal-quotes";
import { isDealStage, isCloseOverdue, closeDateShort } from "@/lib/leads/deal-rules";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";
import { leadDisplayName } from "@/lib/leads/display-name";
import { stageProbability, weightedValue } from "@/lib/leads/forecast";
import { istToday, toIstDate, daysBetweenISO } from "@/lib/dates/ist";
import { rupee, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { MetricCard } from "@/components/features/customers/customer-insights";
import { DealStageStepper } from "@/components/features/deals/deal-stage-stepper";
import { stagesReached } from "@/lib/deals/stages-reached";
import { DealHistoryFeed } from "@/components/features/deals/deal-history-feed";
import {
  DealSummaryCard, DealDetailsCard, DealFollowupsCard, DealQuotesCard, DealMoneyCard,
} from "@/components/features/deals/deal-side-cards";
import type { Lead } from "@/lib/supabase/database.types";
import { leadQuoteHref } from "@/lib/leads/lead-quote-href";

const AddTaskDialog = dynamic(() => import("@/components/features/tasks/add-task-dialog").then((m) => m.AddTaskDialog), { ssr: false });
const LeadEmailComposer = dynamic(() => import("@/components/features/leads/lead-email-composer").then((m) => m.LeadEmailComposer), { ssr: false });
const SendWhatsAppDialog = dynamic(() => import("@/components/features/whatsapp/send-whatsapp-dialog"), { ssr: false });
const AddLeadForm = dynamic(() => import("@/components/features/leads/add-lead-form").then((m) => m.AddLeadForm), { ssr: false });

const STAGE_KIND: Record<Lead["stage"], "muted" | "warning" | "success" | "info" | "danger"> = {
  new: "muted", contact: "muted", quote: "warning", demo: "info", trial: "info", won: "success", lost: "danger",
};

const PAGE = "p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto";

function BackLink() {
  return (
    <Link href={"/deals" as never} className="inline-flex min-h-9 items-center gap-1 text-sm text-ink-3 hover:text-ink">
      <Icon name="arrow_left" size={14} /> All deals
    </Link>
  );
}

function DealDetailSkeleton() {
  return (
    <div className={`${PAGE} space-y-5`} aria-busy="true">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-9 w-full max-w-xl" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Skeleton className="h-96" />
        <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-52" /></div>
      </div>
    </div>
  );
}

export function DealDetailView({ leadId }: { leadId: string }) {
  const router = useRouter();
  const { data: me } = useCurrentUser();
  const leadQ = useLead(leadId);
  const lead = leadQ.data ?? null;

  const { data: activities } = useLeadActivities(lead?.id);
  const { data: tasks } = useTasksForLead(lead?.id);
  const quotesQ = useQuotesByLead(lead?.id);
  const quotes = React.useMemo(() => quotesQ.data ?? [], [quotesQ.data]);
  const leadSrc = useDealLeadSources(lead?.id);
  const quoteSrc = useDealQuoteSources(quotesQ.data);
  /* leads.project_id → the project quotation (lib/queries/deal-history.ts#useDealProjectSources). */
  const projectSrc = useDealProjectSources(lead ? lead.project_id : undefined);
  const { data: userNames } = useUserNames();

  const logActivity = useLogLeadActivity();
  const runOutcome = useLeadOutcome();
  const callLog = useCallLog(runOutcome);
  const completeTask = useCompleteTask();
  const snoozeTask = useSnoozeTask();
  const deleteTask = useDeleteTask();
  /* Lost / Delete on the deal page (2 Oct 2026) — the drawer had them, this page did not. */
  const { changeStage } = useChangeLeadStage();
  const deleteLead = useDeleteLead();
  const confirm = useConfirm();

  const [addTaskOpen, setAddTaskOpen] = React.useState(false);
  const [emailOpen, setEmailOpen] = React.useState(false);
  const [whatsOpen, setWhatsOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);

  const nameOf = React.useCallback(
    (id: string | null | undefined) => (id ? userNames?.get(id)?.label ?? null : null),
    [userNames],
  );

  const history = React.useMemo(() => {
    const l = leadSrc.data;
    const q = quoteSrc.data;
    const pr = projectSrc.data;
    return buildDealHistory({
      lead,
      activities,
      tasks,
      quotes: quotesQ.data,
      emails: l?.emails,
      whatsapp: l?.whatsapp,
      aiCalls: l?.aiCalls,
      quoteSends: q?.quoteSends,
      quoteViews: q?.quoteViews,
      quoteSignatures: q?.quoteSignatures,
      invoices: q?.invoices,
      payments: q?.payments,
      subscriptions: q?.subscriptions,
      projects: pr?.projects,
      projectMilestones: pr?.projectMilestones,
      projectInvoices: pr?.projectInvoices,
      projectPayments: pr?.projectPayments,
      auditLog: [...(l?.auditLog ?? []), ...(q?.auditLog ?? [])],
    }, nameOf);
  }, [lead, activities, tasks, quotesQ.data, leadSrc.data, quoteSrc.data, projectSrc.data, nameOf]);

  const money = React.useMemo(() => dealMoney({
    invoices: quoteSrc.data?.invoices, payments: quoteSrc.data?.payments,
    projects: projectSrc.data?.projects, projectMilestones: projectSrc.data?.projectMilestones,
    projectInvoices: projectSrc.data?.projectInvoices, projectPayments: projectSrc.data?.projectPayments,
  }), [quoteSrc.data, projectSrc.data]);
  const quoteRows = React.useMemo(() => dealQuoteRows(quotes, projectSrc.data?.projects ?? []), [quotes, projectSrc.data]);
  const failed = React.useMemo(
    () => [...new Set([
      ...(leadSrc.data?.failed ?? []), ...(quoteSrc.data?.failed ?? []), ...(projectSrc.data?.failed ?? []),
      ...(leadSrc.error || quoteSrc.error || projectSrc.error ? ["Some records"] : []),
    ])],
    [leadSrc.data, quoteSrc.data, projectSrc.data, leadSrc.error, quoteSrc.error, projectSrc.error],
  );

  // ── Gates ────────────────────────────────────────────────────────────────
  /* Same gate as /deals: middleware already bounces a role whose nav has no /deals (prefix
     match covers /deals/<id>); this mirrors it on the client for the in-app navigation case. */
  if (me && !(canSeeDeals(me.role) || me.canViewDeals)) {
    return (
      <div className={PAGE}>
        <EmptyState icon="lock" title="No access to Deals" body="Ask your manager for Deals access." />
      </div>
    );
  }
  if (leadQ.isLoading) return <DealDetailSkeleton />;
  if (leadQ.error || !lead) {
    return (
      <div className={PAGE}>
        <BackLink />
        <EmptyState
          icon="alert"
          title={leadQ.error ? "Couldn't load deal" : "Deal not found"}
          body={leadQ.error ? (leadQ.error as Error).message : `${leadId} is not in this workspace, or was deleted.`}
          action={<Button asChild variant="primary" icon="arrow_left"><Link href={"/deals" as never}>All deals</Link></Button>}
        />
      </div>
    );
  }

  // ── Derived ──────────────────────────────────────────────────────────────
  const today = istToday();
  const overdue = isCloseOverdue(lead, today);
  const prob = stageProbability(lead.stage);
  const daysInStage = daysBetweenISO(toIstDate(lead.stage_changed_at ?? lead.created_at), today);
  const owner = nameOf(lead.owner_id);
  const openTasks = (tasks ?? []).filter((t) => t.status === "pending" || t.status === "snoozed");
  const doneTasks = (tasks ?? []).filter((t) => t.status === "done");
  const latestQuote = quotes[0];
  const title = lead.company?.trim() || leadDisplayName(lead).label;

  /* Delete — owner/manager only, never with a quote on it (lib/deals/delete-rules.ts; the
     database enforces both). Blocked → say why and offer Lost, in the toast. */
  const onDelete = async () => {
    const block = dealDeleteBlock({ role: me?.role, quoteIds: quotes.map((q) => q.id) });
    if (block) {
      toast.error("This deal can't be deleted", {
        description: block,
        action: lead.stage !== "lost" && lead.stage !== "won" ? { label: "Mark lost", onClick: () => { void changeStage(lead, "lost"); } } : undefined,
      });
      return;
    }
    const ok = await confirm({ title: `Delete "${title}" for good?`, body: "Its notes, calls and follow-ups go with it. This cannot be undone — Mark lost keeps the history instead.", danger: true, confirmLabel: "Delete" });
    if (!ok) return;
    deleteLead.mutate(lead.id, { onSuccess: () => router.push("/deals" as never) });
  };

  /* Same hand-off as the drawer's handleSendQuote — the quote builder reads these params. */
  const newQuote = () => {
    if (lead.enquiry_type === "project") {
      router.push((lead.project_id ? `/projects/${lead.project_id}` : `/deals?projectQuote=${lead.id}`) as never);
      return;
    }
    /* R-389 (F5): id + plan/seats only — no email/phone in the URL. */
    router.push(leadQuoteHref(lead) as never);
  };

  return (
    <div className={PAGE}>
      <BackLink />

      {!isDealStage(lead.stage) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-amber/40 bg-amber-soft/60 px-3 py-2 text-sm text-amber-ink">
          <Icon name="info" size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">Still a lead ({STAGE_LABEL[lead.stage]}). It moves to Deals once a quote is sent.</span>
          <Link href={`/leads?lead=${lead.id}` as never} className="font-semibold underline underline-offset-2 hover:text-ink">Open in Leads</Link>
        </div>
      )}

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="mt-3 mb-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-ink-3">{isDealStage(lead.stage) ? "Deal" : "Lead"} · <span className="font-mono">{lead.id}</span></p>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-serif text-3xl leading-tight md:text-4xl break-words">{title}</h1>
              {!lead.company?.trim() && <span className="text-xs text-ink-3">(no company — add via Edit)</span>}
              <Badge kind={STAGE_KIND[lead.stage]} dot>{STAGE_LABEL[lead.stage]}</Badge>
            </div>
            {(lead.contact_name || lead.contact_phone || lead.contact_email) && (
              <p className="mt-1 text-sm text-ink-2 break-words">
                {lead.contact_name && <span className="font-medium text-ink">{lead.contact_name}</span>}
                {lead.contact_name && (lead.contact_phone || lead.contact_email) && " · "}
                <span className="font-mono text-xs text-ink-3">
                  {lead.contact_phone}{lead.contact_phone && lead.contact_email && " · "}{lead.contact_email}
                </span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {lead.contact_phone && (
              <Button asChild icon="mobile"><a href={`tel:${lead.contact_phone}`}>Call</a></Button>
            )}
            {lead.contact_phone && <Button icon="whatsapp" onClick={() => setWhatsOpen(true)}>WhatsApp</Button>}
            <Button
              icon="mail"
              onClick={() => {
                if (!lead.contact_email) { toast.error("No email on this deal — add one via Edit."); return; }
                setEmailOpen(true);
              }}
            >Email</Button>
            <Button icon="edit" variant="ghost" onClick={() => setEditOpen(true)}>Edit</Button>
            {lead.stage !== "won" && lead.stage !== "lost" && (
              <Button variant="ghost" onClick={() => { void changeStage(lead, "lost"); }}>Mark lost</Button>
            )}
            <Button variant="ghost" icon="trash" className="!text-rose hover:!bg-rose/10" loading={deleteLead.isPending} onClick={onDelete}>Delete</Button>
            {lead.stage !== "won" && lead.stage !== "lost" && (
              <Button variant="primary" icon="send" onClick={newQuote}>{quoteRows.length ? "New quote" : "Send quote"}</Button>
            )}
          </div>
        </div>

        <DealStageStepper
          lead={lead}
          reached={stagesReached({ stageMoves: history.stageMoves, quotes, projectQuotes: quoteRows, trialStartedAt: lead.trial_started_at })}
        />

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
          <MetricCard label="Deal value" value={lead.value ? rupee(lead.value) : "—"} hint={lead.value ? (lead.enquiry_type === "project" || lead.project_id ? "one-time, ex-GST" : "per year") : "Add via Edit"} />
          <MetricCard label="Weighted" value={lead.value ? rupee(weightedValue(lead)) : "—"} hint={`${prob}% · ${STAGE_LABEL[lead.stage]}`} />
          <MetricCard
            label="Expected close"
            value={lead.expected_close_date ? closeDateShort(lead.expected_close_date) : "—"}
            tone={overdue ? "danger" : "default"}
            hint={overdue ? "Overdue — update date" : lead.expected_close_date ? lead.expected_close_date.slice(0, 4) : "Not set"}
          />
          <MetricCard label="In stage" value={`${Math.max(0, daysInStage)}d`} hint={lead.stage_changed_at ? `since ${formatDate(lead.stage_changed_at)}` : "since created"} />
          <MetricCard label="Owner" value={owner ?? "—"} />
          <MetricCard label="Source" value={lead.source ?? "—"} />
          <MetricCard label="Created" value={formatDate(lead.created_at)} />
        </div>
      </header>

      {/* ── Body: history left, cards right (stacked on mobile) ─────────── */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <DealHistoryFeed
          lead={lead}
          history={history}
          loading={!activities || leadSrc.isLoading || quotesQ.isLoading || quoteSrc.isLoading || projectSrc.isLoading}
          failed={failed}
          logActivity={logActivity}
          onCallLog={() => callLog.run("talked", lead)}
          onAddFollowUp={() => setAddTaskOpen(true)}
        />
        <div className="min-w-0 space-y-4">
          <DealSummaryCard lead={lead} latestQuote={latestQuote} />
          <DealFollowupsCard
            openTasks={openTasks} doneTasks={doneTasks} setAddTaskOpen={setAddTaskOpen}
            completeTask={completeTask} snoozeTask={snoozeTask} deleteTask={deleteTask}
          />
          <DealQuotesCard rows={quoteRows} onNewQuote={newQuote} projectFailed={(projectSrc.data?.failed ?? []).includes("Project quotation") || !!projectSrc.error} />
          <DealMoneyCard
            money={money}
            subscriptions={quoteSrc.data?.subscriptions?.length ?? 0}
            failed={[...(quoteSrc.data?.failed ?? []), ...(projectSrc.data?.failed ?? [])].some((f) => f === "Invoices" || f === "Payments" || f.startsWith("Project"))}
            hasQuotes={quoteRows.length > 0}
          />
          <DealDetailsCard lead={lead} userNames={userNames} onEdit={() => setEditOpen(true)} />
        </div>
      </div>

      {callLog.dialog}
      <AddTaskDialog open={addTaskOpen} onOpenChange={setAddTaskOpen} linkLabel={lead.company} linkTo={{ lead_id: lead.id }} />
      {editOpen && <AddLeadForm open={editOpen} onOpenChange={setEditOpen} editingLead={lead} />}
      {emailOpen && lead.contact_email && (
        <LeadEmailComposer
          open={emailOpen}
          onOpenChange={setEmailOpen}
          leadId={lead.id}
          company={lead.company}
          toEmail={lead.contact_email}
          contactName={lead.contact_name}
          plan={lead.plan}
          senderName={me?.tenantName ?? null}
        />
      )}
      {whatsOpen && lead.contact_phone && (
        <SendWhatsAppDialog
          open={whatsOpen}
          onOpenChange={setWhatsOpen}
          defaultTo={lead.contact_phone}
          defaultText={
            `Hi ${lead.contact_name ?? "there"},\n\n` +
            `Following up on ${lead.plan ?? "your requirement"}` +
            (lead.seats ? ` for ${lead.seats} users.` : ".") +
            `\n\n— ${me?.tenantName ?? "your team"}`
          }
          title={`WhatsApp · ${lead.company}`}
          related={{ leadId: lead.id }}
        />
      )}
    </div>
  );
}
