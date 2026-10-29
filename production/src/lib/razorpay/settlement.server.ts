/**
 * R-2099 — "Razorpay settlement" for one bank credit: find the settlement, read what it carried,
 * match it to the app's payments, and (on Reconcile) hand the plan to the database.
 *
 * Keys: the company's own Razorpay keys (Settings → Integrations → Razorpay, tenant_secrets,
 * sealed — read with the service role, never sent to the browser). The platform company alone
 * may fall back to the env pair (platformEnvRazorpayKeys, R-1923) — never another company,
 * or it would read the platform's Razorpay account.
 *
 * Every app read uses the signed-in user's own client (RLS keeps it inside their company);
 * the service role is used only to read the sealed keys.
 */
import type { createAdminClient, createClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { rupee } from "@/lib/utils";
import { platformEnvRazorpayKeys } from "@/lib/checkout/platform-razorpay";
import {
  buildSettlementPlan, pickSettlement, type AppPayment, type BankLine, type RzpSettlement, type SettlementLookup,
} from "./settlement-match";
import {
  listSettlements, razorpayGetter, RazorpayApiError, settlementItems, settlementWindow, type RazorpayCreds,
} from "./settlement-api.server";

type UserDb = ReturnType<typeof createClient>;
type AdminDb = ReturnType<typeof createAdminClient>;

export type { SettlementLookup };

export const NO_KEYS_MESSAGE = "Add your Razorpay API key in Settings → Integrations to fetch settlements from Razorpay.";


export async function loadSettlementKeys(
  admin: AdminDb,
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<RazorpayCreds | null> {
  const { data } = await admin
    .from("tenant_secrets")
    .select("razorpay_key_id, razorpay_key_secret")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const s = decryptTenantSecrets(data);
  if (s?.razorpay_key_id && s.razorpay_key_secret) return { keyId: s.razorpay_key_id, keySecret: s.razorpay_key_secret };
  const env2 = platformEnvRazorpayKeys(tenantId, env);
  return env2 ? { keyId: env2.keyId, keySecret: env2.keySecret } : null;
}

interface PayRow {
  id: string; reference: string | null; amount: number; credit_applied: number | null; status: string;
  received_at: string; quote_id: string | null; customer_id: string | null; bank_txn_id: string | null;
}

const PAY_COLS = "id, reference, amount, credit_applied, status, received_at, quote_id, customer_id, bank_txn_id";

async function toAppPayments(db: UserDb, tenantId: string, rows: PayRow[]): Promise<AppPayment[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const { data: lines } = await db
    .from("bank_transactions")
    .select("matched_to_id")
    .eq("tenant_id", tenantId)
    .eq("matched_to_type", "payment")
    .in("matched_to_id", ids);
  const matched = new Set(((lines ?? []) as { matched_to_id: string | null }[]).map((l) => l.matched_to_id));
  const custIds = [...new Set(rows.map((r) => r.customer_id).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, string>();
  if (custIds.length) {
    const { data: cs } = await db.from("customers").select("id, name").eq("tenant_id", tenantId).in("id", custIds);
    for (const c of (cs ?? []) as { id: string; name: string | null }[]) names.set(c.id, c.name ?? "");
  }
  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    amount: Number(r.amount) || 0,
    credit_applied: Number(r.credit_applied) || 0,
    status: r.status,
    received_at: r.received_at,
    quote_id: r.quote_id,
    customer_name: r.customer_id ? names.get(r.customer_id) ?? null : null,
    banked: Boolean(r.bank_txn_id) || matched.has(r.id),
  }));
}

function fail(what: string, error: { message: string } | null): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

export async function loadSettlementPlan(args: {
  db: UserDb;
  admin: AdminDb;
  tenantId: string;
  txnId: string;
  settlementId?: string | null;
  picks?: Record<string, string>;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<SettlementLookup> {
  const { db, tenantId } = args;

  const { data: lineRow, error: lineErr } = await db
    .from("bank_transactions")
    .select("id, credit, txn_date, reference, description, matched_to_type")
    .eq("tenant_id", tenantId)
    .eq("id", args.txnId)
    .maybeSingle();
  fail("bank line", lineErr);
  if (!lineRow) return { state: "error", message: "Bank line not found — refresh the page and try again." };
  const lr = lineRow as BankLine & { matched_to_type: string | null };
  if (!(Number(lr.credit) > 0)) return { state: "error", message: "Only a money-in line can be a Razorpay settlement." };
  if (lr.matched_to_type) return { state: "error", message: "This bank line is already reconciled. Un-reconcile it first if it was matched wrongly." };
  const line: BankLine = { id: lr.id, credit: Number(lr.credit), txn_date: lr.txn_date, reference: lr.reference, description: lr.description ?? "" };

  const creds = await loadSettlementKeys(args.admin, tenantId, args.env);
  if (!creds) return { state: "no_keys", message: NO_KEYS_MESSAGE };
  const get = razorpayGetter(creds, args.fetchImpl);

  let settlement: RzpSettlement;
  let items;
  try {
    const { from, to } = settlementWindow(line.txn_date);
    const all = await listSettlements(get, from, to);
    if (args.settlementId) {
      const s = all.find((x) => x.id === args.settlementId);
      if (!s) return { state: "not_found", message: `Settlement ${args.settlementId} is not in Razorpay around ${line.txn_date}. Fetch again.` };
      settlement = s;
    } else {
      const pick = pickSettlement(line, all);
      if (pick.kind === "none") {
        return {
          state: "not_found",
          message: `No Razorpay settlement of ${rupee(line.credit)} found between 4 days before and 1 day after ${line.txn_date}. Check that Settings → Integrations has the key of the Razorpay account that paid this line.`,
        };
      }
      if (pick.kind === "many") {
        return {
          state: "many",
          message: "More than one Razorpay settlement has this amount — pick the one with this line's UTR.",
          options: pick.options.map((o) => ({ id: o.id, amount: Math.round(o.amount / 100), utr: o.utr, createdAt: o.created_at })),
        };
      }
      settlement = pick.settlement;
    }
    items = await settlementItems(get, settlement);
  } catch (e) {
    if (e instanceof RazorpayApiError) return { state: "error", message: e.message };
    throw e;
  }

  /* The app's side: by Razorpay payment id (the webhook's reference), by order id, and a pool
     to pick from for anything not found. */
  const refs = [...new Set(items.flatMap((i) => [i.type === "payment" ? i.entity_id : null, i.type === "refund" ? i.payment_id ?? null : null]).filter((x): x is string => Boolean(x)))];
  let refRows: PayRow[] = [];
  for (let i = 0; i < refs.length; i += 200) {
    const { data, error } = await db.from("payments").select(PAY_COLS).eq("tenant_id", tenantId).in("reference", refs.slice(i, i + 200));
    fail("payments", error);
    refRows = refRows.concat((data ?? []) as unknown as PayRow[]);
  }

  const found = new Set(refRows.map((r) => r.reference));
  const orderIds = [...new Set(items.filter((i) => i.type === "payment" && !found.has(i.entity_id) && i.order_id).map((i) => i.order_id as string))];
  const byOrder: Record<string, AppPayment[]> = {};
  if (orderIds.length) {
    const { data: qs, error: qErr } = await db.from("quotes").select("id, payment_reference").eq("tenant_id", tenantId).in("payment_reference", orderIds);
    fail("quotes", qErr);
    const quotes = (qs ?? []) as { id: string; payment_reference: string }[];
    if (quotes.length) {
      const { data: ps, error: pErr } = await db.from("payments").select(PAY_COLS).eq("tenant_id", tenantId).in("quote_id", quotes.map((q) => q.id));
      fail("payments", pErr);
      const apps = await toAppPayments(db, tenantId, (ps ?? []) as unknown as PayRow[]);
      for (const q of quotes) byOrder[q.payment_reference] = apps.filter((p) => p.quote_id === q.id);
    }
  }

  const fromIso = new Date((settlement.created_at - 20 * 86_400) * 1000).toISOString();
  const toIso = new Date((settlement.created_at + 2 * 86_400) * 1000).toISOString();
  const { data: poolRows, error: poolErr } = await db
    .from("payments")
    .select(PAY_COLS)
    .eq("tenant_id", tenantId)
    .eq("status", "received")
    .is("bank_txn_id", null)
    .gte("received_at", fromIso)
    .lte("received_at", toIso)
    .order("received_at", { ascending: true })
    .limit(500);
  fail("payments", poolErr);

  const plan = buildSettlementPlan({
    line,
    settlement,
    items,
    byReference: await toAppPayments(db, tenantId, refRows),
    byOrder,
    pool: await toAppPayments(db, tenantId, (poolRows ?? []) as unknown as PayRow[]),
    picks: args.picks,
  });
  return { state: "plan", plan };
}
