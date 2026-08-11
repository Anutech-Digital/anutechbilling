"use client";

/**
 * customer-insights — the single source of truth for the "world-class customer
 * view" shared by BOTH the master-detail CustomerPanel and the full /customers/[id]
 * 360 page. Keeping the money-derivation here (not duplicated per surface) means
 * the panel and the page can never drift and show a different Outstanding / MRR /
 * Lifetime figure — a real money-correctness hazard if it were copy-pasted.
 *
 * MONEY-HONESTY: every number comes from real rows. No fabricated data, no stub
 * activity. The Next-Best-Action is DETERMINISTIC (rules over real data, not AI)
 * so there is zero hallucination risk on money figures, and nothing here writes
 * money — reminders are plain WhatsApp/email deep-links.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import type { Customer, Subscription, Invoice, Quote } from "@/lib/supabase/database.types";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatPhone, initials, rupee, daysBetween, cn } from "@/lib/utils";
import { isExportSupply } from "@/lib/gst/place-of-supply";

// ════════════════════════════════════════════════════════════════════════
// Pure logic
// ════════════════════════════════════════════════════════════════════════
export type Nba = {
  tone: "danger" | "warning" | "info" | "success";
  icon: string;
  title: string;
  body: string;
  cta?: { label: string; kind: "draft" | "profile" | "quote" | "open_quote"; channel?: "whatsapp" | "email"; purpose?: "followup" | "reminder"; quoteId?: string };
};

export type CustomerInsights = {
  activeSubs: Subscription[];
  totalMRR: number;
  seatsTotal: number;
  seatsUsed: number;
  outstanding: number;        // subscriptions + project receivables
  projectReceivable: number;  // money owed on accepted projects
  lifetimePaid: number;
  overdueCount: number;
  nearestRenewal?: string;
  renewalDays: number | null;
  nba: Nba;
};

/** Derive all customer KPIs + the next-best-action from real rows. */
export function deriveCustomerInsights(
  c: Customer,
  subs: Subscription[],
  invoices: Invoice[],
  /** Accepted/active project sales — used to add project money to Outstanding
   *  (receivable) AND to Lifetime paid (paid = milestone receipts). */
  projects: { status: string; receivable: number; paid?: number }[] = [],
  /** Existing quotes — so the next-best-action doesn't say "first quote" when
   *  the customer already has drafts/sent quotes sitting there. */
  quotes: { id: string; status: string; created_date?: string | null }[] = [],
  /** Sum of RECEIVED customer payments (the `payments` table — subscription /
   *  direct invoices). Project milestone receipts come from projects[].paid;
   *  the two tables never overlap, so adding them = true cash collected. */
  receivedPayments = 0,
): CustomerInsights {
  const activeSubs = subs.filter((s) => s.status === "active");
  const totalMRR = activeSubs.reduce((s, x) => s + (x.mrr ?? 0), 0);
  const seatsTotal = activeSubs.reduce((s, x) => s + (x.seats ?? 0), 0);
  const seatsUsed = activeSubs.reduce((s, x) => s + (x.used ?? 0), 0);

  // Outstanding = subscription dues + accepted-project receivables + any
  // STANDALONE unpaid invoices. Without the project side a customer with an
  // unpaid project wrongly showed "All clear"; without the standalone-invoice
  // side, a direct/one-off invoice (no subscription, no project — e.g. a
  // "Website Development" bill) ALSO wrongly showed "All clear" even with a big
  // balance due.
  const subsOutstanding = subs.reduce((s, x) => s + (x.outstanding_amount ?? 0), 0);
  const activeProjects = projects.filter((p) => p.status === "active");
  const projectReceivable = projects
    .filter((p) => p.status === "active" || p.status === "completed")
    .reduce((s, p) => s + Math.max(0, p.receivable ?? 0), 0);
  // Unpaid invoices NOT already represented elsewhere, to avoid double-counting:
  //  • a subscription's invoice → its money is in subsOutstanding (matched by quote_id)
  //  • a project's invoice → raised with a null quote_id → in projectReceivable
  // So only add pending/overdue invoices that have a quote_id NOT belonging to a
  // subscription — i.e. genuine standalone/direct invoices.
  const subQuoteIds = new Set(
    subs.flatMap((s) => [s.quote_id, s.renewal_quote_id]).filter((q): q is string => !!q),
  );
  const standaloneUnpaid = invoices
    .filter((i) => (i.status === "pending" || i.status === "overdue") && !!i.quote_id && !subQuoteIds.has(i.quote_id))
    .reduce((s, i) => s + Math.max(0, i.net_payable ?? i.amount ?? 0), 0);
  const outstanding = subsOutstanding + projectReceivable + standaloneUnpaid;

  // Actual cash collected = project milestone receipts + received payments
  // (subscription/direct). NOT the sum of "paid" invoices — that missed
  // partial receipts (a part-paid project invoice sits at status='pending').
  const projectPaid = projects.reduce((s, p) => s + Math.max(0, p.paid ?? 0), 0);
  const lifetimePaid = projectPaid + Math.max(0, receivedPayments);
  const overdueCount = invoices.filter((i) => i.status === "overdue").length;

  const nearestRenewal = activeSubs
    .map((s) => s.renewal_date)
    .filter((d): d is string => !!d)
    .sort()[0];
  const renewalDays = nearestRenewal ? daysBetween(new Date(), nearestRenewal) : null;

  const firstName = (c.contact_name || c.name).split(/\s+/)[0];
  const phone = c.contact_phone?.replace(/\s+/g, "");

  // Existing quotes → so we suggest sending/chasing them instead of "first quote".
  const draftQuotes = quotes.filter((q) => q.status === "draft");
  const openQuotes  = quotes.filter((q) => q.status === "sent" || q.status === "viewed");
  const byNewest = (a: { created_date?: string | null }, b: { created_date?: string | null }) =>
    (b.created_date ?? "").localeCompare(a.created_date ?? "");
  const actionableQuote = [...draftQuotes].sort(byNewest)[0] ?? [...openQuotes].sort(byNewest)[0];

  const nba = computeNBA({
    customer: c, firstName, phone, outstanding, overdueCount, renewalDays,
    subCount: subs.length, projectReceivable, activeProjectCount: activeProjects.length, projectCount: projects.length,
    draftCount: draftQuotes.length, openCount: openQuotes.length, actionableQuoteId: actionableQuote?.id,
  });

  return { activeSubs, totalMRR, seatsTotal, seatsUsed, outstanding, projectReceivable, lifetimePaid, overdueCount, nearestRenewal, renewalDays, nba };
}

function computeNBA(args: {
  customer: Customer; firstName: string; phone?: string;
  outstanding: number; overdueCount: number; renewalDays: number | null; subCount: number;
  projectReceivable: number; activeProjectCount: number; projectCount: number;
  draftCount: number; openCount: number; actionableQuoteId?: string;
}): Nba {
  const { customer, firstName, phone, outstanding, overdueCount, renewalDays, subCount, projectReceivable, activeProjectCount, projectCount, draftCount, openCount, actionableQuoteId } = args;
  const canMessage = !!phone || !!customer.contact_email;
  const channel: "whatsapp" | "email" = phone ? "whatsapp" : "email";

  // 1. Money owed — subscriptions AND/OR project payments.
  if (outstanding > 0 || overdueCount > 0) {
    const allProject = projectReceivable > 0 && projectReceivable >= outstanding;
    // Only break out the project figure when it's a PART of the total — when the
    // whole outstanding IS the project, tag it "project" without repeating the ₹.
    const projPart =
      projectReceivable <= 0 ? "" :
      allProject          ? " · project" :
                            ` · ${rupee(projectReceivable)} project`;
    return {
      tone: "danger",
      icon: "alert",
      title: `${rupee(outstanding)} outstanding${projPart}${overdueCount > 0 ? ` · ${overdueCount} overdue invoice${overdueCount > 1 ? "s" : ""}` : ""}`,
      body: allProject
        ? "This is a project payment still owed — collect it before it ages. AI can draft a friendly reminder."
        : projectReceivable > 0
        ? "Includes a project payment still owed — collect it before it ages. AI can draft a friendly reminder."
        : "Collect this before it ages further — let AI draft a friendly reminder you can edit and send.",
      cta: canMessage ? { label: "Draft reminder with AI", kind: "draft", channel, purpose: "reminder" } : undefined,
    };
  }

  // 2. Renewal coming up.
  if (renewalDays != null && renewalDays <= 30) {
    return {
      tone: "warning",
      icon: "refresh",
      title: renewalDays < 0 ? `Renewal ${-renewalDays} day(s) overdue` : `Renewal due in ${renewalDays} day(s)`,
      body: "Review the renewal quote and send it before service lapses.",
      cta: { label: "Send renewal quote", kind: "quote" },
    };
  }

  // 3. An active project (paid up) is in flight — follow up on the milestone.
  if (activeProjectCount > 0) {
    return {
      tone: "info",
      icon: "package",
      title: `${activeProjectCount} project${activeProjectCount > 1 ? "s" : ""} in progress`,
      body: "Follow up on the project milestone — keep it moving and raise the invoice on completion.",
      cta: canMessage ? { label: "Draft a project check-in with AI", kind: "draft", channel, purpose: "followup" } : undefined,
    };
  }

  // 4. No subscription / project yet — but the action depends on whether quotes
  //    already exist. Only push a BRAND-NEW quote when there are none.
  if (subCount === 0 && projectCount === 0) {
    // 4a. Draft quote(s) sitting unsent → finish + send them.
    if (draftCount > 0) {
      return {
        tone: "warning",
        icon: "file",
        title: `${draftCount} draft quote${draftCount > 1 ? "s" : ""} not sent yet`,
        body: `Review and send ${draftCount > 1 ? "them" : "it"} so ${firstName} can accept and pay.`,
        cta: actionableQuoteId ? { label: "Review & send quote", kind: "open_quote", quoteId: actionableQuoteId } : undefined,
      };
    }
    // 4b. Quote(s) already sent, awaiting a decision → follow up.
    if (openCount > 0) {
      return {
        tone: "info",
        icon: "clock",
        title: `${openCount} quote${openCount > 1 ? "s" : ""} awaiting ${firstName}'s decision`,
        body: "You've sent a quote — a friendly nudge helps close it. AI can draft one.",
        cta: (phone || customer.contact_email)
          ? { label: "Draft a follow-up with AI", kind: "draft", channel: phone ? "whatsapp" : "email", purpose: "followup" }
          : (actionableQuoteId ? { label: "Open the quote", kind: "open_quote", quoteId: actionableQuoteId } : undefined),
      };
    }
    // 4c. Genuinely new — no quotes at all → send the first one.
    return {
      tone: "info",
      icon: "plus",
      title: "No quote yet",
      body: `Send ${firstName} the first quote — turn this contact into recurring revenue.`,
      cta: { label: "Create first quote", kind: "quote" },
    };
  }

  // 5. Existing customer, all clear → keep the relationship warm.
  return {
    tone: "success",
    icon: "check_circle",
    title: `${firstName} is in good shape`,
    body: "Nothing needs action right now. A periodic check-in keeps the relationship warm.",
    cta: canMessage ? { label: "Draft a check-in with AI", kind: "draft", channel, purpose: "followup" } : undefined,
  };
}

export type CustomerEvent = { date: string; icon: string; color: string; title: string; sub?: string };

/** Weave real quotes/invoices/subscriptions into one reverse-chronological feed. */
export function buildCustomerActivity(subs: Subscription[], invoices: Invoice[], quotes: Quote[]): CustomerEvent[] {
  const events: CustomerEvent[] = [];
  for (const s of subs) {
    if (s.start_date) events.push({ date: s.start_date, icon: "refresh", color: "text-emerald", title: "Subscription started", sub: `${s.plan}${s.domain ? ` · ${s.domain}` : ""} · ${s.seats} seats` });
  }
  for (const q of quotes) {
    if (q.created_date) events.push({ date: q.created_date, icon: "file", color: "text-indigo", title: `Quote ${q.id} ${q.status}`, sub: q.plan ?? undefined });
  }
  for (const i of invoices) {
    if (i.paid_date) events.push({ date: i.paid_date, icon: "check_circle", color: "text-emerald", title: `Invoice ${i.id} paid`, sub: rupee(i.amount) });
    else if (i.invoice_date) events.push({ date: i.invoice_date, icon: "receipt", color: i.status === "overdue" ? "text-rose" : "text-ink-3", title: `Invoice ${i.id} ${i.status}`, sub: rupee(i.amount) });
  }
  return events.sort((a, b) => b.date.localeCompare(a.date));
}

// ════════════════════════════════════════════════════════════════════════
// Presentational components — identical across panel + 360 page
// ════════════════════════════════════════════════════════════════════════

/** 4-KPI answer-bar — health / owed / value in one glance (real numbers). */
export function CustomerMetricBar({ insights }: { insights: CustomerInsights }) {
  const { outstanding, projectReceivable, overdueCount, lifetimePaid, totalMRR, activeSubs, seatsUsed, seatsTotal, nearestRenewal, renewalDays } = insights;
  // Exact figures (not compact lakh) for the money KPIs so they match the
  // Next-Best-Action + Transactions to the rupee — "₹15.2L" vs "₹15,16,000"
  // for the same number read as two different amounts.
  const outHint = [
    overdueCount > 0 ? `${overdueCount} overdue` : null,
    projectReceivable > 0 ? `${rupee(projectReceivable)} project` : null,
  ].filter(Boolean).join(" · ") || undefined;
  // auto-fit → columns follow the CONTAINER width (not the viewport), so this
  // strip fits whether it's in the narrow split-view panel, the full-width panel,
  // or the /customers/[id] page — 4-across when wide, wraps otherwise, never cut.
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3">
      <MetricCard
        label="Outstanding"
        value={outstanding > 0 ? rupee(outstanding) : "All clear"}
        tone={outstanding > 0 ? "danger" : "success"}
        hint={outHint}
      />
      <MetricCard label="Lifetime paid" value={lifetimePaid > 0 ? rupee(lifetimePaid) : "—"} />
      <MetricCard
        label="MRR"
        value={totalMRR > 0 ? rupee(totalMRR) : "—"}
        hint={activeSubs.length > 0 ? `${activeSubs.length} sub${activeSubs.length > 1 ? "s" : ""} · ${seatsUsed}/${seatsTotal} seats` : undefined}
      />
      <MetricCard
        label="Next renewal"
        value={nearestRenewal ? formatDate(nearestRenewal) : "—"}
        tone={renewalDays != null && renewalDays <= 30 ? "warning" : "default"}
        hint={renewalDays != null ? (renewalDays < 0 ? `${-renewalDays}d overdue` : `in ${renewalDays}d`) : undefined}
      />
    </div>
  );
}

const NBA_TONE: Record<Nba["tone"], { wrap: string; icon: string }> = {
  danger:  { wrap: "border-rose/30 bg-rose/5",         icon: "text-rose" },
  warning: { wrap: "border-amber/30 bg-amber-soft/40", icon: "text-amber" },
  info:    { wrap: "border-indigo/30 bg-indigo/5",     icon: "text-indigo" },
  success: { wrap: "border-emerald/30 bg-emerald/5",   icon: "text-emerald" },
};

/** Next-best-action card — kills decision fatigue. Money/contact actions draft
 *  a real, editable AI message (the genuine AI-native edge vs pre-AI tools). */
export function NextBestActionCard({ nba, customer }: { nba: Nba; customer: Customer }) {
  const router = useRouter();
  const tone = NBA_TONE[nba.tone];
  const cta = nba.cta;

  const phone = customer.contact_phone?.replace(/\s+/g, "");
  const channel = cta?.channel ?? "whatsapp";

  const [draft, setDraft] = React.useState<{ subject: string; message: string; mode: string } | null>(null);
  const [drafting, setDrafting] = React.useState(false);

  // Reset the draft when the selected customer changes (panel reuses this instance).
  React.useEffect(() => { setDraft(null); setDrafting(false); }, [customer.id]);

  async function generate() {
    if (!cta) return;
    setDrafting(true);
    setDraft(null);
    try {
      const res = await fetch("/api/ai/draft-followup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: customer.id, channel: cta.channel ?? "whatsapp", purpose: cta.purpose ?? "followup" }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Couldn't draft."); return; }
      setDraft({ subject: data.subject ?? "", message: data.message ?? "", mode: data.mode ?? "stub" });
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setDrafting(false);
    }
  }

  const sendLink = draft
    ? channel === "whatsapp" && phone
      ? `https://wa.me/${phone.replace(/^\+/, "")}?text=${encodeURIComponent(draft.message)}`
      : customer.contact_email
        ? `mailto:${customer.contact_email}?subject=${encodeURIComponent(draft.subject || `Regarding ${customer.name}`)}&body=${encodeURIComponent(draft.message)}`
        : null
    : null;

  return (
    <div className={cn("rounded-lg border p-3.5 flex items-start gap-3", tone.wrap)}>
      <div className={cn("mt-0.5", tone.icon)}><Icon name={nba.icon} size={18} /></div>
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5 inline-flex items-center gap-1">
          <Icon name="sparkles" size={11} className="text-amber" /> Next best action
        </div>
        <div className="text-sm font-medium text-ink leading-snug">{nba.title}</div>
        <p className="text-xs text-ink-2 mt-0.5 leading-relaxed">{nba.body}</p>

        {cta && (cta.kind === "profile" || cta.kind === "quote" || cta.kind === "open_quote") && (
          <div className="mt-2.5">
            <Button
              size="sm"
              variant="primary"
              onClick={() => router.push((
                cta.kind === "quote"      ? `/quotes/new?customer=${customer.id}`
                : cta.kind === "open_quote" ? `/quotes/${cta.quoteId}`
                : `/customers/${customer.id}`
              ) as never)}
            >
              {cta.label}
            </Button>
          </div>
        )}

        {cta && cta.kind === "draft" && (
          <div className="mt-2.5">
            {!draft && (
              <Button size="sm" variant="primary" onClick={generate} disabled={drafting}>
                <Icon name="sparkles" size={13} className="mr-1.5" />
                {drafting ? "Drafting…" : cta.label}
              </Button>
            )}
            {draft && (
              <div className="rounded-md border border-hairline bg-paper p-2.5">
                <Textarea
                  rows={channel === "email" ? 6 : 4}
                  value={draft.message}
                  onChange={(e) => setDraft({ ...draft, message: e.target.value })}
                />
                <div className="flex items-center justify-between gap-2 mt-2 flex-wrap">
                  <span className="text-[10px] text-ink-3">
                    {draft.mode === "gemini" ? "AI draft · verify the amount, then send" : "Template · add a Gemini key in Settings → Integrations for real AI"}
                  </span>
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="default" onClick={generate} disabled={drafting}>{drafting ? "…" : "Redraft"}</Button>
                    <Button size="sm" variant="default" onClick={() => { navigator.clipboard?.writeText(draft.message); toast.success("Copied"); }}>Copy</Button>
                    {sendLink && (
                      <Button asChild size="sm" variant="primary">
                        <a href={sendLink} target={channel === "whatsapp" ? "_blank" : undefined} rel="noopener noreferrer">
                          <Icon name={channel === "whatsapp" ? "whatsapp" : "mail"} size={13} className="mr-1.5" />Send
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Quick contact action buttons (Call / WhatsApp / Email) — real deep-links. */
export function CustomerContactActions({ customer }: { customer: Customer }) {
  const phone = customer.contact_phone?.replace(/\s+/g, "");
  return (
    <div className="flex flex-wrap gap-2">
      {phone && (
        <Button asChild size="sm" variant="primary">
          <a href={`tel:${phone}`}><Icon name="phone" size={13} className="mr-1.5" />Call</a>
        </Button>
      )}
      {phone && (
        <Button asChild size="sm" variant="default">
          <a href={`https://wa.me/${phone.replace(/^\+/, "")}`} target="_blank" rel="noopener noreferrer">
            <Icon name="whatsapp" size={13} className="mr-1.5" />WhatsApp
          </a>
        </Button>
      )}
      {customer.contact_email && (
        <Button asChild size="sm" variant="default">
          <a href={`mailto:${customer.contact_email}`}><Icon name="mail" size={13} className="mr-1.5" />Email</a>
        </Button>
      )}
    </div>
  );
}

const VENDOR_COLOR: Record<string, "info" | "indigo" | "amber" | "slate"> = {
  google: "info", microsoft: "indigo", zoho: "amber", other: "slate",
};

/** Billing cycle / term, derived from the start↔renewal span. */
function subTerm(start: string | null, renewal: string | null): string | null {
  if (!start || !renewal) return null;
  const m = Math.round(daysBetween(start, renewal) / 30.44);
  if (m <= 1) return "Monthly";
  if (m <= 4) return "Quarterly";
  if (m <= 8) return "Half-yearly";
  return "Annual";
}

/** Subscription cards — plan, seats(used/total), MRR, renewal + state, owed pill. */
export function SubscriptionList({ subs }: { subs: Subscription[] }) {
  if (subs.length === 0) {
    return <PanelEmpty icon="refresh" text="No subscriptions yet — send the first quote to get them started." />;
  }
  return (
    <div className="space-y-2">
      {subs.map((s) => {
        const active = s.status === "active";
        const owed = s.outstanding_amount ?? 0;
        const renewalDays = s.renewal_date ? daysBetween(new Date(), s.renewal_date) : null;
        const term = subTerm(s.start_date, s.renewal_date);
        return (
          <div key={s.id} className="border border-hairline rounded-md px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-paper-2/30">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-ink truncate">{s.plan}</span>
                <Badge kind={active ? "success" : "muted"} color={VENDOR_COLOR[s.vendor] ?? "slate"} size="sm" dot>{s.status}</Badge>
                {term && <Badge kind="muted" size="sm">{term}</Badge>}
              </div>
              <div className="text-[11px] text-ink-3 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                {s.domain && (
                  <span className="inline-flex items-center gap-1 font-mono text-amber-ink" title="Domain this subscription is provisioned on">
                    <Icon name="globe" size={11} /> {s.domain}
                  </span>
                )}
                <span>{s.used ?? 0}/{s.seats} seats</span>
                {s.start_date && s.renewal_date ? (
                  <span>{formatDate(s.start_date)} → {formatDate(s.renewal_date)}</span>
                ) : s.renewal_date ? (
                  <span>Renews {formatDate(s.renewal_date)}</span>
                ) : null}
                {renewalDays != null && renewalDays <= 30 && (
                  <span className="text-amber-ink font-medium">renews in {renewalDays}d</span>
                )}
              </div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-sm font-medium text-ink tabular-nums">{rupee(s.mrr)}<span className="text-[10px] text-ink-3">/mo</span></div>
              {term === "Annual" && <div className="text-[10px] text-ink-3 tabular-nums">{rupee(s.mrr * 12, { compact: true })}/yr</div>}
              {owed > 0 && <div className="text-[11px] text-rose mt-0.5">{rupee(owed)} due</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Woven real-data activity feed. */
export function CustomerActivity({ subs, invoices, quotes, limit = 12 }: {
  subs: Subscription[]; invoices: Invoice[]; quotes: Quote[]; limit?: number;
}) {
  const events = buildCustomerActivity(subs, invoices, quotes).slice(0, limit);
  if (events.length === 0) return <PanelEmpty icon="clock" text="No activity yet." />;
  return (
    <ul className="space-y-3">
      {events.map((e, idx) => (
        <li key={idx} className="flex items-start gap-2.5">
          <Icon name={e.icon} size={14} className={cn("mt-0.5 flex-shrink-0", e.color)} />
          <div className="flex-1 min-w-0 flex items-baseline justify-between gap-2">
            <div className="min-w-0">
              <span className="text-sm text-ink-2">{e.title}</span>
              {e.sub && <span className="text-[11px] text-ink-3 ml-1.5">· {e.sub}</span>}
            </div>
            <span className="text-[11px] text-ink-3 flex-shrink-0">{formatDate(e.date)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** GST / contact / address — the rarely-needed stuff, progressive-disclosure. */
export function CustomerDetailsGrid({ c }: { c: Customer }) {
  const tds = c.tds_default_rate_pct != null ? `${c.tds_default_section ?? "TDS"} @ ${c.tds_default_rate_pct}%` : null;
  const address = [c.address, c.state, c.pin_code].filter(Boolean).join(", ") || null;
  return (
    <div className="space-y-5">
      <div>
        <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-2">Tax &amp; compliance</div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6">
          <Field label="GSTIN" value={c.gstin} mono badge={c.gstin ? (c.gstin_verified_at ? { kind: "success", text: "verified" } : { kind: "muted", text: "unverified" }) : undefined} />
          <Field label="Place of supply" value={c.state} />
          <Field label="TAN" value={c.tan} mono />
          <Field label="TDS" value={tds} />
        </dl>
      </div>
      <div className="pt-4 border-t border-hairline">
        <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-2">Contact</div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6">
          <Field label="Primary contact" value={c.contact_name} />
          <Field label="Title" value={c.contact_title} />
          <Field label="Email" value={c.contact_email} mono />
          <Field label="Phone" value={c.contact_phone} mono />
          <Field label="Address" value={address} />
          <Field label="Customer since" value={formatDate(c.since)} />
        </dl>
      </div>
      {c.notes && (
        <div className="pt-4 border-t border-hairline">
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Notes</div>
          <p className="text-sm text-ink-2 whitespace-pre-wrap">{c.notes}</p>
        </div>
      )}
    </div>
  );
}

/**
 * CustomerIdentityRail — the Zoho-style left column on the customer 360 page:
 * WHO this customer is (contact + quick actions), WHERE (billing/shipping
 * address), and the tax/billing facts (Other details). All read-only, real data.
 */
export function CustomerIdentityRail({ c }: { c: Customer }) {
  const phone = c.contact_phone?.replace(/\s+/g, "");
  const foreign = isExportSupply(c.country);

  const billing = [
    c.address,
    [c.city, c.state].filter(Boolean).join(", "),
    c.pin_code,
    c.country && c.country !== "India" ? c.country : null,
  ].filter(Boolean) as string[];

  const ship = c.shipping_address;
  const shipLines = ship
    ? ([ship.attention, ship.address, [ship.city, ship.state].filter(Boolean).join(", "), ship.zip, ship.country]
        .filter(Boolean) as string[])
    : [];

  const tds = c.tds_default_rate_pct != null ? `${c.tds_default_section ?? "TDS"} @ ${c.tds_default_rate_pct}%` : null;
  const terms =
    c.payment_terms_days == null ? "Net 30 (default)"
    : c.payment_terms_days === 0 ? "Due on receipt"
    : `Net ${c.payment_terms_days}`;

  return (
    <div className="space-y-4">
      {/* Contact person + quick actions */}
      <Card>
        <div className="flex items-start gap-3">
          <Avatar initials={initials(c.contact_name || c.name) || "?"} color="amber" size="md" />
          <div className="min-w-0 flex-1">
            <div className="font-medium text-ink truncate">{c.contact_name || c.name}</div>
            {c.contact_title && <div className="text-[11px] text-ink-3">{c.contact_title}</div>}
            <div className="mt-1.5 space-y-1">
              {c.contact_email && (
                <a href={`mailto:${c.contact_email}`} className="flex items-center gap-1.5 text-xs text-ink-2 hover:text-amber-ink transition-colors">
                  <Icon name="mail" size={12} className="text-ink-3 flex-shrink-0" />
                  <span className="font-mono truncate">{c.contact_email}</span>
                </a>
              )}
              {phone && (
                <a href={`tel:${phone}`} className="flex items-center gap-1.5 text-xs text-ink-2 hover:text-amber-ink transition-colors">
                  <Icon name="phone" size={12} className="text-ink-3 flex-shrink-0" />
                  <span className="tabular-nums">{formatPhone(phone)}</span>
                </a>
              )}
            </div>
          </div>
        </div>
        <div className="mt-3 pt-3 border-t border-hairline">
          <CustomerContactActions customer={c} />
        </div>
      </Card>

      {/* Address */}
      <Card title="Address">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Billing</div>
          {billing.length ? (
            <address className="not-italic text-sm text-ink-2 leading-relaxed">
              {billing.map((line, i) => <div key={i}>{line}</div>)}
            </address>
          ) : <p className="text-sm text-ink-3 italic">No billing address</p>}
        </div>
        <div className="mt-3 pt-3 border-t border-hairline">
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Shipping</div>
          {shipLines.length ? (
            <address className="not-italic text-sm text-ink-2 leading-relaxed">
              {shipLines.map((line, i) => <div key={i}>{line}</div>)}
            </address>
          ) : <p className="text-sm text-ink-3">Same as billing</p>}
        </div>
      </Card>

      {/* Other details — tax + billing facts */}
      <Card title="Other details">
        <dl className="grid grid-cols-2 gap-y-3 gap-x-4">
          <Field label="Customer type" value={c.customer_type === "individual" ? "Individual" : "Business"} />
          <Field label="Currency" value={foreign ? "USD" : "INR"} />
          {!foreign && (
            <Field
              label="GSTIN" value={c.gstin} mono
              badge={c.gstin ? (c.gstin_verified_at ? { kind: "success", text: "verified" } : { kind: "muted", text: "unverified" }) : undefined}
            />
          )}
          <Field label={foreign ? "State / Province" : "Place of supply"} value={c.state} />
          {!foreign && c.tan && <Field label="TAN" value={c.tan} mono />}
          {!foreign && tds && <Field label="TDS" value={tds} />}
          <Field label="Payment terms" value={terms} />
          <Field label="Customer since" value={formatDate(c.since)} />
        </dl>
        {c.notes && (
          <div className="mt-4 pt-3 border-t border-hairline">
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Notes</div>
            <p className="text-sm text-ink-2 whitespace-pre-wrap">{c.notes}</p>
          </div>
        )}
      </Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Small shared primitives
// ──────────────────────────────────────────────────────────────────────
export function MetricCard({ label, value, tone = "default", hint }: {
  label: string; value: string; tone?: "default" | "danger" | "warning" | "success"; hint?: string;
}) {
  const valueColor =
    tone === "danger" ? "text-rose" : tone === "warning" ? "text-amber-ink" : tone === "success" ? "text-emerald" : "text-ink";
  return (
    <div className="bg-paper-2/40 border border-hairline rounded-md px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums mt-1 truncate", valueColor)}>{value}</div>
      {hint && <div className="text-[10px] text-ink-3 mt-0.5 truncate">{hint}</div>}
    </div>
  );
}

export function Field({ label, value, mono, badge }: {
  label: string; value?: string | null; mono?: boolean; badge?: { kind: "success" | "muted"; text: string };
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5">{label}</dt>
      <dd className={cn("text-sm text-ink flex items-center gap-1.5", mono && "font-mono", !value && "italic text-ink-3 font-sans")}>
        <span className="truncate">{value || "—"}</span>
        {value && badge && <Badge kind={badge.kind} size="sm">{badge.text}</Badge>}
      </dd>
    </div>
  );
}

export function PanelEmpty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="py-8 text-center">
      <Icon name={icon} size={22} className="text-ink-3 mx-auto mb-2" />
      <p className="text-sm text-ink-3 max-w-xs mx-auto">{text}</p>
    </div>
  );
}
