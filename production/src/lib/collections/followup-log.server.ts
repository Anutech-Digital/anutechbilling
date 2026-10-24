/**
 * R-1517's "log one payment follow-up", as a function — so the two doors that write one use the
 * very same checks:
 *   • POST /api/collections/followups   (the Follow-up dialog, and "Open WhatsApp" in Remind)
 *   • POST /api/collections/reminder/email (R-1518: logs the entry right after the email went)
 *
 * Moved here unchanged from the route (R-1518). The rules are in followup-rules.ts: who it goes
 * to (resolveAssignee — only owner / manager / accountant may hand it to someone else), tenant_id
 * from the server, created_by left to the DB default auth.uid(). Runs on the caller's session,
 * so RLS still decides which customers they may touch.
 */
import type { createClient } from "@/lib/supabase/server";
import { RouteError, dbFail } from "@/lib/api/with-route";
import {
  buildFollowupInsert, defaultAssignee, resolveAssignee, type FollowupRequest,
} from "./followup-rules";

export const NOT_THIS_CUSTOMERS =
  "That bill is not this customer's — pick an invoice, quote or subscription from this customer's own list and save again.";

/**
 * R-1544: the invoice / quote / subscription a follow-up is about must belong to THAT customer.
 * The DB trigger (tg_payment_followups_same_tenant) only checks the company, so without this
 * customer A's follow-up could point at customer B's invoice. Read on the caller's session: an
 * id they cannot see is refused the same way (422). Call it BEFORE sending anything.
 */
export async function assertFollowupLinks(
  supabase: ReturnType<typeof createClient>,
  input: Pick<FollowupRequest, "customerId" | "invoiceId" | "quoteId" | "subscriptionId">,
): Promise<void> {
  const checks: Array<["invoices" | "quotes" | "subscriptions", string]> = [];
  if (input.invoiceId) checks.push(["invoices", input.invoiceId]);
  if (input.quoteId) checks.push(["quotes", input.quoteId]);
  if (input.subscriptionId) checks.push(["subscriptions", input.subscriptionId]);
  for (const [table, id] of checks) {
    const { data, error } = await supabase.from(table).select("id, customer_id").eq("id", id).maybeSingle();
    dbFail(error, "Could not check the linked bill — reload the page and try again.");
    if (!data || (data as { customer_id: string | null }).customer_id !== input.customerId) {
      throw new RouteError(422, NOT_THIS_CUSTOMERS);
    }
  }
}

export async function logFollowup(
  supabase: ReturnType<typeof createClient>,
  opts: { input: FollowupRequest; userId: string; tenantId: string; role: string },
): Promise<{ id: string; assignedTo: string | null }> {
  const { input, userId, tenantId, role } = opts;
  const { data: customer, error: custErr } = await supabase
    .from("customers")
    .select("id, account_manager_id")
    .eq("id", input.customerId)
    .maybeSingle();
  dbFail(custErr, "Could not read this customer — reload the page and try again.");
  if (!customer) {
    throw new RouteError(404, "This customer is not in your list any more — reload Payment Follow-up and pick them again.");
  }
  await assertFollowupLinks(supabase, input);

  const { data: latest, error: latestErr } = await supabase
    .from("payment_followups")
    .select("assigned_to")
    .eq("customer_id", input.customerId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  dbFail(latestErr, "Could not read this customer's follow-ups — reload the page and try again.");

  const decision = resolveAssignee({
    role,
    requested: input.assignedTo,
    defaultId: defaultAssignee({ latestAssignedTo: latest?.assigned_to, ownerId: customer.account_manager_id, meId: userId }),
  });
  if (!decision.ok) throw new RouteError(decision.status, decision.error);

  const { data: row, error } = await supabase
    .from("payment_followups")
    .insert(buildFollowupInsert(input, tenantId, decision.assignedTo))
    .select("id, assigned_to")
    .single();
  if (error?.code === "23514") {
    throw new RouteError(400, "The linked invoice, subscription or person is not in this company, or a promise has no date — pick them again and save.", `${error.code} ${error.message}`);
  }
  if (error?.code === "42501") {
    throw new RouteError(403, "You cannot add a follow-up for this customer — ask the customer's owner or your manager to add it.", `${error.code} ${error.message}`);
  }
  dbFail(error, "The follow-up was not saved — check your connection and press Save again.");

  return { id: row!.id, assignedTo: row!.assigned_to };
}
