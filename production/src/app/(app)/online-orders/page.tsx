/**
 * Online Orders — matches prototype screen "online-orders".
 *
 * Admin view for incoming orders from the buy-workspace-v2 page (paid + trial).
 * Shows real-time provisioning pipeline: new → provisioning → DNS pending → active.
 *
 * NOTE: Order data is currently mock/demo. When buy-workspace-v2 is live,
 * replace ONLINE_ORDERS with a Supabase query on an `orders` table.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
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
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

// ─── Types ────────────────────────────────────────────────────────────────────

type OrderStatus =
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
  trialEndsOn: string | null;
  razorpayId:  string | null;
  invoiceNo:   string | null;
  status:      OrderStatus;
  source:      string;
  progress:    Record<string, ProgressState>;
  amAssigned:  string;
  nextAction:  string;
}


// ─── Status config ────────────────────────────────────────────────────────────

const STATUS_META: Record<OrderStatus, { label: string; kind: "warning" | "info" | "success" | "danger" | "muted"; icon: string }> = {
  "provisioning":     { label: "Provisioning",       kind: "warning", icon: "refresh" },
  "dns-pending":      { label: "DNS pending",         kind: "info",    icon: "clock"   },
  "active":           { label: "Active",              kind: "success", icon: "check_circle" },
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

  return (
    <Sheet open onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-[520px] flex flex-col p-0">
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
                <DrawerRow label="Invoice" mono>{order.invoiceNo}</DrawerRow>
              </>
            ) : (
              <>
                <DrawerRow label="Day">
                  <strong>Day {order.trialDay} of 14</strong>
                </DrawerRow>
                <DrawerRow label="Expires">{order.trialEndsOn}</DrawerRow>
              </>
            )}
            <DrawerRow label="Source" mono>{order.source}</DrawerRow>
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
          {isPaid && order.status === "provisioning" && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => toast.info("Re-running provisioning…")}
            >
              <Icon name="refresh" size={12} />
              Retry provisioning
            </Button>
          )}
          {isPaid && order.status === "dns-pending" && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => toast.success("DNS guide re-sent")}
            >
              <Icon name="mail" size={12} />
              Re-send DNS guide
            </Button>
          )}
          {isPaid && order.status === "issue" && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => toast.info("Escalating to Google support…")}
            >
              <Icon name="alert" size={12} />
              Escalate to Google
            </Button>
          )}
          {!isPaid &&
            order.status === "trial-active" &&
            (order.trialDay ?? 0) >= 7 && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => toast.success("Conversion quote sent")}
              >
                <Icon name="rupee" size={12} />
                Send convert quote
              </Button>
            )}
          {!isPaid &&
            order.status === "trial-active" &&
            (order.trialDay ?? 0) < 7 && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => toast.success("Call logged")}
              >
                <Icon name="phone" size={12} />
                Log AM call
              </Button>
            )}
          {!isPaid && order.status === "trial-expired" && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => toast.success("Winback email queued")}
            >
              <Icon name="mail" size={12} />
              Send winback
            </Button>
          )}

          <Button
            variant="default"
            size="sm"
            onClick={() => toast.info(`WhatsApp: ${order.contact.name}`)}
          >
            <Icon name="whatsapp" size={12} />
            WhatsApp
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => toast.info(`Calling ${order.contact.phone}`)}
          >
            <Icon name="phone" size={12} />
            Call
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => toast.info(`Email: ${order.contact.email}`)}
          >
            <Icon name="mail" size={12} />
            Email
          </Button>
          {isPaid && (
            <Button
              variant="default"
              size="sm"
              onClick={() => toast.info("Downloading invoice PDF…")}
            >
              <Icon name="download" size={12} />
              Invoice
            </Button>
          )}
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toast.info("Opening Google Admin Console")}
          >
            <Icon name="external" size={12} />
            Admin console
          </Button>
        </div>
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
      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-ink-3">
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
      <span className={cn("text-ink", mono && "font-mono text-xs")}>{children}</span>
    </div>
  );
}

// ─── Tabs config ──────────────────────────────────────────────────────────────

// ─── Page ─────────────────────────────────────────────────────────────────────

// ─── DB → UI mapping ─────────────────────────────────────────────────────────
// Map a row from public.leads (where source LIKE 'buy-workspace%') into the
// Order shape the UI expects. Many UI fields (Razorpay ID, invoice no, granular
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
  stage:         string;
  source:        string | null;
  notes:         string | null;
  created_at:    string;
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
  const isTrial = (l.source ?? "").includes("trial") || l.stage === "trial";
  if (isTrial) {
    // Day count for trial: rough age in days since creation
    const ageDays = Math.floor(
      (Date.now() - new Date(l.created_at).getTime()) / 86_400_000,
    );
    if (ageDays >= 14) return "trial-expired";
    if (ageDays >= 11) return "trial-converting";
    return "trial-active";
  }
  if (l.stage === "lost")  return "issue";
  if (l.stage === "won")   return "active";
  if (l.stage === "quote") return "dns-pending";
  return "provisioning";
}

/** Day number within trial (1-14), or null for paid orders. */
function trialDay(l: LeadRow): number | null {
  const isTrial = (l.source ?? "").includes("trial") || l.stage === "trial";
  if (!isTrial) return null;
  const age = Math.floor((Date.now() - new Date(l.created_at).getTime()) / 86_400_000);
  return Math.max(1, Math.min(14, age + 1));
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
  const isTrial = (l.source ?? "").includes("trial") || l.stage === "trial";
  if (isTrial) {
    const day = trialDay(l) ?? 1;
    if (day >= 12) return `Day ${day} · time to send convert quote`;
    if (day >= 7)  return `Day ${day} · scheduled health-check`;
    return `Day ${day} · onboarding in progress`;
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

function leadToOrder(l: LeadRow): Order {
  const isTrial = (l.source ?? "").includes("trial") || l.stage === "trial";
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
    company:     l.company || "—",
    domain:      domainFromNotes(l.notes, l.contact_email),
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
    trialEndsOn: isTrial
      ? new Date(new Date(l.created_at).getTime() + 14 * 86_400_000)
          .toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
      : null,
    razorpayId:  null,    // future: from payments table
    invoiceNo:   null,    // future: from invoices table
    status:      statusFromLead(l),
    source:      l.source ?? "buy-workspace",
    progress:    isTrial
      ? { trial: "done", onboarding: "active", checkin: "pending", convert: "pending" }
      : { payment: "pending", invoice: "pending", tenant: "pending", users: "pending", dns: "pending", welcome: "pending" },
    amAssigned:  "Pardeep A",
    nextAction:  nextActionFromLead(l),
  };
}

export default function OnlineOrdersPage() {
  const [tab, setTab]       = React.useState("all");
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
      .select("id, company, contact_name, contact_email, contact_phone, plan, seats, value, stage, source, notes, created_at")
      .ilike("source", "buy-workspace%")
      .order("created_at", { ascending: false })
      .limit(100);

    if (signal?.cancelled) return;
    if (error) {
      console.error("[online-orders] fetch failed:", error);
      setLoadError(true);
      setLoading(false);
      return;
    }
    // Real orders only — no demo/seed data. An empty buy-flow correctly shows
    // an empty state, never fabricated revenue.
    setOrders((data ?? []).map((r) => leadToOrder(r as LeadRow)));
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
    if (tab === "paid"   && o.type !== "paid")    return false;
    if (tab === "trial"  && o.type !== "trial")   return false;
    if (tab === "issues" && o.status !== "issue") return false;
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
  const todayStr   = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const today      = orders.filter((o) => o.createdAt.includes(todayStr)).length;
  const provis     = orders.filter((o) => o.status === "provisioning").length;
  const issues     = orders.filter((o) => o.status === "issue").length;
  const trialEx    = orders.filter(
    (o) => o.type === "trial" && (o.trialDay ?? 0) >= 11 && o.status === "trial-active",
  ).length;
  const revenueMtd = orders.filter((o) => o.type === "paid").reduce(
    (s, o) => s + (o.total ?? 0),
    0,
  );

  const tabItems: TabBarItem[] = [
    { id: "all",    label: `All · ${orders.length}` },
    { id: "paid",   label: `Paid · ${orders.filter((o) => o.type === "paid").length}` },
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
        </div>
      </div>

      {/* Honest disclosure: this screen is a PREVIEW of the online-store order
          pipeline. The rows below are sample data — real orders appear here once
          the buy page (buy-workspace-v2) is live. Better to say so than to let a
          non-technical owner mistake demo rows for real money. */}
      <div className="mb-6 rounded-md border border-amber/30 bg-amber-soft px-4 py-3 text-sm text-amber-ink flex items-start gap-2">
        <Icon name="info" size={16} className="mt-0.5 shrink-0" />
        <span>
          <strong>Preview — sample data.</strong> This is a preview of your online-store
          order pipeline. Real orders will appear here once your online buy page is live.
          The rows below are demo data only.
        </span>
      </div>

      {/* ── Gemini AI ── */}
      <div className="mb-6">
        <GeminiCard
          title="Orders AI · Today's focus"
          compact
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => toast.info("Escalating Hotel Asia issue to Google support")}
              >
                <Icon name="alert" size={12} />
                Fix Hotel Asia issue
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={() => toast.info("Calling Beta Industries — new trial")}
              >
                <Icon name="phone" size={12} />
                Welcome call to Beta
              </Button>
            </div>
          }
        >
          <strong className="text-ink">
            {issues} blocker · {trialEx} conversion opportunity.
          </strong>{" "}
          Hotel Asia provisioning is stuck (domain conflict) — fix to unblock ₹4.9L revenue. Cosmo Tech is on Day 11 of trial with high engagement — perfect time to send convert quote. Beta Industries just signed up — first call within 2 hours is your conversion edge.
        </GeminiCard>
      </div>

      {/* ── KPIs ── */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <KPI
          label="New today"
          value={today}
          trend="+3 vs yesterday"
          trendKind="up"
          icon="inbox"
        />
        <KPI
          label="Provisioning"
          value={provis}
          trend="ETA 3–8 min"
          trendKind="neutral"
          icon="refresh"
        />
        <KPI
          label="Issues"
          value={issues}
          trend={issues > 0 ? "Needs attention" : "All clear"}
          trendKind={issues > 0 ? "down" : "up"}
          icon="alert"
        />
        <KPI
          label="Trials expiring"
          value={trialEx}
          trend="In next 3 days"
          trendKind="neutral"
          icon="clock"
        />
        <KPI
          label="Revenue MTD"
          value={rupee(revenueMtd, { compact: true })}
          trend="From online channel"
          trendKind="up"
          icon="rupee"
        />
      </div>

      {/* ── Table ── */}
      <Card className="overflow-hidden">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-hairline px-5 py-3">
          <TabBar
            items={tabItems}
            value={tab}
            onChange={setTab}
          />
          <div className="flex-1" />
          <div className="relative w-72">
            <Icon
              name="search"
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none"
            />
            <Input
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
                  : "Orders from buy-workspace-v2 will appear here in real time."
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
                        <p className="font-mono text-[11px] text-ink-3 truncate">{o.domain}</p>
                      </div>
                      <div className="text-right shrink-0">
                        {o.total ? (
                          <>
                            <p className="font-serif text-base tabular-nums text-ink">{rupee(o.total)}</p>
                            <p className="text-[10px] text-ink-3">{o.seats} seats</p>
                          </>
                        ) : (
                          <Badge kind="warning" size="sm">Trial</Badge>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-ink-2 truncate mb-2">{o.tier}</p>
                    <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60">
                      <Badge kind={s.kind} size="sm" dot>{s.label}</Badge>
                      <span className="text-[11px] text-ink-3 truncate max-w-[60%] text-right">
                        {o.nextAction}
                      </span>
                    </div>
                  </button>
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
                        <p className="text-[11px] text-ink-3">{o.createdAt}</p>
                      </td>

                      {/* Company */}
                      <td className="px-4 py-3">
                        <p className="font-medium text-ink">{o.company}</p>
                        <p className="text-xs text-ink-3">{o.contact.email}</p>
                      </td>

                      {/* Type */}
                      <td className="px-4 py-3">
                        {o.type === "paid" ? (
                          <Badge kind="success" dot>Paid</Badge>
                        ) : (
                          <Badge kind="info" dot>
                            Trial · D{o.trialDay}
                          </Badge>
                        )}
                      </td>

                      {/* Plan */}
                      <td className="px-4 py-3">
                        <p className="text-xs text-ink">{o.tier}</p>
                        <p className="text-[11px] text-ink-3">
                          {o.billing === "annual"
                            ? "Annual"
                            : o.billing === "monthly"
                              ? "Monthly"
                              : "14-day trial"}
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
