/**
 * Marketing Hub queries — tool state, tracking links, email opt-outs.
 * Tables from migration 20260926190000_marketing_hub.sql; the tool catalogue and the link
 * builder are pure (lib/marketing/tool-catalog.ts, tracking-link.ts).
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { requireTenantId } from "@/lib/queries/require-tenant";
import { isMarketingCategory } from "@/lib/marketing/ad-channels";
import type { ToolState, ToolStatus } from "@/lib/marketing/tool-catalog";

/* S21: marketing_tools / tracking_links / email_suppressions ab generated types me hain — typed client. */
const db = () => createClient();

const TOOLS_KEY = ["marketing-tools"] as const;
const LINKS_KEY = ["tracking-links"] as const;
const SUPPRESS_KEY = ["email-suppressions"] as const;

// ── Tools ────────────────────────────────────────────────────────────────────

export function useMarketingTools() {
  return useQuery({
    queryKey: TOOLS_KEY,
    queryFn: async (): Promise<ToolState[]> => {
      const { data, error } = await db().from("marketing_tools")
        .select("tool_key, status, account_url, owner_name, monthly_budget, notes");
      if (error) throw error;
      return (data ?? []) as ToolState[];
    },
  });
}

export function useSaveMarketingTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      tool_key: string; name: string; status: ToolStatus;
      account_url: string | null; owner_name: string | null; monthly_budget: number; notes: string | null;
    }) => {
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { error } = await db().from("marketing_tools").upsert(
        { ...input, tenant_id: tenantId, monthly_budget: Math.max(0, Math.round(input.monthly_budget || 0)), updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,tool_key" },
      );
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: TOOLS_KEY }); toast.success("Saved"); },
    onError: (err) => toastError(err),
  });
}

/** This calendar month's recorded marketing spend per channel (expenses.channel). */
export function useSpendThisMonth() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  return useQuery({
    queryKey: ["expenses", "spend-by-channel-month", iso(start)],
    queryFn: async (): Promise<Record<string, number>> => {
      const supabase = createClient();
      const data = await fetchAllRows((from, to) => supabase
        .from("expenses")
        .select("channel, amount, category")
        .not("channel", "is", null)
        .gte("expense_date", iso(start))
        .lt("expense_date", iso(end))
        .order("id", { ascending: true })
        .range(from, to));
      const out: Record<string, number> = {};
      for (const r of data as { channel: string | null; amount: number | null; category: string | null }[]) {
        if (!r.channel || !isMarketingCategory(r.category)) continue;
        out[r.channel] = (out[r.channel] ?? 0) + (r.amount ?? 0);
      }
      return out;
    },
  });
}

// ── Tracking links ───────────────────────────────────────────────────────────

export interface TrackingLink {
  id: string; label: string; channel: string; utm_medium: string; utm_campaign: string;
  utm_content: string | null; destination_path: string; full_url: string; created_at: string;
  /** Leads that arrived with this link's source + campaign. */
  leads: number;
  won: number;
}

export function useTrackingLinks() {
  return useQuery({
    queryKey: LINKS_KEY,
    queryFn: async (): Promise<TrackingLink[]> => {
      const data = await fetchAllRows((from, to) => db().from("tracking_links")
        .select("id, label, channel, utm_medium, utm_campaign, utm_content, destination_path, full_url, created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to));
      const links = data as Omit<TrackingLink, "leads" | "won">[];
      if (links.length === 0) return [];

      /* Count leads per (source, campaign). One query over the campaigns in use, not one
         per link. R-294: paged, so a busy campaign's count does not stop at 1000. */
      const supabase = createClient();
      const leads = await fetchAllRowsIn(links.map((l) => l.utm_campaign), (campaigns, from, to) => supabase
        .from("leads")
        .select("utm_source, utm_campaign, stage")
        .in("utm_campaign", campaigns)
        .order("id", { ascending: true })
        .range(from, to));
      const count = new Map<string, { leads: number; won: number }>();
      for (const l of leads as { utm_source: string | null; utm_campaign: string | null; stage: string | null }[]) {
        const k = `${(l.utm_source ?? "").toLowerCase()}|${l.utm_campaign ?? ""}`;
        const c = count.get(k) ?? { leads: 0, won: 0 };
        c.leads++; if (l.stage === "won") c.won++;
        count.set(k, c);
      }
      return links.map((l) => ({ ...l, ...(count.get(`${l.channel}|${l.utm_campaign}`) ?? { leads: 0, won: 0 }) }));
    },
  });
}

export function useCreateTrackingLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<TrackingLink, "id" | "created_at" | "leads" | "won">) => {
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await db().from("tracking_links").insert({ ...input, tenant_id: tenantId, created_by: auth?.user?.id ?? null });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: LINKS_KEY }); toast.success("Link saved"); },
    onError: (err) => toastError(err),
  });
}

export function useDeleteTrackingLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from("tracking_links").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: LINKS_KEY }); toast.success("Link removed — leads already captured keep their source"); },
    onError: (err) => toastError(err),
  });
}

// ── Email opt-outs ───────────────────────────────────────────────────────────

export interface Suppression { email: string; reason: string; campaign_id: string | null; created_at: string }

export function useEmailSuppressions() {
  return useQuery({
    queryKey: SUPPRESS_KEY,
    queryFn: async (): Promise<Suppression[]> => {
      /* R-294: paged. No id column — (tenant_id, email) is the key, and RLS pins the tenant,
         so email is the unique tie-break. */
      const data = await fetchAllRows((from, to) => db().from("email_suppressions")
        .select("email, reason, campaign_id, created_at")
        .order("created_at", { ascending: false })
        .order("email", { ascending: true })
        .range(from, to));
      return data as Suppression[];
    },
  });
}

/** Put an address back on the list — only when the person asked for it. */
export function useRemoveSuppression() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (email: string) => {
      const { error } = await db().from("email_suppressions").delete().eq("email", email);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: SUPPRESS_KEY }); toast.success("Removed from opt-out list"); },
    onError: (err) => toastError(err),
  });
}

// ── Google review requests (migration 20260926220000) ────────────────────────

const REVIEW_KEY = ["review-requests"] as const;

/** The Google "ask for reviews" link, kept on the google-business tool row. */
export function useReviewLink() {
  return useQuery({
    queryKey: [...TOOLS_KEY, "review-link"],
    queryFn: async (): Promise<string> => {
      const { data, error } = await db().from("marketing_tools").select("review_link").eq("tool_key", "google-business").maybeSingle();
      if (error) throw error;
      return (data?.review_link as string | null) ?? "";
    },
  });
}

export function useSaveReviewLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (link: string) => {
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      /* Upsert only the link: an existing row keeps its status, owner and budget. */
      const { error } = await db().from("marketing_tools").upsert(
        { tenant_id: tenantId, tool_key: "google-business", name: "Google Business Profile", review_link: link.trim() || null, updated_at: new Date().toISOString() },
        { onConflict: "tenant_id,tool_key" },
      );
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: TOOLS_KEY }); toast.success("Review link saved"); },
    onError: (err) => toastError(err),
  });
}

export interface ReviewCustomer {
  id: string; name: string; contact: string | null; email: string | null; phone: string | null;
  lastAsked: string | null; asks: number;
}

export function useReviewCustomers() {
  return useQuery({
    queryKey: REVIEW_KEY,
    queryFn: async (): Promise<ReviewCustomer[]> => {
      const supabase = createClient();
      const cs = await fetchAllRows((from, to) => supabase.from("customers")
        .select("id, name, display_name, contact_name, contact_first_name, contact_email, contact_phone, contact_mobile, is_active")
        .order("name")
        .order("id", { ascending: true })
        .range(from, to));
      const asks = await fetchAllRows((from, to) => db().from("review_requests")
        .select("customer_id, created_at")
        .order("id", { ascending: true })
        .range(from, to));
      const by = new Map<string, { last: string; n: number }>();
      for (const a of asks as { customer_id: string; created_at: string }[]) {
        const c = by.get(a.customer_id) ?? { last: a.created_at, n: 0 };
        c.n++; if (a.created_at > c.last) c.last = a.created_at;
        by.set(a.customer_id, c);
      }
      return (cs as Record<string, any>[])  // eslint-disable-line @typescript-eslint/no-explicit-any
        .filter((c) => c.is_active !== false)
        .map((c) => ({
          id: c.id, name: c.display_name || c.name,
          contact: c.contact_first_name || c.contact_name || null,
          email: c.contact_email || null, phone: c.contact_mobile || c.contact_phone || null,
          lastAsked: by.get(c.id)?.last ?? null, asks: by.get(c.id)?.n ?? 0,
        }));
    },
  });
}

export function useSendReviewEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { customerId: string; force?: boolean }) => {
      const res = await fetch("/api/marketing/review-request", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(j.error ?? "Mail nahi gaya"), { code: j.code });
      return j as { status: string; to: string };
    },
    onSuccess: (j) => {
      qc.invalidateQueries({ queryKey: REVIEW_KEY });
      toast.success(j.status === "stubbed" ? `Test mode — mail ${j.to} ko log hua, bheja nahi` : `Review request ${j.to} ko bheja`);
    },
  });
}

/** WhatsApp opens in a new tab with the message typed; the ask is logged as "opened". */
export function useLogWhatsAppReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { customerId: string; phone: string }) => {
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await db().from("review_requests").insert({
        tenant_id: tenantId, customer_id: v.customerId, channel: "whatsapp", sent_to: v.phone, status: "opened", created_by: auth?.user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: REVIEW_KEY }),
  });
}

/** This company's name, for the sign-off in a prefilled WhatsApp message. RLS returns only its own row. */
export function useCompanyName() {
  return useQuery({
    queryKey: ["company-name"],
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<string> => {
      const { data } = await createClient().from("tenants").select("name").limit(1).maybeSingle();
      return (data?.name as string | undefined) ?? "";
    },
  });
}
