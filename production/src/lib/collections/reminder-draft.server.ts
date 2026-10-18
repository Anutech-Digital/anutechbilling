/**
 * R-1518 — server half of "Remind": read one customer's balance + contact, and draft the text.
 *
 * Reads run on the CALLER'S session client, so RLS decides which customer they may see; every
 * list read pages past PostgREST's 1000-row cap (fetchAllRows / fetchAllRowsIn).
 *
 * Drafting: Gemini through the shared helper (resolveGeminiConfig → geminiJson, with its
 * timeout and circuit breaker). No key, no answer, or an answer naming an amount we did not
 * give it (verifyDraftMoney) → the plain template. NOTHING IS SENT HERE.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { primaryContactFor } from "@/lib/contacts/primary";
import { geminiJson } from "@/lib/ai/gemini";
import { verifyDraftMoney } from "@/lib/ai/money-guard";
import {
  buildReminderTemplate, reminderAllowedAmounts, reminderFactsForAi, REMINDER_AI_SYSTEM,
  type ReminderContext, type ReminderDraft, type ReminderInvoiceRow, type ReminderRaw,
  type ReminderSubscriptionRow,
} from "./reminder-draft";

type Db = Pick<SupabaseClient, "from">;

export interface ReminderCustomer {
  customerName: string;
  phone: string | null;
  email: string | null;
}

/** Everything the reminder needs for one customer, or null when the caller cannot see them. */
export async function loadReminderRaw(
  db: Db,
  opts: { customerId: string; tenantId: string; origin: string | null },
): Promise<{ raw: ReminderRaw; customer: ReminderCustomer } | null> {
  const { customerId, tenantId } = opts;
  const { data: cust, error: custErr } = await db
    .from("customers")
    .select("id, name, display_name, contact_name, contact_email, contact_mobile, contact_phone")
    .eq("id", customerId)
    .maybeSingle();
  if (custErr) throw custErr;
  if (!cust) return null;

  const [invoices, subscriptions, contact, tenant, promise] = await Promise.all([
    fetchAllRows<ReminderInvoiceRow>((from, to) => db
      .from("invoices")
      .select("id, amount, net_payable, paid_amount, status, invoice_date, due_date, quote_id")
      .eq("customer_id", customerId)
      .in("status", ["pending", "overdue"])
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAllRows<ReminderSubscriptionRow>((from, to) => db
      .from("subscriptions")
      .select("id, plan, domain, quote_id, outstanding_amount, payment_due_date, created_at")
      .eq("customer_id", customerId)
      .gt("outstanding_amount", 0)
      .is("written_off_at", null)
      .order("id", { ascending: true })
      .range(from, to)),
    primaryContactFor(db, customerId),
    db.from("tenants").select("name, upi_vpa, upi_payee_name").eq("id", tenantId).maybeSingle(),
    db.from("payment_followups")
      .select("promised_on, promised_amount")
      .eq("customer_id", customerId)
      .not("promised_on", "is", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (tenant.error) throw tenant.error;
  if (promise.error) throw promise.error;

  const subQuoteIds = subscriptions.map((s) => s.quote_id).filter((x): x is string => !!x);
  const allQuoteIds = [...new Set([...invoices.map((i) => i.quote_id), ...subQuoteIds].filter((x): x is string => !!x))];
  const [invoicedQuotes, quotes] = await Promise.all([
    fetchAllRowsIn<{ id: string; quote_id: string | null }, string>(subQuoteIds, (ids, from, to) => db
      .from("invoices").select("id, quote_id").in("quote_id", ids).order("id", { ascending: true }).range(from, to)),
    fetchAllRowsIn<{ id: string; public_token: string | null }, string>(allQuoteIds, (ids, from, to) => db
      .from("quotes").select("id, public_token").in("id", ids).order("id", { ascending: true }).range(from, to)),
  ]);

  const c = cust as {
    name: string; display_name: string | null; contact_name: string | null;
    contact_email: string | null; contact_mobile: string | null; contact_phone: string | null;
  };
  const customerName = c.display_name?.trim() || c.name?.trim() || "Customer";
  const t = tenant.data as { name: string | null; upi_vpa: string | null; upi_payee_name: string | null } | null;

  return {
    raw: {
      customerName,
      contactName: contact.name ?? c.contact_name ?? null,
      sellerName: t?.name ?? "",
      invoices,
      subscriptions,
      invoicedQuoteIds: new Set(invoicedQuotes.map((i) => i.quote_id).filter((x): x is string => !!x)),
      quoteTokens: new Map(quotes.filter((q) => !!q.public_token).map((q) => [q.id, q.public_token as string])),
      lastPromise: (promise.data as ReminderRaw["lastPromise"]) ?? null,
      upiVpa: t?.upi_vpa ?? null,
      upiPayeeName: t?.upi_payee_name ?? null,
      origin: opts.origin,
    },
    customer: {
      customerName,
      /* Primary contact first (lib/contacts/primary — the one resolver), then the legacy
         customer columns as a floor, as primaryContactEmail does. */
      phone: contact.phone?.trim() || c.contact_mobile?.trim() || c.contact_phone?.trim() || null,
      email: contact.email?.trim() || c.contact_email?.trim() || null,
    },
  };
}

export type DraftMode = "gemini" | "template";

export interface DraftResult extends ReminderDraft {
  mode: DraftMode;
  /** Why the template was used, in words for the person (null when the AI drafted). */
  note: string | null;
}

export const NOTE_NO_KEY = "AI is not set up (no Gemini key) — this is the standard reminder. Edit it as you like.";
export const NOTE_AI_DOWN = "The AI did not answer just now — this is the standard reminder. Edit it as you like.";
export const NOTE_AI_BLOCKED = "The AI draft named an amount that is not on this customer's bills, so it was thrown away — this is the standard reminder.";

type CallAi = typeof geminiJson;

/** Draft with Gemini when a key is set; the template otherwise. Never sends anything. */
export async function draftReminder(
  ctx: ReminderContext,
  cfg: { apiKey: string | null; model: string },
  callAi: CallAi = geminiJson,
): Promise<DraftResult> {
  const template = buildReminderTemplate(ctx);
  if (!cfg.apiKey) return { ...template, mode: "template", note: NOTE_NO_KEY };

  const out = await callAi<Partial<ReminderDraft>>({
    apiKey: cfg.apiKey,
    model: cfg.model,
    system: REMINDER_AI_SYSTEM,
    user: `Facts:\n${reminderFactsForAi(ctx)}\n\nDraft the reminder now.`,
    temperature: 0.4,
    label: "collections/reminder-draft",
  });
  const message = typeof out?.message === "string" ? out.message.trim() : "";
  if (!message) return { ...template, mode: "template", note: NOTE_AI_DOWN };
  const subject = (typeof out?.subject === "string" && out.subject.trim()) || template.subject;

  const verdict = verifyDraftMoney(`${subject}\n${message}`, reminderAllowedAmounts(ctx));
  if (!verdict.ok) {
    console.error(`[collections/reminder-draft] AI draft refused — amount(s) ${verdict.violations.join(", ")} not on the customer's bills; used the template.`);
    return { ...template, mode: "template", note: NOTE_AI_BLOCKED };
  }
  return { subject, message, mode: "gemini", note: null };
}
