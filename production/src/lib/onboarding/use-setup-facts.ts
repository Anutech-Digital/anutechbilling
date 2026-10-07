/**
 * S31 — gathers the facts the Dashboard setup checklist judges, from the SAME reads the
 * settings screens use, so a save there ticks the row here without a reload:
 *
 *   invoice code  → /api/tenant/invoice-code          (key ["invoice-code"], Settings → Company)
 *   sending email → /api/integrations/email-provider  (key ["integrations","email-provider"])
 *   team          → users (["team","members"]) + open team_invites (owner-only RLS)
 *   company, GSTIN, bank/UPI → useCurrentUser (tenants row)
 *
 * A failed read becomes null ("Could not check"), never a tick. Roles that cannot open the
 * settings screen skip the fetch — their rows are filtered out of the card anyway.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useTeamMembers } from "@/lib/queries/team";
import type { EmailProbe, InvoiceCodeProbe, SetupFacts } from "@/components/features/dashboard/setup-checklist";

const SETTINGS_ROLES = new Set(["owner", "manager"]);

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json() as Promise<T>;
}

export function useSetupFacts(): SetupFacts {
  const { data: me } = useCurrentUser();
  const role = me?.role ?? null;
  const canSettings = role !== null && SETTINGS_ROLES.has(role);
  const isOwner = role === "owner";

  const invoiceQ = useQuery({
    queryKey: ["invoice-code"],
    queryFn: () => getJson<InvoiceCodeProbe>("/api/tenant/invoice-code"),
    enabled: canSettings,
    staleTime: 30_000,
    retry: 1,
  });
  const emailQ = useQuery({
    queryKey: ["integrations", "email-provider"],
    queryFn: () => getJson<EmailProbe>("/api/integrations/email-provider"),
    enabled: canSettings,
    staleTime: 60_000,
    retry: 1,
  });
  const membersQ = useTeamMembers();
  const invitesQ = useQuery({
    queryKey: ["team", "invites", "open-count"],
    queryFn: async (): Promise<number> => {
      const supabase = createClient();
      // RLS scopes team_invites to the caller's tenant (owner-only).
      const { count, error } = await supabase
        .from("team_invites")
        .select("id", { count: "exact", head: true })
        .is("accepted_at", null);
      if (error) throw error;
      return count ?? 0;
    },
    enabled: isOwner,
    staleTime: 60_000,
    retry: 1,
  });

  /** undefined while loading, null when it failed or this role does not read it. */
  function probe<T>(q: { isError: boolean; data: T | undefined }, enabled: boolean): T | null | undefined {
    if (!enabled) return null;
    if (q.isError) return null;
    return q.data;
  }

  return {
    address: me?.tenantAddress,
    stateCode: me?.tenantStateCode,
    gstin: me?.tenantGstin,
    upiVpa: me?.tenantUpiVpa,
    remitAccountNumber: me?.tenantRemitAccountNumber,
    remitIfsc: me?.tenantRemitIfsc,
    invoiceCode: me ? probe(invoiceQ, canSettings) : undefined,
    email: me ? probe(emailQ, canSettings) : undefined,
    memberCount: me ? (membersQ.isError ? null : membersQ.data?.length) : undefined,
    pendingInvites: me ? probe(invitesQ, isOwner) : undefined,
  };
}
