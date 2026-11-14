"use client";
/**
 * R-2740 — the row drawer's ONE read, only while it is open (no page-load cost): for this one
 * subscription, every linked quote + invoice (readRenewalDocs `{ all: true }`, R-2728/R-2737/R-2748
 * links + periods) and every captured payment (readRenewalLastPaid, R-2752 links) — the two batched
 * readers the rows use, side by side inside a single query, never one call per document.
 * Keyed under ["quotes"] (like the rows' documents) so Send / Bill next part / Record payment —
 * which invalidate "quotes" — refresh it; the payments half is re-read with it.
 */
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { docRefs, docsFromRows, readRenewalDocRows } from "./last-docs-data";
import { lastPaidFromDocRows } from "./last-paid-data";
import type { DocQuote, LastDocs, LastDocsInput } from "./last-docs";
import type { LastPaid } from "./last-paid";

type SubRef = LastDocsInput["subs"][number];

export interface DrawerData {
  docs: LastDocs | undefined;
  paid: LastPaid | undefined;
}

/** How far the drawer follows a quote's revisions (R1 → R2 → …). */
const REVISION_STEPS = 10;
/** PostgREST `in.(…)` list — quoted so a comma or dot never splits an id. */
const inList = (ids: readonly string[]) => `(${ids.map((x) => `"${x.replace(/["\\]/g, "")}"`).join(",")})`;

/**
 * The other revisions of the quotes found. A revision takes the subscription link off the old quote
 * (R-2368 trigger) and an unsent revision draft has none yet, so neither is reached by the links:
 * each is found by superseded_by / revision_of (and the quote a found one revises), both ways in
 * ONE read per step of the chain — usually one or two steps, at most REVISION_STEPS.
 */
export async function readRevisions(found: readonly DocQuote[], cols: string): Promise<DocQuote[]> {
  /* quotes.revision_of / superseded_by are not in the generated select types — the same untyped read as last-docs-data.ts */
  const loose = createClient() as unknown as SupabaseClient;
  const seen = new Set(found.map((q) => q.id));
  const parentOf = new Map(found.filter((q) => q.revision_of).map((q) => [q.id, q.revision_of as string]));
  const out: DocQuote[] = [];
  let step = [...seen];
  for (let i = 0; i < REVISION_STEPS && step.length; i++) {
    const got = await fetchAllRowsIn<DocQuote, string>(step, (run, from, to) => loose
      .from("quotes")
      .select(cols)
      .or(`superseded_by.in.${inList(run)},revision_of.in.${inList(run)},id.in.${inList(run.map((x) => parentOf.get(x) ?? x))}`)
      .order("id", { ascending: true })
      .range(from, to)
      .returns<DocQuote[]>(), { chunkSize: 60 });   // three id lists in one URL
    const fresh = got.filter((q) => !seen.has(q.id));
    for (const q of fresh) { seen.add(q.id); out.push(q); if (q.revision_of) parentOf.set(q.id, q.revision_of); }
    step = fresh.map((q) => q.id);
  }
  return out;
}

export function useRenewalDrawerData(sub: SubRef | null) {
  const ref = sub ? docRefs([sub])[0] : null;
  return useQuery({
    queryKey: ["quotes", "renewal-drawer", ref?.id ?? "", ref?.quote_id ?? "", ref?.renewal_quote_id ?? "", ref?.plan ?? "", ref?.domain ?? ""],
    enabled: !!ref,
    staleTime: 0,   // every open reads afresh (a payment saved elsewhere invalidates only "payments")
    queryFn: async (): Promise<DrawerData> => {
      /* R-2765: rounds 1–2 read ONCE for both (the revisions only join Last docs' quotes) */
      const rows = await readRenewalDocRows([ref!], { moreQuotes: readRevisions });
      const [docs, paid] = await Promise.all([
        docsFromRows([ref!], rows, { all: true }),
        lastPaidFromDocRows([ref!], rows, { historySize: Infinity }),
      ]);
      return { docs: docs.get(ref!.id), paid: paid.get(ref!.id) };
    },
  });
}
