/**
 * Two companies of test data for MCP tool tests. Everything of company B carries the marker
 * B_MARK, so a test can prove no B data reaches a company-A caller.
 */
import type { UserRole } from "@/lib/auth/roles";
import type { McpContext } from "@/lib/mcp/context";
import { fakeDb, type Tables } from "./fake-db";

export const TENANT_A = "aaaaaaaa-0000-4000-8000-000000000001";
export const TENANT_B = "bbbbbbbb-0000-4000-8000-000000000002";
export const OWNER_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
export const OWNER_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
export const CUST_A = "aaaaaaaa-0000-4000-8000-0000000000c1";
export const CUST_B = "bbbbbbbb-0000-4000-8000-0000000000c2";
export const TASK_A = "aaaaaaaa-0000-4000-8000-0000000000d1";
export const TASK_B = "bbbbbbbb-0000-4000-8000-0000000000d2";
export const EMP_A = "aaaaaaaa-0000-4000-8000-0000000000e1";
export const B_MARK = "B-ONLY-SECRET";

/** 20 Nov 2026, 11:30 IST. */
export const NOW = new Date("2026-11-20T06:00:00Z");

export function seed(): Tables {
  const both = <T extends Record<string, unknown>>(a: T, b: T) => [{ ...a, tenant_id: TENANT_A }, { ...b, tenant_id: TENANT_B }];
  return {
    leads: both(
      { id: "L-A1", company: "Acme Traders", contact_name: "Ravi", contact_phone: "9876543210", contact_email: "ravi@acme.test", stage: "quote", source: "manual", value: 10000, seats: 10, plan: "Business Starter", owner_id: OWNER_A, follow_up_date: "2026-11-20", expected_close_date: "2026-11-25", created_at: "2026-11-01T05:00:00Z", is_junk: false, lost_reason: null, pipeline: "new_logo" },
      { id: "L-B1", company: B_MARK, contact_name: B_MARK, contact_phone: "9000000000", contact_email: "b@b.test", stage: "quote", source: "manual", value: 99999, seats: 1, plan: B_MARK, owner_id: OWNER_B, follow_up_date: "2026-11-20", expected_close_date: "2026-11-25", created_at: "2026-11-01T05:00:00Z", is_junk: false, lost_reason: null, pipeline: "new_logo" },
    ),
    lead_activities: both(
      { id: "act-a", lead_id: "L-A1", kind: "call", detail: "Spoke to Ravi", created_at: "2026-11-19T05:00:00Z" },
      { id: "act-b", lead_id: "L-B1", kind: "call", detail: B_MARK, created_at: "2026-11-19T05:00:00Z" },
    ),
    inbound_emails: both(
      { id: "E-A1", from_name: "Ravi", from_email: "ravi@acme.test", subject: "Need 10 users", status: "new", route: "sales", created_at: "2026-11-19T05:00:00Z", read_at: null, archived_at: null, lead_id: null, ticket_id: null },
      { id: "E-B1", from_name: B_MARK, from_email: "b@b.test", subject: B_MARK, status: "new", route: "sales", created_at: "2026-11-19T05:00:00Z", read_at: null, archived_at: null, lead_id: null, ticket_id: null },
    ),
    tasks: both(
      { id: TASK_A, title: "Call Ravi", kind: "call", status: "pending", priority: "normal", due_at: "2026-11-19T05:00:00Z", owner_id: OWNER_A, lead_id: "L-A1", customer_id: null, notes: null },
      { id: TASK_B, title: B_MARK, kind: "call", status: "pending", priority: "normal", due_at: "2026-11-19T05:00:00Z", owner_id: OWNER_B, lead_id: "L-B1", customer_id: null, notes: null },
    ),
    customers: both(
      { id: CUST_A, name: "Acme Traders Pvt Ltd", display_name: null, customer_number: "C-001", customer_type: "business", contact_name: "Ravi", contact_email: "ravi@acme.test", contact_phone: "9876543210", city: "Delhi", state: "Delhi", gstin: "07AAACA1234A1Z5", is_active: true, since: "2025-04-01" },
      { id: CUST_B, name: B_MARK, display_name: null, customer_number: "C-001", customer_type: "business", contact_name: B_MARK, contact_email: "b@b.test", contact_phone: "9000000000", city: "Pune", state: "MH", gstin: null, is_active: true, since: "2025-04-01" },
    ),
    quotes: both(
      { id: "Q-A1", customer_id: CUST_A, customer_name: "Acme Traders Pvt Ltd", lead_id: "L-A1", status: "sent", approval_status: "approved", plan: "Business Starter", seats: 10, billing_cycle: "yearly", subtotal: 32400, tax_rate: 18, amount: 38232, created_date: "2026-11-10", expires_date: "2026-11-30", invoice_id: null, is_renewal: false, payment_status: null },
      { id: "Q-B1", customer_id: CUST_B, customer_name: B_MARK, lead_id: "L-B1", status: "sent", approval_status: "approved", plan: B_MARK, seats: 1, billing_cycle: "yearly", subtotal: 1, tax_rate: 18, amount: 1, created_date: "2026-11-10", expires_date: "2026-11-30", invoice_id: null, is_renewal: false, payment_status: null },
    ),
    invoices: both(
      { id: "INV-A1", customer_id: CUST_A, customer_name: "Acme Traders Pvt Ltd", invoice_date: "2026-10-01", due_date: "2026-10-15", status: "pending", amount: 11800, taxable_value: 10000, tax_amount: 1800, tax_rate: 18, net_payable: 11800, paid_amount: 1800, paid_date: null, document_kind: "tax_invoice", inter_state: false, written_off_at: null, created_at: "2026-10-01T05:00:00Z" },
      { id: "INV-B1", customer_id: CUST_B, customer_name: B_MARK, invoice_date: "2026-10-01", due_date: "2026-10-15", status: "pending", amount: 5900, taxable_value: 5000, tax_amount: 900, tax_rate: 18, net_payable: 5900, paid_amount: 0, paid_date: null, document_kind: "tax_invoice", inter_state: true, written_off_at: null, created_at: "2026-10-01T05:00:00Z" },
    ),
    payments: both(
      { id: "P-A1", customer_id: CUST_A, invoice_id: "INV-A1", quote_id: null, amount: 1800, method: "upi", status: "received", received_at: "2026-11-02T05:00:00Z", refunded_at: null, receipt_voucher_no: "RV-1" },
      { id: "P-B1", customer_id: CUST_B, invoice_id: "INV-B1", quote_id: null, amount: 777, method: "upi", status: "received", received_at: "2026-11-02T05:00:00Z", refunded_at: null, receipt_voucher_no: B_MARK },
    ),
    subscriptions: both(
      { id: "S-A1", customer_id: CUST_A, customer_name: "Acme Traders Pvt Ltd", plan: "Google Workspace Business Starter", vendor: "google", seats: 10, mrr: 2700, term_amount: null, status: "active", billing_cycle: "yearly", renewal_date: "2026-12-01", renewal_state: "pending", auto_renew: true, domain: "acme.test", outstanding_amount: 0 },
      { id: "S-B1", customer_id: CUST_B, customer_name: B_MARK, plan: B_MARK, vendor: "google", seats: 1, mrr: 1, term_amount: null, status: "active", billing_cycle: "yearly", renewal_date: "2026-12-01", renewal_state: "pending", auto_renew: true, domain: "b.test", outstanding_amount: 0 },
    ),
    bank_transactions: both(
      { id: "BT-A1", bank_account_id: "BA-1", txn_date: "2026-11-18", description: "NEFT ACME", credit: 5000, debit: 0, reference: "UTR1", matched_at: null, category: null },
      { id: "BT-B1", bank_account_id: "BA-2", txn_date: "2026-11-18", description: B_MARK, credit: 1, debit: 0, reference: B_MARK, matched_at: null, category: null },
    ),
    users: both(
      { id: OWNER_A, full_name: "Pardeep", email: "owner@a.test", phone: "9811111111", role: "owner", is_active: true, manager_id: null },
      { id: OWNER_B, full_name: B_MARK, email: "owner@b.test", phone: "9822222222", role: "owner", is_active: true, manager_id: null },
    ),
    employees: both(
      { id: EMP_A, name: "Asha", designation: "Sales", is_active: true },
      { id: "bbbbbbbb-0000-4000-8000-0000000000e2", name: B_MARK, designation: "Sales", is_active: true },
    ),
    attendance: both(
      { id: "AT-A1", employee_id: EMP_A, work_date: "2026-11-20", check_in: "2026-11-20T04:00:00Z", check_out: null, source: "app" },
      { id: "AT-B1", employee_id: "bbbbbbbb-0000-4000-8000-0000000000e2", work_date: "2026-11-20", check_in: "2026-11-20T04:00:00Z", check_out: null, source: "app" },
    ),
    salary_payments: both(
      { id: "SP-A1", employee_id: EMP_A, period: "2026-10", gross: 30000, net: 28200, paid_amount: 28200, paid_status: "paid", pay_date: "2026-11-01", tds: 0, pf: 1800, esi: 0, lop_amount: 0, incentive: 0 },
      { id: "SP-B1", employee_id: "bbbbbbbb-0000-4000-8000-0000000000e2", period: "2026-10", gross: 1, net: 1, paid_amount: 1, paid_status: "paid", pay_date: "2026-11-01", tds: 0, pf: 0, esi: 0, lop_amount: 0, incentive: 0 },
    ),
    support_tickets: both(
      { id: "T-A1", subject: "Mail not working", status: "open", priority: "high", category: "email", customer_id: CUST_A, customer_name: "Acme Traders Pvt Ltd", assigned_agent: OWNER_A, created_at: "2026-11-19T05:00:00Z", sla_due_at: null, resolved_at: null, channel: "email" },
      { id: "T-B1", subject: B_MARK, status: "open", priority: "high", category: "email", customer_id: CUST_B, customer_name: B_MARK, assigned_agent: OWNER_B, created_at: "2026-11-19T05:00:00Z", sla_due_at: null, resolved_at: null, channel: "email" },
    ),
    mcp_audit_log: [],
    mcp_write_previews: [],
    mcp_oauth_grants: [],
    support_ticket_notes: [],
  };
}

export function rpcHandlers() {
  return {
    today_inbox: (_a: unknown, tenant: string) => tenant === TENANT_A
      ? [{ kind: "task", id: TASK_A, title: "Call Ravi", due_at: "2026-11-19T05:00:00Z", priority: 70, href: "/tasks" }]
      : [{ kind: "task", id: TASK_B, title: B_MARK, due_at: null, priority: 99, href: "/tasks" }],
    report_pnl: (_a: unknown, tenant: string) => [{
      inv_taxable: tenant === TENANT_A ? 100000 : 1, inv_tax: 18000, revenue_count: 3, cn_taxable: 0, cn_tax: 0, dn_taxable: 0, dn_tax: 0,
      cogs: 40000, cogs_count: 2, commissions: 0, expense_groups: [{ category: "Rent", amount: 20000 }],
    }],
    log_lead_activity: () => null,
    find_lead_duplicates: () => [],
  };
}

export function ctxFor(role: UserRole, opts: { canWrite?: boolean; tables?: Tables; tenant?: string; userId?: string } = {}): McpContext & { db: ReturnType<typeof fakeDb> } {
  const tables = opts.tables ?? seed();
  const db = fakeDb(tables, opts.tenant ?? TENANT_A, { rpc: rpcHandlers() });
  return {
    userId: opts.userId ?? OWNER_A, email: "owner@a.test", tenantId: opts.tenant ?? TENANT_A, role, fullName: "Pardeep",
    grantId: "aaaaaaaa-0000-4000-8000-0000000000f9", clientName: "Claude", canWrite: opts.canWrite ?? true, db, now: NOW,
  };
}
