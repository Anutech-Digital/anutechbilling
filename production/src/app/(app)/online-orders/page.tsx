/**
 * Online Orders — matches prototype screen "online-orders".
 *
 * Every order the website makes — cart, Workspace checkout / trial / enquiry, hosting
 * trial and the DMS panel — read from public.leads. Which sources count, what to call
 * them and where a trial stands live in lib/online-orders/sources.ts (R-077, 2 Oct 2026:
 * this page used to read only 'buy-workspace%', so cart, hosting-trial and DMS orders
 * never appeared, and it called real rows "sample data").
 */
"use client";

import * as React from "react";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { ORDER_FOCI, ORDER_FOCUS_LABEL, orderInFocus, type OrderFocus } from "@/lib/online-orders/focus";
import { FocusBanner } from "@/components/shared/focus-banner";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { KPI } from "@/components/shared/kpi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { rupee } from "@/lib/utils";
import { WEBSITE_ORDER_FILTER, orderChannel, isTrialOrder, trialWindow } from "@/lib/online-orders/sources";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { invoiceByLead, invoiceHref, type QuoteInvoiceRow } from "./invoice-links";
import { orderDrawerActions, type DrawerAction } from "./drawer-actions";
import { useLeadOutcome } from "@/lib/leads/use-outcome";
import { useCallLog } from "@/components/features/leads/call-log-dialog";
import type { Lead } from "@/lib/supabase/database.types";

// ─── Types ────────────────────────────────────────────────────────────────────

type OrderStatus =
  | "awaiting-payment"
  | "provisioning"
  | "dns-pending"
  | "active"
  | "issue"
  | "trial-active"
  | "trial-converting"
  | "trial-expired";

type ProgressState = "done" | "active" | "pending" | "failed";

interface Order {
  id:          string;
  type:        "paid" | "trial";
  createdAt:   string;
  /** Raw ISO time — for "today" and month-to-date sums (createdAt is display text). */
  createdIso:  string;
  company:     string;
  domain:      string;
  gstin:       string | null;
  contact:     { name: string; email: string; phone: string };
  tier:        string;
  seats:       number;
  billing:     "annual" | "monthly" | null;
  monthlyRate: number;
  lineTotal:   number | null;
  gst:         number | null;
  total:       number | null;
  trialDay:    number | null;
  /** The trial's own length — hosting 15, Workspace 14 — from the lead's dates. */
  trialLength: number | null;
  trialEndsOn: string | null;
  /** True only when the lead is won — a cart order awaiting payment is NOT paid. */
  paid:        boolean;
  razorpayId:  string | null;
  /** R-083: the GST invoice raised for this order's quote (R-079), or null if none yet. */
  invoiceNo:   string | null;
  status:      OrderStatus;
  source:      string;
  progress:    Record<string, ProgressState>;
  amAssigned:  string;
  nextAction:  string;
  /** R-236: the lead row behind the order — the drawer's quote + call-log buttons act on it. */
  lead:        LeadRow;
}


// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_META: Record<OrderStatus, { label: string; kind: "warning" | "info" | "success" | "danger" | "muted"; icon: string }> = {
  "awaiting-payment": { label: "Not paid yet",       kind: "warning", icon: "clock"   },
  "provisioning":     { label: "Provisioning",       kind: "warning", icon: "refresh" },
  "dns-pending":      { label: "DNS pending",         kind: "info",    icon: "clock"   },
  "active":           { label: "Paid",                kind: "success", icon: "check_circle" },
  "issue":            { label: "Issue",               kind: "danger",  icon: "alert"   },
  "trial-active":     { label: "Trial · active",      kind: "info",    icon: "rocket"  },
  "trial-converting": { label: "Trial · converting",  kind: "warning", icon: "refresh" },
  "trial-expired":    { label: "Trial · expired",     kind: "muted",   icon: "x_circle" },
};

const PAID_STEPS = [
  { key: "payment",  label: "Payment",       icon: "rupee"   },
  { key: "invoice",  label: "GST Invoice",   icon: "receipt" },
  { key: "tenant",   label: "Tenant",        icon: "globe"   },
  { key: "users",    label: "Users created", icon: "users"   },
  { key: "dns",      label: "DNS verified",  icon: "shield"  },
  { key: "welcome",  label: "Welcome email", icon: "mail"    },
];

const TRIAL_STEPS = [
  { key: "signup",       label: "Signup",         icon: "check"   },
  { key: "domainVerify", label: "Domain verify",  icon: "globe"   },
  { key: "tenant",       label: "Trial tenant",   icon: "rocket"  },
  { key: "welcome",      label: "Welcome email",  icon: "mail"    },
  { key: "day3CheckIn",  label: "Day 3 check-in", icon: "clock"   },
  { key: "day10Convert", label: "Day 10 convert", icon: "rupee"   },
];

// ─── Progress step ────────────────────────────────────────────────────────────

function ProgressStep({
  icon,
  label,
  state,
}: {
  icon: string;
  label: string;
  state: ProgressState;
}) {
  const cfg: Record<ProgressState, { colorCls: string; bgCls: string; statusLabel: string }> = {
    done:    { colorCls: "text-emerald-600", bgCls: "bg-emerald-50", statusLabel: "Completed"  },
    active:  { colorCls: "text-amber",       bgCls: "bg-amber-50",   statusLabel: "Running…"   },
    pending: { colorCls: "text-ink-3",       bgCls: "bg-paper-2",    statusLabel: "Pending"    },
    failed:  { colorCls: "text-rose-600",    bgCls: "bg-rose-50",    statusLabel: "Failed — needs attention" },
  };
  const c = cfg[state];
  return (
    <div className={cn("flex items-center gap-3 rounded-lg p-2.5", c.bgCls)}>
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper">
        <Icon name={icon} size={14} className={c.colorCls} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className={cn("text-xs font-medium", c.colorCls)}>{c.statusLabel}</p>
      </div>
    </div>
  );
}

// ─── Order detail drawer ──────────────────────────────────────────────────────

function OrderDetailDrawer({
  order,
  onClose,
}: {
  order: Order;
  onClose: () => void;
}) {
  const isPaid = order.type === "paid";
  const steps  = isPaid ? PAID_STEPS : TRIAL_STEPS;
  const s      = STATUS_META[order.status];
  /* R-236: every button does its real job or is not shown — see drawer-actions.ts. */
  const actions = orderDrawerActions({
    type: order.type, status: order.status, trialDay: order.trialDay,
    leadId: order.lead.id, company: order.company, plan: order.lead.plan,
    seats: order.lead.seats, contact: order.contact,
  });
  const runOutcome = useLeadOutcome();
  const callLog = useCallLog(runOutcome);
  const renderAction = (a: DrawerAction) => {
    const variant = a.key === "admin-console" ? "ghost" : a.primary ? "primary" : "default";
    if (a.kind === "call-log") {
      return (
        <Button key={a.key} variant={variant} size="sm" onClick={() => callLog.run("talked", order.lead)}>
          <Icon name={a.icon} size={12} />
          {a.label}
        </Button>
      );
    }
    return (
      <Button key={a.key} variant={variant} size="sm" asChild>
        {a.kind === "link" ? (
          <Link href={a.href as never}>
            <Icon name={a.icon} size={12} />
            {a.label}
          </Link>
        ) : (
          <a
            href={a.href}
            /* tel:/mailto: hand off to the phone or mail app; web links open a new tab. */
            target={a.href?.startsWith("http") ? "_blank" : undefined}
            rel="noopener noreferrer"
          >
            <Icon name={a.icon} size={12} />
            {a.label}
          </a>
        )}
      </Button>
    );
  };

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-[520px] flex flex-col p-0">
        <SheetHeader className="border-b border-hairline px-6 py-4">
          <div className="flex items-center gap-2 mb-0.5">
            <SheetTitle className="font-serif text-lg leading-tight">
              {order.id}
            </SheetTitle>
            <Badge kind={s.kind} dot>{s.label}</Badge>
          </div>
          <p className="text-xs text-ink-3">
            {order.company} · {order.createdAt}
          </p>
        </SheetHeader>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Customer */}
          <DrawerSection title="Customer">
            {[
              { label: "Company",  value: order.company,       mono: false },
              { label: "Domain",   value: order.domain,        mono: true  },
              ...(order.gstin ? [{ label: "GSTIN", value: order.gstin, mono: true }] : []),
              { label: "Contact",  value: order.contact.name,  mono: false },
              { label: "Email",    value: order.contact.email, mono: true  },
              { label: "Phone",    value: order.contact.phone, mono: true  },
            ].map((r) => (
              <DrawerRow key={r.label} label={r.label} mono={r.mono}>
                {r.value}
              </DrawerRow>
            ))}
          </DrawerSection>

          {/* Order / Trial */}
          <DrawerSection title={isPaid ? "Order" : "Trial"}>
            <DrawerRow label="Plan">{order.tier}</DrawerRow>
            <DrawerRow label="Seats">{order.seats}</DrawerRow>
            {isPaid ? (
              <>
                <DrawerRow label="Billing">
                  {order.billing === "annual" ? "Annual" : "Monthly"}
                </DrawerRow>
                <DrawerRow label="Rate/seat">{rupee(order.monthlyRate)}/month</DrawerRow>
                <DrawerRow label="Line total">{rupee(order.lineTotal)}</DrawerRow>
                <DrawerRow label="GST (18%)">{rupee(order.gst)}</DrawerRow>
                <DrawerRow label="Total">
                  <span className="font-semibold text-amber">{rupee(order.total)}</span>
                </DrawerRow>
                <DrawerRow label="Razorpay ID" mono>{order.razorpayId}</DrawerRow>
                <DrawerRow label="Invoice" mono>
                  {order.invoiceNo ? (
                    <Link href={invoiceHref(order.invoiceNo) as never} className="text-indigo-ink hover:underline" title="Open GST invoice">
                      {order.invoiceNo}
                    </Link>
                  ) : (
                    <span className="font-sans text-ink-3">{order.paid ? "Not issued yet" : "After payment"}</span>
                  )}
                </DrawerRow>
              </>
            ) : (
              <>
                <DrawerRow label="Day">
                  <strong>Day {order.trialDay} of {order.trialLength}</strong>
                </DrawerRow>
                <DrawerRow label="Expires">{order.trialEndsOn}</DrawerRow>
              </>
            )}
            <DrawerRow label="Source">{order.source}</DrawerRow>
            <DrawerRow label="Assigned to">{order.amAssigned}</DrawerRow>
          </DrawerSection>

          {/* Automation progress */}
          <DrawerSection title="Automation progress">
            <div className="space-y-2">
              {steps.map((step) => (
                <ProgressStep
                  key={step.key}
                  icon={step.icon}
                  label={step.label}
                  state={(order.progress[step.key] as ProgressState) ?? "pending"}
                />
              ))}
            </div>
          </DrawerSection>

          {/* Next action */}
          <DrawerSection title="Next action">
            <div
              className={cn(
                "flex gap-2.5 rounded-lg border p-3 text-sm text-ink",
                order.status === "issue"
                  ? "border-rose-200 bg-rose-50"
                  : "border-amber-200 bg-amber-50",
              )}
            >
              <Icon
                name={order.status === "issue" ? "alert" : "info"}
                size={14}
                className={cn(
                  "mt-0.5 shrink-0",
                  order.status === "issue" ? "text-rose-600" : "text-amber",
                )}
              />
              <p>{order.nextAction}</p>
            </div>
          </DrawerSection>
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap gap-2 border-t border-hairline bg-paper-2 px-6 py-3">
          {actions.filter((a) => a.key !== "admin-console").map(renderAction)}
          {/* R-083: opens the order's real GST invoice (it used to toast "Downloading…"). */}
          {isPaid && order.invoiceNo && (
            <Button variant="default" size="sm" asChild>
              <Link href={invoiceHref(order.invoiceNo) as never}>
                <Icon name="receipt" size={12} />
                Invoice
              </Link>
            </Button>
          )}
          <div className="flex-1" />
          {actions.filter((a) => a.key === "admin-console").map(renderAction)}
        </div>
        {callLog.dialog}
      </SheetContent>
    </Sheet>
  );
}

// Small drawer helpers
function DrawerSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="mb-2 text-3xs font-bold uppercase tracking-widest text-ink-3">
        {title}
      </p>
      {children}
    </div>
  );
}

function DrawerRow({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="grid items-center gap-3 border-b border-hairline/50 py-1.5 text-sm last:border-0"
      style={{ gridTemplateColumns: "120px 1fr" }}
    >
      <span className="text-ink-3">{label}</span>
      <span className={cn("min-w-0 break-words text-ink", mono && "break-all font-mono text-xs")}>{children}</span>
    </div>
  );
}

// ─── Tabs config ──────────────────────────────────────────────────────────────

// ─── Page ─────────────────────────────────────────────────────────────────────

// ─── DB → UI mapping ─────────────────────────────────────────────────────────
// Map a website-order row from public.leads (sources: lib/online-orders/sources.ts) into the
// Order shape the UI expects (invoice no comes from the order's quote — R-083). Some UI fields (Razorpay ID, granular
// progress) aren't populated yet — set to sensible defaults so the row still
// renders. Once payments + provisioning land, we backfill from quotes/payments.

interface LeadRow {
  id:            string;
  company:       string;
  contact_name:  string | null;
  contact_email: string | null;
  contact_phone: string | null;
  plan:          string | null;
  seats:         number | null;
  value:         number | null;
  stage:         Lead["stage"];
  source:        string | null;
  notes:         string | null;
  created_at:    string;
  follow_up_date:   string | null;
  domain:           string | null;
  utm_source:       string | null;
  trial_started_at: string | null;
  trial_expires_at: string | null;
  owner:            { full_name: string | null } | null;
}

/** Derive a friendly tier name from the lead.plan label. */
function tierFromPlan(plan: string | null): string {
  if (!plan) return "Custom";
  if (/starter/i.test(plan))    return "Business Starter";
  if (/standard/i.test(plan))   return "Business Standard";
  if (/plus/i.test(plan))       return "Business Plus";
  if (/enterprise/i.test(plan)) return "Enterprise";
  return plan;
}

/** Pull the trial domain out of the lead.notes (we wrote it there in the API). */
function domainFromNotes(notes: string | null, email: string | null): string {
  if (notes) {
    const m = notes.match(/Domain:\s*([\w.-]+)/i);
    if (m) return m[1];
  }
  if (email) {
    const at = email.indexOf("@");
    if (at > 0) return email.slice(at + 1);
  }
  return "—";
}

/** Status badge derived from lead stage + source. */
function statusFromLead(l: LeadRow): OrderStatus {
  if (isTrialOrder(l)) {
    const w = trialWindow(l);
    return w.state === "expired" ? "trial-expired" : w.state === "converting" ? "trial-converting" : "trial-active";
  }
  if (l.stage === "lost")  return "issue";
  if (l.stage === "won")   return "active";
  /* R-077: a cart order sits at stage 'quote' until Razorpay confirms — it was shown as
     "DNS pending" (and anything else as "Provisioning"), which nothing measured. */
  return "awaiting-payment";
}

/** Day number within trial (1-14), or null for paid orders. */
function trialDay(l: LeadRow): number | null {
  return isTrialOrder(l) ? trialWindow(l).day : null;
}

/** Convert ISO timestamp → "20 May · 09:42 AM" for display. */
function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const time = d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  return `${day} · ${time}`;
}

/** Reasonable "next action" string based on stage + age. */
function nextActionFromLead(l: LeadRow): string {
  if (isTrialOrder(l)) {
    const w = trialWindow(l);
    if (w.state === "expired")    return `Trial ended ${w.endsOn.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} · convert or close`;
    if (w.state === "converting") return `Day ${w.day} of ${w.length} · time to send convert quote`;
    if (w.day >= 7)               return `Day ${w.day} of ${w.length} · scheduled health-check`;
    return `Day ${w.day} of ${w.length} · onboarding in progress`;
  }
  switch (l.stage) {
    case "new":      return "New lead · qualify and call within 30 min";
    case "contact":  return "Contacted · waiting for response";
    case "quote":    return "Quote sent · awaiting acceptance";
    case "won":      return "Paid · provisioning in progress";
    case "lost":     return "Lost — review reason in notes";
    default:         return "Review lead";
  }
}

function leadToOrder(l: LeadRow, invoiceId: string | null = null): Order {
  const isTrial = isTrialOrder(l);
  const win     = isTrial ? trialWindow(l) : null;
  const tier    = tierFromPlan(l.plan);
  const seats   = l.seats ?? 0;
  const lineTotal = isTrial ? null : (l.value ?? null);
  const gst       = lineTotal ? Math.round(lineTotal * 0.18) : null;
  const total     = lineTotal && gst ? lineTotal + gst : null;
  const day       = trialDay(l);

  return {
    id:          "ORD-" + l.id.replace(/^L-/, ""),
    type:        isTrial ? "trial" : "paid",
    createdAt:   formatCreatedAt(l.created_at),
    createdIso:  l.created_at,
    company:     l.company || "—",
    domain:      l.domain || domainFromNotes(l.notes, l.contact_email),
    gstin:       null,
    contact:     {
      name:  l.contact_name  ?? "—",
      email: l.contact_email ?? "—",
      phone: l.contact_phone ?? "—",
    },
    tier,
    seats,
    billing:     "annual",
    monthlyRate: lineTotal && seats ? Math.round(lineTotal / seats / 12) : 0,
    lineTotal,
    gst,
    total,
    trialDay:    day,
    trialLength: win?.length ?? null,
    trialEndsOn: win ? win.endsOn.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : null,
    paid:        l.stage === "won",
    razorpayId:  null,    // future: from payments table
    invoiceNo:   invoiceId,
    status:      statusFromLead(l),
    source:      orderChannel(l.source, l.utm_source),
    progress:    isTrial
      ? { trial: "done", onboarding: "active", checkin: "pending", convert: "pending" }
      : { payment: "pending", invoice: "pending", tenant: "pending", users: "pending", dns: "pending", welcome: "pending" },
    /* Was the literal "Pardeep A" on every row. The lead's real owner, or says so. */
    amAssigned:  l.owner?.full_name?.trim() || "Unassigned",
    nextAction:  nextActionFromLead(l),
    lead:        l,
  };
}

export default function OnlineOrdersPage() {
  const [tab, setTab]       = React.useState("all");
  /* R-118: each KPI's own orders (lib/online-orders/focus.ts) — "" = none. */
  const [focus, setFocus]   = useUrlChoice<OrderFocus>("focus", ORDER_FOCI, "");
  const focusOn = (f: OrderFocus) => { setTab("all"); setFocus(f); };
  const [search, setSearch] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);
  const [orders, setOrders]   = React.useState<Order[]>([]);
  const [loading, setLoading] = React.useState(true);
  // Honest failure surface: without this a failed fetch silently left orders=[]
  // and rendered "No orders yet" — a real load error masquerading as an empty
  // buy-flow. Track the error + expose a retry instead.
  const [loadError, setLoadError] = React.useState(false);

  // Fetch real leads with source from the buy page (paid enquiries + trials).
  // RLS scopes by tenant automatically; no need to pass tenant_id here.
  const load = React.useCallback(async (signal?: { cancelled: boolean }) => {
    setLoading(true);
    setLoadError(false);
    const supabase = createClient();
    const { data, error } = await supabase
      .from("leads")
      .select("id, company, contact_name, contact_email, contact_phone, plan, seats, value, stage, source, notes, created_at, follow_up_date, domain, utm_source, trial_started_at, trial_expires_at, owner:users!leads_owner_id_fkey(full_name)")
      .or(WEBSITE_ORDER_FILTER)
      .order("created_at", { ascending: false })
      .limit(100);

    if (signal?.cancelled) return;
    if (error) {
      console.error("[online-orders] fetch failed:", error);
      setLoadError(true);
      setLoading(false);
      return;
    }
    const leads = (data ?? []) as unknown as LeadRow[];

    /* R-083: the invoice R-079 issues on payment sits on the order's quote
       (quotes.lead_id -> quotes.invoice_id). A failure here only hides the links —
       the orders themselves still show. */
    let invoices = new Map<string, string>();
    const leadIds = leads.map((l) => l.id);
    if (leadIds.length) {
      const { data: qRows, error: qErr } = await supabase
        .from("quotes")
        .select("lead_id, invoice_id, created_at")
        .in("lead_id", leadIds)
        .not("invoice_id", "is", null);
      if (signal?.cancelled) return;
      if (qErr) console.error("[online-orders] invoice lookup failed:", qErr);
      else invoices = invoiceByLead((qRows ?? []) as QuoteInvoiceRow[]);
    }

    // Real orders only — no demo/seed data. An empty buy-flow correctly shows
    // an empty state, never fabricated revenue.
    setOrders(leads.map((l) => leadToOrder(l, invoices.get(l.id) ?? null)));
    setLoading(false);
  }, []);

  React.useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => { signal.cancelled = true; };
  }, [load]);

  const openOrder = orders.find((o) => o.id === openId) ?? null;

  // Filtered list
  const filtered = orders.filter((o) => {
    if (tab === "paid"   && !o.paid)              return false;
    if (tab === "trial"  && o.type !== "trial")   return false;
    if (tab === "issues" && o.status !== "issue") return false;
    if (focus && !orderInFocus(o, focus)) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !o.company.toLowerCase().includes(q) &&
        !o.id.toLowerCase().includes(q) &&
        !o.contact.email.toLowerCase().includes(q) &&
        !o.domain.toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  // KPI stats — all derived from the live `orders` state (real DB rows
  // merged with the seed demo data at top of the file).
  const today      = orders.filter((o) => orderInFocus(o, "today")).length;
  const provis     = orders.filter((o) => orderInFocus(o, "provisioning")).length;
  const issues     = orders.filter((o) => orderInFocus(o, "issue")).length;
  const trialEx    = orders.filter((o) => orderInFocus(o, "converting")).length;
  /* Only money actually received — a cart order awaiting payment is not revenue. */
  const awaiting   = orders.filter((o) => o.status === "awaiting-payment");
  const converting = orders.filter((o) => o.status === "trial-converting");
  const revenueMtd = orders.filter((o) => orderInFocus(o, "revenue-month")).reduce(
    (s, o) => s + (o.total ?? 0),
    0,
  );

  const tabItems: TabBarItem[] = [
    { id: "all",    label: `All · ${orders.length}` },
    { id: "paid",   label: `Paid · ${orders.filter((o) => o.paid).length}` },
    { id: "trial",  label: `Trials · ${orders.filter((o) => o.type === "trial").length}` },
    { id: "issues", label: `Issues · ${issues}` },
  ];

  return (
    <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
      {/* ── Page header ── */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl text-ink">Online Orders</h1>
          <p className="mt-1 text-sm text-ink-3">
            Incoming orders from your online store · Paid + Trial
          </p>
          {/* What every buyer ticked at checkout, so staff answering a refund or terms
              question read the same text the customer agreed to (30 Sep 2026). */}
          <p className="mt-1 text-xs text-ink-3">
            Buyers agree to the{" "}
            <a href="/terms-and-conditions" target="_blank" rel="noopener" className="text-amber font-medium hover:underline">terms and conditions</a>
            {" "}and the{" "}
            <a href="/refund" target="_blank" rel="noopener" className="text-amber font-medium hover:underline">refund policy</a>
            {" "}at checkout.
          </p>
        </div>
      </div>

      {/* ── Gemini AI ── */}
      <div className="mb-6">
        {/* R-077: built from the orders on this page. It used to name "Hotel Asia",
            "Cosmo Tech" and "Beta Industries" — companies that were never orders. */}
        <GeminiCard
          title="Orders · Today's focus"
          compact
          actions={
            (awaiting[0] || converting[0] || orders.find((o) => o.status === "issue")) ? (
              <div className="flex flex-wrap gap-2">
                {orders.find((o) => o.status === "issue") && (
                  <Button variant="primary" size="sm" onClick={() => setOpenId(orders.find((o) => o.status === "issue")!.id)}>
                    <Icon name="alert" size={12} />
                    Open {orders.find((o) => o.status === "issue")!.company}
                  </Button>
                )}
                {converting[0] && (
                  <Button variant="default" size="sm" onClick={() => setOpenId(converting[0].id)}>
                    <Icon name="phone" size={12} />
                    Convert {converting[0].company}
                  </Button>
                )}
                {awaiting[0] && (
                  <Button variant="default" size="sm" onClick={() => setOpenId(awaiting[0].id)}>
                    <Icon name="clock" size={12} />
                    Follow up {awaiting[0].company}
                  </Button>
                )}
              </div>
            ) : undefined
          }
        >
          {issues + converting.length + awaiting.length === 0 ? (
            <span>Nothing needs you right now.</span>
          ) : (
            <span>
              <strong className="text-ink">
                {issues} issue{issues === 1 ? "" : "s"} · {converting.length} trial{converting.length === 1 ? "" : "s"} ending in 3 days · {awaiting.length} not paid yet.
              </strong>
            </span>
          )}
        </GeminiCard>
      </div>

      {/* ── KPIs ── */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <KPI
          label="New today"
          value={today}
          trend="Since midnight"
          trendKind="neutral"
          icon="inbox"
          onClick={() => focusOn("today")}
        />
        <KPI
          label="Provisioning"
          value={provis}
          trend="Paid, being set up"
          trendKind="neutral"
          icon="refresh"
          onClick={() => focusOn("provisioning")}
        />
        <KPI
          label="Issues"
          value={issues}
          trend={issues > 0 ? "Needs attention" : "None"}
          trendKind={issues > 0 ? "down" : "neutral"}
          icon="alert"
          onClick={() => focusOn("issue")}
        />
        <KPI
          label="Trials expiring"
          value={trialEx}
          trend="Trial ending, converting to paid"
          trendKind="neutral"
          icon="clock"
          onClick={() => focusOn("converting")}
        />
        <KPI
          label="Revenue MTD"
          value={rupee(revenueMtd, { compact: true })}
          trend="Paid this month"
          trendKind="neutral"
          icon="rupee"
          onClick={() => focusOn("revenue-month")}
        />
      </div>

      {/* ── Table ── */}
      <Card className="overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-5 py-3">
          {focus && (
            <FocusBanner label={ORDER_FOCUS_LABEL[focus]} count={filtered.length} onClear={() => setFocus("")} />
          )}
          <TabBar
            items={tabItems}
            value={tab}
            onChange={(t) => { setFocus(""); setTab(t); }}
          />
          <div className="flex-1" />
          <div className="relative w-72">
            <Icon
              name="search"
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
            />
            <Input
              aria-label="Search orders"
              placeholder="Search company / email / order ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 text-xs"
            />
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="space-y-2 p-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : loadError ? (
          <EmptyState
            icon="alert"
            title="Couldn't load your orders"
            body="Something went wrong fetching orders from the buy flow. This is a load error, not an empty inbox — check your connection and try again."
            action={<Button variant="primary" icon="refresh" onClick={() => void load()}>Retry</Button>}
            compact
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon="inbox"
            title={
              search
                ? "No orders match your search"
                : tab === "issues"
                  ? "No issues — all clear!"
                  : "No orders yet"
            }
            body={
              search
                ? `Try a different search term or clear filters.`
                : tab === "issues"
                  ? "Every order is provisioning smoothly."
                  : "Orders from your website — cart, trials, DMS — appear here as they come in."
            }
            action={
              search ? (
                <Button variant="default" onClick={() => setSearch("")}>
                  <Icon name="x" size={13} />
                  Clear search
                </Button>
              ) : undefined
            }
            compact
          />
        ) : (
          <>
          {/* Mobile card list — phones only */}
          <ul className="md:hidden space-y-2 p-3">
            {filtered.map((o) => {
              const s = STATUS_META[o.status];
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(o.id)}
                    className="block w-full text-left bg-paper border border-hairline rounded-lg p-3 active:bg-paper-2/50"
                  >
                    <div className="flex items-start justify-between gap-3 mb-1.5">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-xs font-semibold text-ink">{o.id}</p>
                        <p className="text-sm font-medium text-ink mt-0.5 truncate">{o.company}</p>
                        <p className="font-mono text-2xs text-ink-3 truncate">{o.domain}</p>
                      </div>
                      <div className="text-right shrink-0">
                        {o.total ? (
                          <>
                            <p className="font-serif text-base tabular-nums text-ink">{rupee(o.total)}</p>
                            <p className="text-3xs text-ink-3">{o.seats} seats</p>
                          </>
                        ) : (
                          <Badge kind="warning" size="sm">Trial</Badge>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-ink-2 truncate mb-2">{o.tier}</p>
                    <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60">
                      <Badge kind={s.kind} size="sm" dot>{s.label}</Badge>
                      <span className="text-2xs text-ink-3 truncate max-w-[60%] text-right">
                        {o.nextAction}
                      </span>
                    </div>
                  </button>
                  {o.invoiceNo && (
                    <Link
                      href={invoiceHref(o.invoiceNo) as never}
                      className="mt-1 inline-flex items-center gap-1 px-1 font-mono text-2xs text-indigo-ink hover:underline"
                      title="Open GST invoice"
                    >
                      <Icon name="receipt" size={11} />
                      {o.invoiceNo}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline bg-muted/30">
                  {[
                    "Order", "Company", "Type", "Plan", "Seats",
                    "Amount", "Status", "Next action", "",
                  ].map((h, i) => (
                    <th
                      key={i}
                      className={cn(
                        "px-4 py-2.5 text-xs font-medium text-ink-3",
                        (i === 4 || i === 5) ? "text-right" : "text-left",
                      )}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const s = STATUS_META[o.status];
                  return (
                    <tr
                      key={o.id}
                      className="cursor-pointer border-b border-hairline last:border-0 hover:bg-muted/20"
                      onClick={() => setOpenId(o.id)}
                    >
                      {/* Order ID */}
                      <td className="px-4 py-3">
                        <p className="font-mono text-xs font-semibold text-ink">
                          {o.id}
                        </p>
                        <p className="text-2xs text-ink-3">{o.createdAt}</p>
                      </td>

                      {/* Company */}
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink">{o.company}</p>
                        <p className="text-xs text-ink-3">{o.contact.email}</p>
                      </td>

                      {/* Type */}
                      <td className="px-4 py-3">
                        {o.type === "paid" ? (
                          o.paid ? <Badge kind="success" dot>Paid</Badge> : <Badge kind="warning" dot>Awaiting payment</Badge>
                        ) : (
                          <Badge kind="info" dot>
                            Trial · D{o.trialDay}
                          </Badge>
                        )}
                        {/* R-083: the order's GST invoice, one click away. */}
                        {o.invoiceNo && (
                          <Link
                            href={invoiceHref(o.invoiceNo) as never}
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1 block font-mono text-3xs text-indigo-ink hover:underline"
                            title="Open GST invoice"
                          >
                            {o.invoiceNo}
                          </Link>
                        )}
                      </td>

                      {/* Plan */}
                      <td className="px-4 py-3">
                        <p className="text-xs text-ink">{o.tier}</p>
                        <p className="text-2xs text-ink-3">
                          {o.billing === "annual"
                            ? "Annual"
                            : o.billing === "monthly"
                              ? "Monthly"
                              : `${o.trialLength ?? 14}-day trial`}
                        </p>
                      </td>

                      {/* Seats */}
                      <td className="px-4 py-3 text-right tabular-nums text-ink">
                        {o.seats}
                      </td>

                      {/* Amount */}
                      <td className="px-4 py-3 text-right tabular-nums">
                        {o.total != null ? (
                          <span className="font-medium text-ink">
                            {rupee(o.total)}
                          </span>
                        ) : (
                          <span className="italic text-ink-3">Trial</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-4 py-3">
                        <Badge kind={s.kind} dot>{s.label}</Badge>
                      </td>

                      {/* Next action */}
                      <td className="max-w-[200px] px-4 py-3 text-xs text-ink-3">
                        <p className="line-clamp-2">{o.nextAction}</p>
                      </td>

                      {/* Open */}
                      <td
                        className="px-4 py-3"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setOpenId(o.id)}
                        >
                          <Icon name="arrow_right" size={13} />
                          Open
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>

      {/* ── Detail drawer ── */}
      {openOrder && (
        <OrderDetailDrawer
          order={openOrder}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
}
