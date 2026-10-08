/**
 * TDS Receivable — Phase 1 read hooks.
 *
 * Used on /accounting/tds-receivable list page + year-end summary.
 * Tenant-scoped via RLS.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { Database, TdsReceivableRow, TdsStatus } from "@/lib/supabase/database.types";

type TdsInsert = Database["public"]["Tables"]["tds_receivable"]["Insert"];
type TdsUpdate = Database["public"]["Tables"]["tds_receivable"]["Update"];

export type TdsReceivable = TdsReceivableRow;
export type { TdsStatus };

/** Lifecycle stages — order shown in the list / tabs. */
export const TDS_STATUSES: TdsStatus[] = [
  "pending_cert",
  "cert_received",
  "verified_26as",
  "claimed",
  "disputed",
  "written_off",
];

export const TDS_STATUS_LABEL: Record<TdsStatus, string> = {
  pending_cert:  "Pending certificate",
  cert_received: "Cert received",
  verified_26as: "Verified on 26AS",
  claimed:       "Claimed in ITR",
  disputed:      "Disputed",
  written_off:   "Written off",
};

export const TDS_STATUS_DESCRIPTION: Record<TdsStatus, string> = {
  pending_cert:  "TDS deducted — chase customer for Form 16A",
  cert_received: "Form 16A uploaded — verify on your Form 26AS",
  verified_26as: "Govt confirms deposit — claim in this FY's ITR",
  claimed:       "Filed in ITR — adjusted against your tax liability",
  disputed:      "Form 26AS mismatch — chase customer for proof of deposit",
  written_off:   "Accepted as loss — bypass ITR claim",
};

export const TDS_SECTIONS = [
  { value: "194J",  label: "194J — Professional / technical services (10%)" },
  { value: "194C",  label: "194C — Contracts (2% for companies, 1% individuals)" },
  { value: "194Q",  label: "194Q — High-value goods purchase (0.1%)" },
  { value: "194H",  label: "194H — Commission / brokerage (5%)" },
  { value: "194I",  label: "194I — Rent (10% building, 2% machinery)" },
] as const;

// ────────────────────────────────────────────────────────────────
// Reads
// ────────────────────────────────────────────────────────────────

export function useTdsReceivables(opts?: {
  /** "claimable" = cert_received + verified_26as — the "Ready to claim" tile (R-118). */
  status?: TdsStatus | "all" | "claimable";
  fiscalYear?: string;
  customerId?: string;
}) {
  const { status, fiscalYear, customerId } = opts ?? {};
  return useQuery({
    queryKey: ["tds_receivable", { status, fiscalYear, customerId }],
    queryFn: async (): Promise<TdsReceivable[]> => {
      const supabase = createClient();
      let q = supabase
        .from("tds_receivable")
        .select("*")
        .order("payment_received_date", { ascending: false });
      if (status === "claimable") q = q.in("status", ["cert_received", "verified_26as"]);
      else if (status && status !== "all") q = q.eq("status", status);
      if (fiscalYear)                 q = q.eq("fiscal_year", fiscalYear);
      if (customerId)                 q = q.eq("customer_id", customerId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as TdsReceivable[];
    },
  });
}

/** Status counts + totals — drives the tab badges + KPI strip. */
export function useTdsSummary(fiscalYear?: string) {
  return useQuery({
    queryKey: ["tds_receivable", "summary", fiscalYear],
    queryFn: async () => {
      const supabase = createClient();
      let q = supabase
        .from("tds_receivable")
        .select("status, tds_amount, fiscal_year");
      if (fiscalYear) q = q.eq("fiscal_year", fiscalYear);
      const { data, error } = await q;
      if (error) throw error;

      const byStatus: Record<TdsStatus, { count: number; amount: number }> = {
        pending_cert:  { count: 0, amount: 0 },
        cert_received: { count: 0, amount: 0 },
        verified_26as: { count: 0, amount: 0 },
        claimed:       { count: 0, amount: 0 },
        disputed:      { count: 0, amount: 0 },
        written_off:   { count: 0, amount: 0 },
      };
      let totalAmount    = 0;
      let totalCount     = 0;
      let claimableAmount = 0; // cert_received + verified_26as
      for (const r of data ?? []) {
        const s = (r.status ?? "pending_cert") as TdsStatus;
        if (byStatus[s]) {
          byStatus[s].count += 1;
          byStatus[s].amount += r.tds_amount ?? 0;
        }
        totalCount  += 1;
        totalAmount += r.tds_amount ?? 0;
        if (s === "cert_received" || s === "verified_26as") {
          claimableAmount += r.tds_amount ?? 0;
        }
      }
      return { byStatus, totalCount, totalAmount, claimableAmount };
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Mutations
// ────────────────────────────────────────────────────────────────

/** ID generator: TDS-{FY}-{NNNN} or TDS-{base36}-{rand} fallback. */
function newTdsId(): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = Math.floor(Math.random() * 256).toString(16).padStart(2, "0").toUpperCase();
  return `TDS-${stamp}-${rand}`;
}

/** Compute Indian fiscal year label from a date (Apr 1 → Mar 31). */
export function fiscalYearFromDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const yr = d.getUTCFullYear();
  const m  = d.getUTCMonth(); // 0=Jan
  const fyStart = m < 3 ? yr - 1 : yr;
  return `FY${String(fyStart % 100).padStart(2, "0")}${String((fyStart + 1) % 100).padStart(2, "0")}`;
}

export function useCreateTdsReceivable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<TdsInsert, "id" | "tenant_id">) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");

      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const { data, error } = await supabase
        .from("tds_receivable")
        .insert({
          ...input,
          id:        newTdsId(),
          tenant_id: me.tenant_id,
        })
        .select()
        .single();
      if (error) throw error;
      return data as TdsReceivable;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("TDS entry recorded");
    },
    onError: (err) => toastError(err),
  });
}

export function useUpdateTdsReceivable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: TdsUpdate }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tds_receivable")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data as TdsReceivable;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("TDS entry updated");
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteTdsReceivable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("tds_receivable").delete().eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("TDS entry deleted");
    },
    onError: (err) => toastError(err),
  });
}

// ────────────────────────────────────────────────────────────────
// Lifecycle status transitions
// ────────────────────────────────────────────────────────────────

/** Mark Form 16A certificate as received (with optional PDF URL). */
export function useMarkCertReceived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, form16aUrl }: { id: string; form16aUrl?: string }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tds_receivable")
        .update({
          status:                  "cert_received",
          form_16a_received_date:  new Date().toISOString().slice(0, 10),
          ...(form16aUrl ? { form_16a_url: form16aUrl } : {}),
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("Form 16A marked received");
    },
    onError: (err) => toastError(err),
  });
}

/** Confirm govt deposit appears on Form 26AS. */
export function useMarkVerified26AS() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tds_receivable")
        .update({
          status:                "verified_26as",
          appears_in_26as:       true,
          appears_in_26as_date:  new Date().toISOString().slice(0, 10),
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("Verified on Form 26AS · ready to claim in ITR");
    },
    onError: (err) => toastError(err),
  });
}

/**
 * 26AS / AIS import ke baad — user ne match screen par jo rows confirm ki, unhe ek call me
 * "verified on 26AS" (tds_mark_26as_verified RPC, migration 20260928120000). RPC sirf
 * pending_cert / cert_received badalta hai; laute count se pata chalta hai kitni sach me badli.
 */
export function useApply26asMatches() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ids, seenOn }: { ids: string[]; seenOn: string }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("tds_mark_26as_verified", { p_ids: ids, p_seen_on: seenOn });
      if (error) throw error;
      return { asked: ids.length, updated: (data as number | null) ?? 0 };
    },
    onSuccess: ({ asked, updated }) => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      if (updated === asked) toast.success(`${updated} TDS entr${updated === 1 ? "y" : "ies"} verified on 26AS`);
      else toast.warning(`${updated} of ${asked} verified`, {
        description: "The other rows changed status meanwhile (claimed / written off) — reload the list to see them.",
      });
    },
    onError: (err) => toastError(err, { fallback: "26AS verification not saved." }),
  });
}

/** Mark as claimed in ITR (filed). */
export function useMarkClaimed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tds_receivable")
        .update({
          status:               "claimed",
          claimed_in_itr:       true,
          claimed_in_itr_date:  new Date().toISOString().slice(0, 10),
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("Marked claimed in ITR 🎉");
    },
    onError: (err) => toastError(err),
  });
}

/** Mark as disputed (26AS mismatch / customer didn't deposit). */
export function useMarkDisputed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason?: string }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tds_receivable")
        .update({
          status: "disputed",
          notes:  reason ? `[Disputed ${new Date().toISOString().slice(0,10)}] ${reason}` : null,
        })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("Marked disputed · chase customer for deposit proof");
    },
    onError: (err) => toastError(err),
  });
}

/** Accept as loss — bypass ITR claim. */
export function useWriteOffTds() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tds_receivable")
        .update({ status: "written_off" })
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("Written off");
    },
    onError: (err) => toastError(err),
  });
}

// ────────────────────────────────────────────────────────────────
// Form 16A PDF upload (Supabase Storage)
// ────────────────────────────────────────────────────────────────

/** Upload a Form 16A PDF/image to Supabase Storage. Returns the storage path. */
export async function uploadForm16a(tdsId: string, file: File): Promise<string> {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) throw new Error("Not authenticated");

  const { data: me } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", authData.user.id)
    .maybeSingle();
  if (!me) throw new Error("User not linked to a tenant");

  // Path convention: {tenant_id}/{tds_id}/{filename}
  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path      = `${me.tenant_id}/${tdsId}/${Date.now()}-${cleanName}`;

  const { error: uploadErr } = await supabase.storage
    .from("tds-certificates")
    .upload(path, file, { upsert: false });
  if (uploadErr) throw uploadErr;

  return path;
}

/** Create a signed URL for downloading a Form 16A. URL valid for 1 hour. */
export async function getForm16aSignedUrl(path: string): Promise<string> {
  const supabase = createClient();
  const { data, error } = await supabase.storage
    .from("tds-certificates")
    .createSignedUrl(path, 60 * 60);
  if (error) throw error;
  return data.signedUrl;
}
