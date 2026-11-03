/**
 * Team members — the tenant's login users (owner / manager / sales / accountant),
 * used to ASSIGN tasks and show who owns what. RLS scopes the read to the
 * current tenant. A task can only be assigned to someone who has a login here
 * (invite them at /team) — payroll-only employees without a login can't act on
 * in-app tasks.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export interface TeamMember {
  id: string;
  full_name: string | null;
  email: string | null;
  role: string;
  initials: string | null;
  color: string | null;
  /** R-2441: last IST day this login may work (users.access_ends_on, R-1896); null = no end.
   *  The sole-owner rule (lib/quotes/approval.ts isSoleOwner) does not count an owner past it. */
  access_ends_on?: string | null;
}

export function useTeamMembers() {
  return useQuery({
    queryKey: ["team", "members"],
    queryFn: async (): Promise<TeamMember[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, email, role, initials, color, is_active, access_ends_on")
        .order("full_name", { ascending: true });
      if (error) throw error;
      return (data ?? [])
        .filter((m) => (m as { is_active?: boolean | null }).is_active !== false)
        .map((m) => ({
          id: m.id, full_name: m.full_name, email: m.email,
          role: m.role, initials: m.initials, color: m.color,
          access_ends_on: (m as { access_ends_on?: string | null }).access_ends_on ?? null,
        })) as TeamMember[];
    },
    staleTime: 60_000,
  });
}

/** Display name for a team member — full name, else email local-part, else "—". */
export function memberLabel(m: TeamMember | undefined | null): string {
  if (!m) return "Unassigned";
  return m.full_name || m.email?.split("@")[0] || "Teammate";
}
