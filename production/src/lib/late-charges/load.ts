/**
 * R-530 — read everything the late-charge numbers need, for a set of invoices, in a handful of
 * queries (no query per invoice). Works with the signed-in browser client (RLS scopes it to
 * the tenant) and with the service client in the dunning cron (scoped by the invoice ids).
 *
 * The new tables are not in the generated Database type yet (adding tables there has collapsed
 * the whole type before — AGENTS.md L31), so the client is taken untyped and each row shape is
 * declared here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { addDaysISO, toIstDate } from "@/lib/dates/ist";
import type { InterestNoteRow } from "@/lib/credit/late-interest";
import {
  lateFeeSettingsFromRow, resolveLateFee, isGstRegistered,
  type EffectiveLateFee, type LateFeeSettings, type LevelOverride, type TenantLateFeeRow, type LateFeeLevel,
} from "./rules";
import { computeLateCharges, type LateChargeBillRow, type LateChargeView, type QuotePayment } from "./charges";

export const TENANT_LATE_FEE_COLUMNS =
  "id, late_fee_enabled, late_fee_enabled_at, late_interest_pct, late_fee_flat, late_fee_grace_days, late_interest_registered_only";

interface InvoiceRow {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string | null;
  quote_id: string | null;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
  status: string;
  due_date: string | null;
  tax_rate: number | null;
  customer_gstin: string | null;
  adjusted_advances: { payment_id?: string | null }[] | null;
}
interface OverrideRow {
  tenant_id: string;
  entity_type: "customer" | "subscription" | "invoice";
  entity_id: string;
  mode: "on" | "off";
  waived: boolean;
  waive_reason: string | null;
  updated_at: string;
}

export interface LateChargeRow {
  invoiceId: string;
  tenantId: string;
  customerId: string | null;
  customerName: string | null;
  subscriptionId: string | null;
  dueDate: string | null;
  status: string;
  settings: LateFeeSettings;
  effective: EffectiveLateFee;
  view: LateChargeView;
}

/** The bulk run looks at invoices paid within this many days (late payers settle, then get billed). */
export const PAID_LOOKBACK_DAYS = 120;

const INVOICE_COLUMNS =
  "id, tenant_id, customer_id, customer_name, quote_id, amount, net_payable, paid_amount, status, due_date, tax_rate, customer_gstin, adjusted_advances";

function overrideOf(o: OverrideRow | undefined): LevelOverride | null {
  if (!o) return null;
  return { mode: o.mode, since: toIstDate(o.updated_at), waived: o.waived, waiveReason: o.waive_reason };
}

const key = (type: string, id: string) => `${type}:${id}`;

async function loadOverrides(sb: SupabaseClient, entityIds: string[]): Promise<Map<string, OverrideRow>> {
  const rows = await fetchAllRowsIn<OverrideRow, string>(entityIds, (ids, from, to) => sb
    .from("late_fee_overrides")
    .select("tenant_id, entity_type, entity_id, mode, waived, waive_reason, updated_at")
    .in("entity_id", ids).order("entity_id").range(from, to));
  return new Map(rows.map((r) => [key(r.entity_type, r.entity_id), r]));
}

async function loadSettings(sb: SupabaseClient, tenantIds: string[]): Promise<Map<string, LateFeeSettings>> {
  const rows = await fetchAllRowsIn<TenantLateFeeRow & { id: string }, string>(tenantIds, (ids, from, to) => sb
    .from("tenants").select(TENANT_LATE_FEE_COLUMNS).in("id", ids).order("id").range(from, to));
  return new Map(rows.map((r) => [r.id, lateFeeSettingsFromRow(r, toIstDate)]));
}

/** Late charges for every chargeable invoice in scope (pending / overdue / paid, with a due date). */
export async function loadLateCharges(
  sb: SupabaseClient,
  scope: { invoiceIds?: string[]; customerId?: string; subscriptionId?: string },
  today: string,
  /** The dunning cron already holds quote → subscription (same one-per-quote rule); reuse it. */
  known: { subscriptionByQuote?: ReadonlyMap<string, string | null> } = {},
): Promise<LateChargeRow[]> {
  let quoteIds: string[] | null = null;
  if (scope.subscriptionId) {
    const { data, error } = await sb.from("subscriptions").select("quote_id").eq("id", scope.subscriptionId).maybeSingle();
    if (error) throw error;
    const q = (data as { quote_id: string | null } | null)?.quote_id;
    if (!q) return [];
    quoteIds = [q];
  }

  const base = () => sb.from("invoices").select(INVOICE_COLUMNS)
    .in("status", ["pending", "overdue", "paid"]).not("due_date", "is", null);
  let invoices: InvoiceRow[];
  if (scope.invoiceIds) {
    invoices = await fetchAllRowsIn<InvoiceRow, string>(scope.invoiceIds, (ids, from, to) => base().in("id", ids).order("id").range(from, to));
  } else if (quoteIds) {
    invoices = await fetchAllRows<InvoiceRow>((from, to) => base().in("quote_id", quoteIds!).order("id").range(from, to));
  } else if (scope.customerId) {
    invoices = await fetchAllRows<InvoiceRow>((from, to) => base().eq("customer_id", scope.customerId!).order("id").range(from, to));
  } else {
    /* The whole company (the monthly bulk run): every unpaid invoice, but only RECENTLY paid
       ones — an invoice settled a year ago has nothing new to bill, and reading every paid
       invoice ever issued would grow without bound. */
    const cutoff = addDaysISO(today, -PAID_LOOKBACK_DAYS);
    const [open, paid] = await Promise.all([
      fetchAllRows<InvoiceRow>((from, to) => sb.from("invoices").select(INVOICE_COLUMNS)
        .in("status", ["pending", "overdue"]).not("due_date", "is", null).order("id").range(from, to)),
      fetchAllRows<InvoiceRow>((from, to) => sb.from("invoices").select(INVOICE_COLUMNS)
        .eq("status", "paid").not("due_date", "is", null).gte("paid_date", cutoff).order("id").range(from, to)),
    ]);
    invoices = [...open, ...paid];
  }
  if (invoices.length === 0) return [];

  const invoiceIds = invoices.map((i) => i.id);
  const quoteIdList = invoices.map((i) => i.quote_id);
  const customerIds = invoices.map((i) => i.customer_id);

  const [settings, subs, customers, payments, notes, bills] = await Promise.all([
    loadSettings(sb, invoices.map((i) => i.tenant_id)),
    known.subscriptionByQuote
      ? Promise.resolve([] as { id: string; quote_id: string | null }[])
      : fetchAllRowsIn<{ id: string; quote_id: string | null }, string>(quoteIdList, (ids, from, to) => sb
        .from("subscriptions").select("id, quote_id").in("quote_id", ids).order("id").range(from, to)),
    fetchAllRowsIn<{ id: string; gstin: string | null }, string>(customerIds, (ids, from, to) => sb
      .from("customers").select("id, gstin").in("id", ids).order("id").range(from, to)),
    fetchAllRowsIn<{ id: string; quote_id: string; amount: number; received_at: string | null }, string>(quoteIdList, (ids, from, to) => sb
      .from("payments").select("id, quote_id, amount, received_at").in("quote_id", ids).eq("status", "received").order("id").range(from, to)),
    fetchAllRowsIn<InterestNoteRow & { invoice_id: string }, string>(invoiceIds, (ids, from, to) => sb
      .from("debit_notes").select("invoice_id, amount, taxable_value, notes").in("invoice_id", ids).order("id").range(from, to)),
    fetchAllRowsIn<LateChargeBillRow & { invoice_id: string }, string>(invoiceIds, (ids, from, to) => sb
      .from("late_charge_bills").select("invoice_id, fee_amount, interest_amount, gross_amount").in("invoice_id", ids).order("id").range(from, to)),
  ]);

  /* One subscription per quote, as the dunning cron reads it: two subscriptions on one quote
     is ambiguous, so neither one's switch is applied (the customer/company level decides). */
  const subByQuote = new Map<string, string | null>(known.subscriptionByQuote ?? []);
  for (const s of subs) {
    if (!s.quote_id) continue;
    subByQuote.set(s.quote_id, subByQuote.has(s.quote_id) ? null : s.id);
  }
  const subIds = [...subByQuote.values()].filter((x): x is string => Boolean(x));
  const overrides = await loadOverrides(sb, [...invoiceIds, ...subIds, ...customerIds.filter((x): x is string => Boolean(x))]);

  const gstinByCustomer = new Map(customers.map((c) => [c.id, c.gstin]));
  const paysByQuote = new Map<string, QuotePayment[]>();
  for (const p of payments) {
    if (!p.received_at) continue;
    const list = paysByQuote.get(p.quote_id) ?? [];
    list.push({ id: p.id, amount: p.amount, date: toIstDate(p.received_at) });
    paysByQuote.set(p.quote_id, list);
  }
  const group = <T extends { invoice_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.invoice_id, [...(m.get(r.invoice_id) ?? []), r]);
    return m;
  };
  const notesByInvoice = group(notes);
  const billsByInvoice = group(bills);

  return invoices.map((inv) => {
    const s = settings.get(inv.tenant_id) ?? lateFeeSettingsFromRow(null, toIstDate);
    const subscriptionId = inv.quote_id ? subByQuote.get(inv.quote_id) ?? null : null;
    const own = (type: OverrideRow["entity_type"], id: string | null) =>
      id ? overrideOf(overrides.get(key(type, id))) : null;
    const effective = resolveLateFee({
      company: { enabled: s.enabled, since: s.enabledOn },
      customer: own("customer", inv.customer_id),
      subscription: own("subscription", subscriptionId),
      invoice: own("invoice", inv.id),
    });
    const view = computeLateCharges({
      settings: s,
      effective,
      registered: isGstRegistered(inv.customer_gstin, inv.customer_id ? gstinByCustomer.get(inv.customer_id) : null),
      invoice: {
        id: inv.id, status: inv.status, due_date: inv.due_date, amount: inv.amount,
        net_payable: inv.net_payable, paid_amount: inv.paid_amount, tax_rate: inv.tax_rate,
        adjustedPaymentIds: (inv.adjusted_advances ?? []).map((a) => a.payment_id).filter((x): x is string => Boolean(x)),
      },
      payments: inv.quote_id ? paysByQuote.get(inv.quote_id) ?? [] : [],
      bills: billsByInvoice.get(inv.id) ?? [],
      debitNotes: notesByInvoice.get(inv.id) ?? [],
      today,
    });
    return {
      invoiceId: inv.id, tenantId: inv.tenant_id, customerId: inv.customer_id, customerName: inv.customer_name,
      subscriptionId, dueDate: inv.due_date, status: inv.status, settings: s, effective, view,
    };
  });
}

export interface LateFeeLevelState {
  level: Exclude<LateFeeLevel, "company">;
  /** This level's own choice. */
  mode: "default" | "on" | "off";
  waived: boolean;
  waiveReason: string | null;
  /** What actually applies here, with where it comes from. */
  effective: EffectiveLateFee;
  settings: LateFeeSettings;
}

/** The switch on a customer, subscription or invoice page: its own mode + the effective state. */
export async function loadLateFeeLevel(
  sb: SupabaseClient,
  tenantId: string,
  level: Exclude<LateFeeLevel, "company">,
  id: string,
): Promise<LateFeeLevelState> {
  let customerId: string | null = null;
  let subscriptionId: string | null = null;
  let invoiceId: string | null = null;
  if (level === "customer") customerId = id;
  if (level === "subscription") {
    const { data, error } = await sb.from("subscriptions").select("id, customer_id").eq("id", id).maybeSingle();
    if (error) throw error;
    subscriptionId = id;
    customerId = (data as { customer_id: string | null } | null)?.customer_id ?? null;
  }
  if (level === "invoice") {
    const { data, error } = await sb.from("invoices").select("id, customer_id, quote_id").eq("id", id).maybeSingle();
    if (error) throw error;
    const row = data as { customer_id: string | null; quote_id: string | null } | null;
    invoiceId = id;
    customerId = row?.customer_id ?? null;
    if (row?.quote_id) {
      const { data: subs, error: e2 } = await sb.from("subscriptions").select("id").eq("quote_id", row.quote_id);
      if (e2) throw e2;
      const list = (subs ?? []) as { id: string }[];
      subscriptionId = list.length === 1 ? list[0].id : null;
    }
  }

  const { data: me, error: meErr } = await sb.from("tenants").select(TENANT_LATE_FEE_COLUMNS).eq("id", tenantId).maybeSingle();
  if (meErr) throw meErr;
  const settings = lateFeeSettingsFromRow(me as TenantLateFeeRow | null, toIstDate);
  const overrides = await loadOverrides(sb, [customerId, subscriptionId, invoiceId].filter((x): x is string => Boolean(x)));
  const own = (type: OverrideRow["entity_type"], x: string | null) => (x ? overrideOf(overrides.get(key(type, x))) : null);
  const chain = {
    company: { enabled: settings.enabled, since: settings.enabledOn },
    customer: own("customer", customerId),
    subscription: own("subscription", subscriptionId),
    invoice: own("invoice", invoiceId),
  };
  const mine = chain[level];
  return {
    level,
    mode: mine?.mode ?? "default",
    waived: mine?.waived ?? false,
    waiveReason: mine?.waiveReason ?? null,
    effective: resolveLateFee(chain),
    settings,
  };
}
