/**
 * R-2418 — read what the Online fee report needs (lib/razorpay/fee-report.ts does the maths):
 *   - every payment that carries a Razorpay fee (gateway_fee not null) with fee_bearer / fee_charged;
 *   - the waiver on its quote or that quote's invoice, and the customer's "We absorb" + name;
 *   - Razorpay's GSTIN from the vendor master (the same vendor fee-expense.server.ts books under).
 * And, for one Razorpay settlement, the fee_charged of the payments it settled.
 *
 * The signed-in user's own client: RLS keeps every read inside their tenant. Untyped: fee_bearer,
 * fee_charged and online_fee_* are newer than the generated types. Before the R-2416 migration
 * those columns are missing → every fee reads as "before the policy" (that is what it was).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { isOnlineFeeColumnMissing } from "@/lib/payments/online-fee";
import type { FeeReportPayment } from "@/lib/razorpay/fee-report";

type Row = Record<string, unknown>;
type Err = { code?: string; message?: string } | null;

const untyped = () => createClient() as unknown as SupabaseClient;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

const BASE_COLS = "id, received_at, customer_id, quote_id, invoice_id, gateway_fee, gateway_fee_gst";

/** Rows of `table` whose id is in `ids`; a missing online_fee column → retry with `fallbackCols`. */
async function rowsIn(db: SupabaseClient, table: string, ids: string[], cols: string, fallbackCols: string): Promise<Row[]> {
  const run = (c: string) => fetchAllRowsIn<Row, string>(ids, (chunk, from, to) =>
    db.from(table).select(c).in("id", chunk).order("id", { ascending: true }).range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>);
  try {
    return await run(cols);
  } catch (e) {
    if (isOnlineFeeColumnMissing(e as Err)) return run(fallbackCols);
    throw e;
  }
}

export interface OnlineFeeReportData {
  rows: FeeReportPayment[];
  /** Razorpay's GSTIN on the vendor master; null = no Razorpay vendor or no GSTIN on it. */
  razorpayGstin: string | null;
  /** false = the R-2416 columns are not in this database yet. */
  policyReady: boolean;
}

export function useOnlineFeeReport(enabled: boolean) {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: ["payments", "online-fee-report", tenantId],
    enabled: enabled && Boolean(tenantId),
    queryFn: async (): Promise<OnlineFeeReportData> => {
      const db = untyped();
      const page = (cols: string) => fetchAllRows<Row>((from, to) =>
        db.from("payments").select(cols).not("gateway_fee", "is", null)
          .order("received_at", { ascending: false }).order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>);
      let policyReady = true;
      let pays: Row[];
      try {
        pays = await page(`${BASE_COLS}, fee_bearer, fee_charged`);
      } catch (e) {
        if (!isOnlineFeeColumnMissing(e as Err)) throw e;
        policyReady = false;
        pays = await page(BASE_COLS);
      }

      const quoteIds = pays.map((p) => str(p.quote_id)).filter((x): x is string => !!x);
      const quotes = await rowsIn(db, "quotes", quoteIds, "id, customer_id, invoice_id, online_fee_waived", "id, customer_id, invoice_id");
      const quoteById = new Map(quotes.map((q) => [String(q.id), q]));

      const invoiceIds = [
        ...pays.map((p) => str(p.invoice_id)),
        ...quotes.map((q) => str(q.invoice_id)),
      ].filter((x): x is string => !!x);
      const invoices = await rowsIn(db, "invoices", invoiceIds, "id, customer_id, customer_name, online_fee_waived", "id, customer_id, customer_name");
      const invoiceById = new Map(invoices.map((i) => [String(i.id), i]));

      const customerOf = (p: Row): string | null => {
        const q = quoteById.get(String(p.quote_id));
        const inv = invoiceById.get(String(p.invoice_id));
        return str(q?.customer_id) ?? str(inv?.customer_id) ?? str(p.customer_id);
      };
      const customerIds = pays.map(customerOf).filter((x): x is string => !!x);
      const customers = await rowsIn(db, "customers", customerIds, "id, name, display_name, online_fee_override", "id, name, display_name");
      const customerById = new Map(customers.map((c) => [String(c.id), c]));

      const { data: vendors, error: vErr } = await db.from("vendors").select("gstin, created_at")
        .ilike("name", "%razorpay%").order("created_at", { ascending: true }).limit(5);
      if (vErr) throw vErr;
      const razorpayGstin = ((vendors ?? []) as Row[]).map((v) => str(v.gstin)?.trim() ?? "").find((g) => g) ?? null;

      const rows: FeeReportPayment[] = pays.map((p) => {
        const q = quoteById.get(String(p.quote_id));
        const invId = str(q?.invoice_id) ?? str(p.invoice_id);
        const inv = invId ? invoiceById.get(invId) : undefined;
        const cid = customerOf(p);
        const c = cid ? customerById.get(cid) : undefined;
        return {
          id: String(p.id),
          receivedAt: String(p.received_at),
          customerId: cid,
          customerName: str(c?.display_name) ?? str(c?.name) ?? str(inv?.customer_name),
          gatewayFee: num(p.gateway_fee),
          gatewayFeeGst: num(p.gateway_fee_gst),
          feeBearer: str(p.fee_bearer),
          feeCharged: num(p.fee_charged),
          billWaived: q?.online_fee_waived === true || inv?.online_fee_waived === true,
          customerAbsorbs: c?.online_fee_override === "absorb",
        };
      });
      return { rows, razorpayGstin, policyReady };
    },
  });
}

/** fee_charged of the app payments a settlement matched (null each before R-2416). */
export function useSettlementFeeCharged(paymentIds: readonly string[], enabled: boolean) {
  const ids = [...new Set(paymentIds)].sort();
  return useQuery({
    queryKey: ["payments", "fee-charged", ids.join(",")],
    enabled: enabled && ids.length > 0,
    queryFn: async (): Promise<(number | null)[]> => {
      const db = untyped();
      try {
        const rows = await rowsIn(db, "payments", ids, "id, fee_charged", "id");
        return rows.map((r) => num(r.fee_charged));
      } catch (e) {
        /* Before the R-2416 migration nothing was charged: every fee_charged is unknown. */
        if (isOnlineFeeColumnMissing(e as Err)) return ids.map(() => null);
        throw e;
      }
    },
  });
}
