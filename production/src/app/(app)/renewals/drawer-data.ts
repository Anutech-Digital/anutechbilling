"use client";
/**
 * R-2740 — the row drawer's ONE read, only while it is open (no page-load cost): for this one
 * subscription, every linked quote + invoice (readRenewalDocs `{ all: true }`, R-2728/R-2737/R-2748
 * links + periods) and every captured payment (readRenewalLastPaid, R-2752 links) — the two batched
 * readers the rows use, side by side inside a single query, never one call per document.
 * Keyed under ["quotes"] (like the rows' documents) so Send / Bill next part / Record payment —
 * which invalidate "quotes" — refresh it; the payments half is re-read with it.
 * R-2762: the renewal reminders sent (renewal_email_log + whatsapp_reminder_log) are read in the
 * same step, in parallel — two small indexed reads for this one subscription.
 */
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { docRefs, docsFromRows, readRenewalDocRows } from "./last-docs-data";
import { lastPaidFromDocRows } from "./last-paid-data";
import type { DocQuote, LastDocs, LastDocsInput } from "./last-docs";
import type { LastPaid } from "./last-paid";
import { tdsInfoByPayment, type PaymentTds } from "@/components/features/customers/payment-tds-line";
import { TDS_REVERSED_STATUS } from "@/lib/queries/tds-receivable";
import { REMINDER_LOG_MAX, WA_SENT_STATUSES, type ReminderLog } from "./reminder-log";

type SubRef = LastDocsInput["subs"][number];

export interface DrawerData {
  docs: LastDocs | undefined;
  paid: LastPaid | undefined;
  /** R-2762: null = the reminder logs could not be read (the drawer falls back to the counter). */
  reminders: ReminderLog | null;
  /** R-2843: TDS deducted per payment id (tds_receivable, the customer page's source); {} when none / unreadable. */
  tds?: Record<string, PaymentTds>;
}

/**
 * R-2843 — TDS per payment: payments carries no TDS column, tds_receivable (payment_id, tds_amount, section) does.
 * One read for this subscription's payment ids, in the same drawer query. Browser client — RLS scopes it to the
 * tenant. A failed read gives {} (the payments still show, just without the TDS line).
 */
export async function readPaymentTds(paymentIds: readonly string[]): Promise<Record<string, PaymentTds>> {
  if (!paymentIds.length) return {};
  try {
    const sb = createClient();
    const rows = await fetchAllRowsIn<{ id: string; payment_id: string | null; tds_amount: number | null; section: string | null }, string>(
      paymentIds, (run, from, to) => sb
        .from("tds_receivable")
        .select("id, payment_id, tds_amount, section")
        .in("payment_id", run)
        .filter("status", "neq", TDS_REVERSED_STATUS)
        .order("id", { ascending: true })
        .range(from, to));
    return tdsInfoByPayment(rows);
  } catch {
    return {};
  }
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

/**
 * R-2762 — every renewal reminder for ONE subscription: the email log (renewal_email_log_sub_idx:
 * subscription_id, sent_at desc) and the WhatsApp reminders that went out (whatsapp_reminder_log_once:
 * tenant, subject, step where sent/delivered/read), both in one parallel step. Browser client — RLS
 * (tenant_id = current_tenant_id()) scopes it; tenant_id is also named so the index is used. A failed
 * read returns null instead of throwing, so the documents and payments still show.
 */
export async function readReminderLog(subId: string, tenantId: string | null | undefined): Promise<ReminderLog | null> {
  if (!tenantId) return null;
  const sb = createClient();
  try {
    const [email, whatsapp] = await Promise.all([
      sb.from("renewal_email_log")
        .select("id, cadence_step, recipient_email, status, sent_at")
        .eq("tenant_id", tenantId)
        .eq("subscription_id", subId)
        .order("sent_at", { ascending: false })
        .limit(REMINDER_LOG_MAX),
      sb.from("whatsapp_reminder_log")
        .select("id, kind, step, phone, status, sent_at, created_at")
        .eq("tenant_id", tenantId)
        .eq("subject_type", "subscription")
        .eq("subject_id", subId)
        .in("status", [...WA_SENT_STATUSES])
        .order("created_at", { ascending: false })
        .limit(REMINDER_LOG_MAX),
    ]);
    if (email.error || whatsapp.error) return null;
    return { email: email.data ?? [], whatsapp: whatsapp.data ?? [] };
  } catch {
    return null;
  }
}

export function useRenewalDrawerData(sub: (SubRef & { tenant_id?: string | null }) | null) {
  const ref = sub ? docRefs([sub])[0] : null;
  return useQuery({
    queryKey: ["quotes", "renewal-drawer", ref?.id ?? "", ref?.quote_id ?? "", ref?.renewal_quote_id ?? "", ref?.plan ?? "", ref?.domain ?? "", ref?.term_months ?? "", ref?.start_date ?? ""],
    enabled: !!ref,
    staleTime: 0,   // every open reads afresh (a payment saved elsewhere invalidates only "payments")
    queryFn: async (): Promise<DrawerData> => {
      /* R-2765: rounds 1–2 read ONCE for both (the revisions only join Last docs' quotes) */
      const [rows, reminders] = await Promise.all([
        readRenewalDocRows([ref!], { moreQuotes: readRevisions }),
        readReminderLog(ref!.id, sub?.tenant_id),
      ]);
      const [docs, paid] = await Promise.all([
        docsFromRows([ref!], rows, { all: true }),
        lastPaidFromDocRows([ref!], rows, { historySize: Infinity }),
      ]);
      const mine = paid.get(ref!.id);
      const tds = await readPaymentTds([...new Set((mine?.history ?? []).map((l) => l.paymentId))]);
      return { docs: docs.get(ref!.id), paid: mine, reminders, tds };
    },
  });
}
