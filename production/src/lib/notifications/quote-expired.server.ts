/**
 * R-1679: tell sales when a customer reaches a quote whose validity has ended.
 *
 * Staging 19 Oct (Q-5F40-27-0096): the customer opened an expired quote and tried to accept it;
 * the server refused, and nobody on our side heard about it — a warm customer, lost silently.
 * Now the same in-app notification as "Quote accepted" (notifyTenantOwners → owner + manager)
 * goes out when the customer:
 *   - opens the expired quote's link   ("opened"),
 *   - presses Accept on it              ("accept"),
 *   - presses "Request a fresh quote"   ("request").
 * Once per quote per kind of event per 24 hours (a customer reloading the page is one event), so the
 * bell stays useful. Never throws — a notification must not stop the customer's page.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyTenantOwners } from "./notify.server";

export type ExpiredQuoteEvent = "opened" | "accept" | "request";

const DEDUPE_MS = 24 * 60 * 60 * 1000;

/** The notification text for each event — pure, so it is tested. */
export function expiredQuoteNotice(e: ExpiredQuoteEvent, quoteId: string, customerName: string): { title: string; body: string } {
  const who = customerName.trim() || "The customer";
  if (e === "request") {
    return { title: `${who} asked for a fresh quote — ${quoteId} expired`, body: "They pressed \"Request a fresh quote\" on the expired link. Revise or duplicate it and send the new one." };
  }
  if (e === "accept") {
    return { title: `${who} tried to accept expired quote ${quoteId}`, body: "The link refused it because its validity ended. Revise or duplicate it and send the new one." };
  }
  return { title: `${who} opened expired quote ${quoteId}`, body: "Its validity has ended, so the link cannot be accepted. Send a fresh quote if they still want it." };
}

export async function notifyQuoteExpired(args: {
  admin: SupabaseClient;
  tenantId: string;
  quoteId: string;
  customerName: string;
  event: ExpiredQuoteEvent;
}): Promise<void> {
  try {
    const { title, body } = expiredQuoteNotice(args.event, args.quoteId, args.customerName);
    const since = new Date(Date.now() - DEDUPE_MS).toISOString();
    const { data: recent } = await args.admin
      .from("notifications")
      .select("id")
      .eq("tenant_id", args.tenantId)
      .eq("kind", "quote.expired")
      .eq("entity_id", args.quoteId)
      .eq("title", title.slice(0, 200))
      .gte("created_at", since)
      .limit(1);
    if (recent && recent.length > 0) return;
    await notifyTenantOwners({
      tenantId: args.tenantId,
      kind: "quote.expired",
      title,
      body,
      href: `/quotes/${args.quoteId}`,
      entityId: args.quoteId,
    });
  } catch (e) {
    console.error("[quote-expired] notify failed:", (e as Error).message);
  }
}
