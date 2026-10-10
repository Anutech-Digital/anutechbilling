/**
 * Reading what the AI did, out of the two tables that record it.
 *
 * The decisions are in `performance.ts` and are pure — including the ones that matter most,
 * which are the refusals to show a number. This file only fetches.
 *
 * ─── WHY A BARE CLIENT ──────────────────────────────────────────────────────
 * `ai_action_log` and `ai_sales_conversations` are not in the generated `Database` type, and
 * registering them is not the two-line fix it sounds like: measured 23 Aug 2026, adding ONE
 * table to the Tables map took `npm run typecheck` from 4 errors to 2,722, because supabase-js
 * resolves row types through a conditional chain that tips over the instantiation limit at this
 * schema size. So these stay unregistered and are read through a deliberately untyped client —
 * the pattern `sales-agent.server.ts` and `autonomy.server.ts` already establish.
 *
 * WITH NO GENERATED TYPES, NOTHING CHECKS THE TENANT FILTER. Every query below carries an
 * explicit `.eq("tenant_id", …)`, and that line is the whole boundary between one reseller's
 * numbers and another's. `tenantId` always comes from the caller's resolved context.
 */
import { createBareClient } from "@/lib/supabase/bare";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  aiConversion,
  aiFunnel,
  aiRevenue,
  topObjections,
  type AiActionRow,
  type AiConversion,
  type AiFunnel,
  type AiRevenue,
  type ObjectionSummary,
} from "./performance";

/** How far back the panel looks. A quarter, so a slow month does not read as a broken agent. */
export const PERFORMANCE_WINDOW_DAYS = 90;

function bare(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) return null;
  /* `no-store` is not optional (CLAUDE.md §17). A cached read here would show a founder last
     hour's funnel while they are watching a dial they just turned. */
  return createBareClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(u, { ...o, cache: "no-store" }) },
  });
}

export interface AiPerformance {
  funnel: AiFunnel;
  conversion: AiConversion;
  revenue: AiRevenue;
  objections: ObjectionSummary;
  /** True when the tables could not be read at all, so the card can say so rather than show 0. */
  unavailable: boolean;
}

/**
 * Everything the panel needs, for one tenant, over the window.
 *
 * Never throws. A dashboard tile that takes the page down with it is worse than a tile that
 * says it could not read — and this panel sits alongside the money-health card, which the
 * operator needs whether or not the AI numbers loaded.
 */
export async function loadAiPerformance(args: {
  tenantId: string;
  /** Injected rather than read from a clock here, so the caller controls the window. */
  since: string;
}): Promise<AiPerformance> {
  const db = bare();
  const empty: AiPerformance = {
    funnel: aiFunnel([]),
    conversion: aiConversion({ leadsReached: 0, leadsConverted: 0 }),
    revenue: aiRevenue({ paidRupees: 0, sentCount: 0 }),
    objections: topObjections([]),
    unavailable: true,
  };
  if (!db) return empty;

  try {
    const [actions, turns] = await Promise.all([
      db
        .from("ai_action_log")
        .select("action, outcome, reason, created_at, entity, entity_id")
        .eq("tenant_id", args.tenantId)
        .gte("created_at", args.since)
        .order("created_at", { ascending: false })
        .limit(5000),
      db
        .from("ai_sales_conversations")
        .select("content")
        .eq("tenant_id", args.tenantId)
        .eq("role", "user")
        .gte("created_at", args.since)
        .order("created_at", { ascending: false })
        .limit(2000),
    ]);

    const actionRows = (actions.data ?? []) as {
      action: string | null;
      outcome: string | null;
      reason: string | null;
      created_at: string | null;
      entity: string | null;
      entity_id: string | null;
    }[];

    const rows: AiActionRow[] = actionRows.flatMap((r) =>
      r.action && r.outcome
        ? [{ action: r.action, outcome: r.outcome, reason: r.reason, createdAt: r.created_at ?? "" }]
        : [],
    );

    /* Leads an AI message actually REACHED. Distinct, because a lead messaged three times is
       one lead — counting the messages would inflate the denominator of the conversion rate
       and make the AI look worse than it is, which is the opposite error but still an error. */
    const reached = new Set(
      actionRows
        .filter((r) => r.outcome === "sent" && r.entity === "lead" && r.entity_id)
        .map((r) => r.entity_id as string),
    );

    /* SHORT-CIRCUIT, and it is the honest path rather than an optimisation. With nothing sent,
       `aiConversion` and `aiRevenue` return null and say why — so querying payments to build a
       figure that will be discarded would be work done to produce a number we have already
       decided not to show. Today this is the branch that runs. */
    if (reached.size === 0) {
      return {
        funnel: aiFunnel(rows),
        conversion: aiConversion({ leadsReached: 0, leadsConverted: 0 }),
        revenue: aiRevenue({ paidRupees: 0, sentCount: 0 }),
        objections: topObjections((turns.data ?? []).map((t) => (t as { content: string | null }).content ?? "")),
        unavailable: false,
      };
    }

    const ids = [...reached];
    const [invoiceRows, paymentRows] = await Promise.all([
      db.from("invoices").select("id, lead_id, status").eq("tenant_id", args.tenantId).in("lead_id", ids),
      db.from("payments").select("amount, lead_id").eq("tenant_id", args.tenantId).in("lead_id", ids),
    ]);

    const converted = new Set(
      ((invoiceRows.data ?? []) as { lead_id: string | null; status: string | null }[])
        .filter((i) => i.lead_id && i.status === "paid")
        .map((i) => i.lead_id as string),
    );

    /* Whole rupees. `payments.amount` is rupees in this schema, not paise — AGENTS.md §1, and
       CLAUDE.md §13 records that the older "all money in paise" line was false and dangerous. */
    const paidRupees = ((paymentRows.data ?? []) as { amount: number | null }[]).reduce(
      (sum, p) => sum + (typeof p.amount === "number" ? p.amount : 0),
      0,
    );

    return {
      funnel: aiFunnel(rows),
      conversion: aiConversion({ leadsReached: reached.size, leadsConverted: converted.size }),
      revenue: aiRevenue({ paidRupees, sentCount: rows.filter((r) => r.outcome === "sent").length }),
      objections: topObjections((turns.data ?? []).map((t) => (t as { content: string | null }).content ?? "")),
      unavailable: false,
    };
  } catch {
    return empty;
  }
}
