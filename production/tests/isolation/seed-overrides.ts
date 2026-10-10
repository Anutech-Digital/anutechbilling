/**
 * Hand-written values for tables the generic seeder (seed.ts) cannot fill on its own —
 * usually a CHECK constraint more specific than "one of these literals". Keyed by table.
 * Add an entry when the suite reports a table as unseedable; never skip the table.
 */
import { randomUUID } from "node:crypto";

const short = () => randomUUID().replace(/-/g, "").slice(0, 8);
const phone = () => "+9198" + String(Math.floor(10_000_000 + Math.random() * 89_999_999));

export const SEED_OVERRIDES: Record<string, (tenantId: string) => Record<string, unknown>> = {
  ai_telecall_logs: () => ({ phone_number: phone() }),                  // ^\+[1-9][0-9]{7,14}$
  bank_transactions: () => ({ debit: 100, credit: 0 }),                 // debit_xor_credit
  invoice_dunning_log: () => ({ invoice_id: randomUUID(), subscription_id: null }), // exactly one subject
  join_requests: () => ({ email: `iso-${short()}@example.test` }),      // lower-case, has @
  month_close_checks: () => ({ period: "2026-04" }),                    // YYYY-MM
  seat_requests: () => ({ current_seats: 1, requested_seats: 2 }),      // must differ
  tax_payments: () => ({ kind: "gst", period: "2026-04", fy: null }),   // gst ⇔ period, else fy
  tenant_domains: () => ({ domain: `iso-${short()}.example.test` }),     // lower-case, has a dot
  whatsapp_opt_outs: () => ({ phone: phone() }),                        // ^\+[0-9]{8,15}$
};
