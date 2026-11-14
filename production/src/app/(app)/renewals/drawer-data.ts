"use client";
/**
 * R-2740 — the row drawer's ONE read, only while it is open (no page-load cost): for this one
 * subscription, every linked quote + invoice (readRenewalDocs `{ all: true }`, R-2728/R-2737/R-2748
 * links + periods) and every captured payment (readRenewalLastPaid, R-2752 links) — the two batched
 * readers the rows use, side by side inside a single query, never one call per document.
 * Keyed under ["quotes"] (the docs) so Send / Bill next part / Record payment refresh it too; the
 * payments half is re-read with it.
 */
import { useQuery } from "@tanstack/react-query";
import { docRefs, readRenewalDocs } from "./last-docs-data";
import { readRenewalLastPaid } from "./last-paid-data";
import type { LastDocs, LastDocsInput } from "./last-docs";
import type { LastPaid } from "./last-paid";

type SubRef = LastDocsInput["subs"][number];

export interface DrawerData {
  docs: LastDocs | undefined;
  paid: LastPaid | undefined;
}

export function useRenewalDrawerData(sub: SubRef | null) {
  const ref = sub ? docRefs([sub])[0] : null;
  return useQuery({
    queryKey: ["quotes", "payments", "renewal-drawer", ref?.id ?? "", ref?.quote_id ?? "", ref?.renewal_quote_id ?? "", ref?.plan ?? "", ref?.domain ?? ""],
    enabled: !!ref,
    staleTime: 30_000,
    queryFn: async (): Promise<DrawerData> => {
      const [docs, paid] = await Promise.all([
        readRenewalDocs([ref!], { all: true }),
        readRenewalLastPaid([ref!], { historySize: Infinity }),
      ]);
      return { docs: docs.get(ref!.id), paid: paid.get(ref!.id) };
    },
  });
}
