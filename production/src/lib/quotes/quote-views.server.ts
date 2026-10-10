/**
 * Recording that a quote was opened, and telling the desk when it happens repeatedly.
 *
 * The decisions are in quote-intent.ts — what counts as a view, what counts as interest. This
 * is the IO: one insert on the public page, one read, one alert, one stamp.
 *
 * ─── WHY A BARE CLIENT ──────────────────────────────────────────────────────
 * `quote_views` is not in the generated `Database` type, and registering a new table is not a
 * two-line fix: measured 23 Aug 2026, adding ONE table to the Tables map took `npm run
 * typecheck` from 4 errors to 2,722, because supabase-js resolves row types through a
 * conditional chain that tips over the instantiation limit at this schema size. `ai_autonomy`,
 * `ai_action_log` and `ai_telecall_logs` are unregistered for the same measured reason.
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER. Every query below carries an
 * explicit `.eq("tenant_id", …)`, and that line is the whole boundary between one workspace's
 * quote analytics and another's.
 */
import crypto from "node:crypto";
import { createBareClient } from "@/lib/supabase/bare";
import type { createAdminClient } from "@/lib/supabase/server";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import {
  HOT_LEAD_WINDOW_MINUTES,
  detectHotLead,
  hotLeadAlert,
  isBotUserAgent,
  type QuoteView,
} from "./quote-intent";

function bare() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    /* `no-store` for the reason CLAUDE.md §17 gives: a cached read of "how many times have they
       opened this" would make the third view invisible, which is the one that matters. */
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

/**
 * A coarse viewer key — enough to collapse a refresh, not enough to identify anybody.
 *
 * ─── WHY A HASH AND NOT THE IP ──────────────────────────────────────────────
 * The only question this table answers is "did the same person come back". An IP address is
 * personal data about a prospect who never agreed to be tracked, and storing one to answer a
 * question a hash answers just as well would be collecting it because it was easy.
 *
 * Salted with SECRETS_MASTER_KEY so the hashes are not reversible by anybody who guesses the
 * scheme — an unsalted SHA of an IPv4 address is trivially reversed by iterating the space.
 * Falls back to an unsalted digest when no key is set, which is weaker and still better than
 * the address itself; the alternative would be storing nothing and losing de-duplication.
 */
function viewerKey(ip: string | null, userAgent: string | null): string | null {
  const material = `${ip ?? ""}|${userAgent ?? ""}`.trim();
  if (material === "|" || !material) return null;
  const salt = process.env.SECRETS_MASTER_KEY?.trim() || "";
  return crypto.createHash("sha256").update(`${salt}:${material}`).digest("hex").slice(0, 32);
}

/**
 * Record one fetch of a quote's public page.
 *
 * Never throws. This runs inside a page render a prospect is waiting on: a failed analytics
 * write must not be able to stop them reading their quote. Returns false so the caller can log
 * it and move on.
 */
export async function recordQuoteView(input: {
  tenantId: string;
  quoteId: string;
  userAgent: string | null;
  ip: string | null;
}): Promise<boolean> {
  const db = bare();
  if (!db) return false;

  try {
    const { error } = await db.from("quote_views").insert({
      tenant_id: input.tenantId,
      quote_id: input.quoteId,
      /* Truncated. A full user-agent is a fingerprint, and this table is about "did they look",
         not about who they are — but the first 180 characters are enough to tell a link
         preview from a browser, which is the only thing it is read for. */
      user_agent: input.userAgent?.slice(0, 180) ?? null,
      is_bot: isBotUserAgent(input.userAgent),
      viewer_hash: viewerKey(input.ip, input.userAgent),
    });
    if (error) {
      console.error("[quote-views] insert failed:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[quote-views] insert crashed:", err);
    return false;
  }
}

/** This quote's views inside the window, machines included — the decision filters them. */
export async function recentQuoteViews(
  tenantId: string,
  quoteId: string,
  windowMinutes = HOT_LEAD_WINDOW_MINUTES,
): Promise<QuoteView[]> {
  const db = bare();
  if (!db) return [];

  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const { data, error } = await db
    .from("quote_views")
    .select("viewed_at, is_bot, viewer_hash")
    .eq("tenant_id", tenantId)
    .eq("quote_id", quoteId)
    .gte("viewed_at", since)
    .order("viewed_at", { ascending: true });

  if (error) {
    console.error("[quote-views] read failed:", error.message);
    return [];
  }

  const rows = (data ?? []) as Array<{ viewed_at: string; is_bot: boolean | null; viewer_hash: string | null }>;
  return rows.map((r) => ({
    viewedAt: new Date(r.viewed_at),
    isBot: r.is_bot === true,
    viewerHash: r.viewer_hash,
  }));
}

/**
 * Tell the desk, once, that a quote is being read hard.
 *
 * ─── NOT GATED BY THE AUTONOMY DIAL, AND THAT IS THE ESTABLISHED RULE ───────
 * This alert goes to OUR OWN desk — "your customer is reading their quote" — not to a customer.
 * The dial exists to stop what the app sends OUT to other people and must never be able to
 * silence what it says TO US. That is the same reasoning that removed `compliance.send` from
 * the registry and that leaves the SLA breach alert ungated. A kill switch that also muted this
 * would turn one busy afternoon into a deal that went quiet.
 *
 * The stamp is written BEFORE the send, deliberately. If the mail fails, the desk has lost one
 * alert; if the stamp fails after a successful send, the desk gets alerted again on the next
 * view, and again, which is the failure this stamp was built for on 24 Aug.
 */
export async function maybeAlertHotLead(input: {
  admin: ReturnType<typeof createAdminClient>;
  tenantId: string;
  quoteId: string;
  customerName: string;
  amount: number;
  alreadyAlertedAt: Date | null;
  now?: Date;
}): Promise<{ alerted: boolean; reason: string }> {
  const now = input.now ?? new Date();
  const views = await recentQuoteViews(input.tenantId, input.quoteId);
  const verdict = detectHotLead({ views, now, alreadyAlertedAt: input.alreadyAlertedAt });

  if (!verdict.hot) return { alerted: false, reason: verdict.reason };

  const db = bare();
  if (!db) return { alerted: false, reason: "Supabase is not configured" };

  /* Stamp first — see the docstring. `is null` makes this the claim: two concurrent page loads
     both reaching this point produce exactly one alert, because only one update matches. */
  const { data: claimed, error: stampErr } = await db
    .from("quotes")
    .update({ hot_lead_alerted_at: now.toISOString() })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.quoteId)
    .is("hot_lead_alerted_at", null)
    .select("id");

  if (stampErr) {
    console.error("[quote-views] could not stamp the alert:", stampErr.message);
    return { alerted: false, reason: `could not claim the alert: ${stampErr.message}` };
  }
  if (!claimed || claimed.length === 0) {
    /* Somebody else claimed it between the read and the write — two page loads a second apart.
       Not an error; exactly what the claim is for. */
    return { alerted: false, reason: "another request had already claimed this alert" };
  }

  const { alert, tenant } = await loadOwnerAlert(input.admin, input.tenantId);
  if (!alert.ok || !tenant) {
    return { alerted: false, reason: `no owner address to alert: ${alert.ok ? "no tenant" : alert.reason}` };
  }

  const message = hotLeadAlert({
    customerName: input.customerName,
    quoteId: input.quoteId,
    amount: input.amount,
    verdict,
  });

  const sent = await sendEmail({
    to: alert.to,
    from: process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>",
    subject: `[HOT] ${message.subject}`,
    text: message.body,
    route: { tenantId: input.tenantId },
    kind: "quote_hot_lead",
    /* NOT marked `automated`, matching the SLA breach alert exactly — see the docstring. This
       is mail to our own desk about our own pipeline, and the dial must not be able to
       silence it. */
  });

  return {
    alerted: sent.status === "sent",
    reason: sent.status === "sent" ? verdict.reason : `alert could not be sent (${sent.status})`,
  };
}
