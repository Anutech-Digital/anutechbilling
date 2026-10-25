/**
 * R-1857 — the people the Compliance Calendar and Today track one by one: the directors register
 * (Pvt Ltd, or a type not set yet) or the LLP's designated partners. Read-only.
 *
 * The directors read is keyed under COMPANY_DIRECTORS_KEY, so saving a director (which
 * invalidates that key) refreshes the calendar too; the partners read is the register's own hook.
 *
 * A failed or not-yet-migrated read gives `undefined` people → the one common DIR-3 KYC row, so
 * the calendar never loses its reminder because the register could not be read.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { COMPANY_DIRECTORS_KEY } from "@/lib/queries/company-directors";
import { useFirmPartners } from "@/lib/queries/partners";
import { entityProfile } from "./entity";
import type { BusinessType } from "./obligations";
import { peopleFromDirectors, peopleFromPartners, type CompliancePerson, type DirectorPersonRow } from "./people";

const untyped = () => createClient() as unknown as SupabaseClient;
const BASE_COLS = "name, din, ceased_on, dsc_expiry, last_kyc_year";

function useDirectorPeople(enabled: boolean) {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: [...COMPANY_DIRECTORS_KEY, "compliance-people", tenantId],
    enabled: enabled && Boolean(tenantId),
    queryFn: async (): Promise<CompliancePerson[] | null> => {
      let res = await untyped().from("company_directors").select(`${BASE_COLS}, kyc_details_changed_on`);
      /* Migration 20261024235500 not applied yet: read without the change date. */
      if (res.error && /kyc_details_changed_on/.test(res.error.message)) {
        res = await untyped().from("company_directors").select(BASE_COLS);
      }
      if (res.error) return null; // table missing / not allowed → the common row
      return peopleFromDirectors((res.data ?? []) as DirectorPersonRow[]);
    },
  });
}

/** `undefined` while loading or when the register cannot be read. */
export function useCompliancePeople(businessType: BusinessType | null | undefined): CompliancePerson[] | undefined {
  const type = entityProfile(businessType ?? null).type;
  const directors = useDirectorPeople(type === "pvt_ltd");
  const partners = useFirmPartners(type === "llp");
  if (type === "pvt_ltd") return directors.data ?? undefined;
  if (type === "llp") return partners.data ? peopleFromPartners(partners.data) : undefined;
  return undefined;
}
