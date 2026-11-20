/**
 * Every MCP tool: success, permission denied, cross-tenant blocked, and the write switch.
 * Runs through runTool (the same gate /api/mcp uses), so the audit row is checked too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USER_ROLES, type UserRole } from "@/lib/auth/roles";
import { resetRateLimiter } from "@/lib/security/rate-limit";
import { runTool } from "@/lib/mcp/server";
import { READ_TOOLS, WRITE_TOOLS, toolsFor } from "@/lib/mcp/tools";
import { deniedReason, type McpToolDef } from "@/lib/mcp/tools/types";
import { B_MARK, CUST_A, CUST_B, TASK_A, TASK_B, ctxFor } from "@/lib/mcp/__tests__/seed";

const READ_INPUT: Record<string, Record<string, unknown>> = {
  get_today_queue: {},
  get_dashboard_summary: { period: "this_fy" },
  list_unmatched_bank_entries: {},
  get_pnl_summary: { period: "this_fy" },
  list_staff: {},
  get_attendance_summary: {},
  get_salary_summary: { month: "2026-10" },
  list_support_tickets: {},
  search: { query: "Acme" },
  list_leads: {},
  get_lead: { id: "L-A1" },
  list_enquiries: {},
  list_deals: {},
  list_tasks: { everyone: true },
  list_customers: {},
  get_customer: { id: CUST_A },
  list_quotes: {},
  get_quote: { id: "Q-A1" },
  list_invoices: { status: "unpaid" },
  get_invoice: { id: "INV-A1" },
  list_payments: {},
  list_subscriptions: {},
  list_renewals: { due_within_days: 30 },
};

/** Same call aimed at company B's records (ids / text). Lists keep their own input. */
const CROSS_INPUT: Record<string, Record<string, unknown>> = {
  get_lead: { id: "L-B1" },
  get_customer: { id: CUST_B },
  get_quote: { id: "Q-B1" },
  get_invoice: { id: "INV-B1" },
  search: { query: "B-ONLY" },
  list_leads: { search: "B-ONLY" },
};

const WRITE_INPUT: Record<string, Record<string, unknown>> = {
  add_lead: { company: "New Co Pvt Ltd", contact_name: "Neha" },
  update_lead_status: { id: "L-A1", stage: "trial" },
  add_lead_note: { id: "L-A1", note: "Asked for a demo on Monday" },
  create_task: { title: "Send proposal", due_date: "2026-11-21", due_time: "11:00", lead_id: "L-A1" },
  complete_task: { id: TASK_A },
  set_followup_reminder: { lead_id: "L-A1", date: "2026-11-22", time: "10:30" },
  add_support_ticket_note: { ticket_id: "T-A1", note: "Checked MX records" },
};

const WRITE_CROSS: Record<string, Record<string, unknown>> = {
  update_lead_status: { id: "L-B1", stage: "trial" },
  add_lead_note: { id: "L-B1", note: "x" },
  complete_task: { id: TASK_B },
  set_followup_reminder: { lead_id: "L-B1", date: "2026-11-22" },
  add_support_ticket_note: { ticket_id: "T-B1", note: "x" },
  create_task: { title: "x task", due_date: "2026-11-21", lead_id: "L-B1" },
};

/** A role this tool refuses — the most privileged one that is still refused; 'personal' always is. */
function deniedRole(tool: McpToolDef): UserRole {
  const order: UserRole[] = ["manager", "billing", "accountant", "sales_senior", "sales", "support", "delivery", "marketing", "partner_agent", "personal"];
  return order.find((r) => deniedReason(r, tool) !== null) ?? "personal";
}

const textOf = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

beforeEach(() => {
  resetRateLimiter();
  process.env.MCP_ENABLED = "true";
  process.env.MCP_WRITE_ENABLED = "true";
});
afterEach(() => {
  delete process.env.MCP_ENABLED;
  delete process.env.MCP_WRITE_ENABLED;
});

describe("tool list", () => {
  it("has every tool the brief names, each with a sample input", () => {
    const names = [...READ_TOOLS, ...WRITE_TOOLS].map((t) => t.name).sort();
    expect(names).toEqual([...Object.keys(READ_INPUT), ...Object.keys(WRITE_INPUT)].sort());
  });

  it("never offers a tool whose name suggests a forbidden action", () => {
    for (const t of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(t.name).not.toMatch(/delete|send|email|whatsapp|refund|gst_setting|role|password|vault|telecall|invoice_edit|record_payment|quote_draft|convert/);
    }
  });

  it("every tool strict-rejects unknown fields and pages are capped at 50", () => {
    for (const t of [...READ_TOOLS, ...WRITE_TOOLS]) {
      expect(t.input.safeParse({ ...(READ_INPUT[t.name] ?? WRITE_INPUT[t.name]), idempotency_key: "k-12345678", surprise: 1 }).success).toBe(false);
      if ("limit" in t.input.shape) expect(t.input.safeParse({ ...(READ_INPUT[t.name] ?? {}), limit: 51 }).success).toBe(false);
    }
  });
});

describe.each(READ_TOOLS.map((t) => [t.name, t] as const))("read tool %s", (name, tool) => {
  it("succeeds for the owner and writes an ok audit row", async () => {
    const ctx = ctxFor("owner");
    const r = await runTool(ctx, tool, READ_INPUT[name]);
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(JSON.parse(textOf(r).split("\n").pop()!)).toBeTruthy();
    expect(ctx.db.tables.mcp_audit_log.at(-1)).toMatchObject({ tool: name, status: "ok", user_id: ctx.userId, tenant_id: ctx.tenantId });
  });

  it("is refused for a role that cannot open its page, with an audit row", async () => {
    const role = deniedRole(tool);
    const ctx = ctxFor(role);
    const r = await runTool(ctx, tool, READ_INPUT[name]);
    expect(r.isError).toBe(true);
    expect(ctx.db.calls.filter((c) => !c.startsWith("insert:mcp_audit_log"))).toEqual([]);
    expect(ctx.db.tables.mcp_audit_log.at(-1)).toMatchObject({ tool: name, status: "denied" });
  });

  it("never returns another company's data", async () => {
    const ctx = ctxFor("owner");
    const r = await runTool(ctx, tool, CROSS_INPUT[name] ?? READ_INPUT[name]);
    expect(textOf(r)).not.toContain(B_MARK);
    if (name.startsWith("get_") && CROSS_INPUT[name]) expect(r.isError).toBe(true);
  });
});

describe.each(WRITE_TOOLS.map((t) => [t.name, t] as const))("write tool %s", (name, tool) => {
  const key = `test-${name}-0001`;

  it("previews without changing anything, then applies once on confirm, and replays safely", async () => {
    const ctx = ctxFor("owner");
    const before = JSON.stringify({ ...ctx.db.tables, mcp_audit_log: [], mcp_write_previews: [] });
    const p = await runTool(ctx, tool, { ...WRITE_INPUT[name], idempotency_key: key });
    expect(p.isError, textOf(p)).toBeFalsy();
    expect(JSON.stringify({ ...ctx.db.tables, mcp_audit_log: [], mcp_write_previews: [] })).toBe(before);
    expect(ctx.db.tables.mcp_audit_log.at(-1)).toMatchObject({ tool: name, status: "preview" });
    const previewId = JSON.parse(textOf(p).split("\n").pop()!).preview_id as string;

    const c = await runTool(ctx, tool, { ...WRITE_INPUT[name], idempotency_key: key, confirm: true, preview_id: previewId });
    expect(c.isError, textOf(c)).toBeFalsy();
    const audit = ctx.db.tables.mcp_audit_log.at(-1)!;
    expect(audit).toMatchObject({ tool: name, status: "ok" });
    expect(audit.after_values).not.toBeNull();
    const writes = ctx.db.calls.filter((x) => /^(insert|update|rpc):(leads|tasks|support_ticket_notes|log_lead_activity)$/.test(x));
    expect(writes.length).toBe(1);

    const again = await runTool(ctx, tool, { ...WRITE_INPUT[name], idempotency_key: key, confirm: true, preview_id: previewId });
    expect(textOf(again)).toContain("Already applied");
    expect(ctx.db.calls.filter((x) => /^(insert|update|rpc):(leads|tasks|support_ticket_notes|log_lead_activity)$/.test(x)).length).toBe(1);
  });

  it("refuses a confirm whose fields differ from the preview", async () => {
    const ctx = ctxFor("owner");
    const p = await runTool(ctx, tool, { ...WRITE_INPUT[name], idempotency_key: key });
    const previewId = JSON.parse(textOf(p).split("\n").pop()!).preview_id as string;
    const changed = { ...WRITE_INPUT[name] };
    const firstText = Object.keys(changed).find((k) => typeof changed[k] === "string" && !/id$|date|time|stage/.test(k));
    if (firstText) changed[firstText] = `${String(changed[firstText])} CHANGED`;
    else return;
    const c = await runTool(ctx, tool, { ...changed, idempotency_key: key, confirm: true, preview_id: previewId });
    expect(c.isError).toBe(true);
    expect(textOf(c)).toMatch(/differ from the preview/);
  });

  it("is refused for a role the tool does not allow", async () => {
    const ctx = ctxFor(deniedRole(tool));
    const r = await runTool(ctx, tool, { ...WRITE_INPUT[name], idempotency_key: key });
    expect(r.isError).toBe(true);
    expect(ctx.db.tables.mcp_write_previews).toHaveLength(0);
    expect(ctx.db.tables.mcp_audit_log.at(-1)).toMatchObject({ status: "denied" });
  });

  it("cannot touch another company's record", async () => {
    if (!WRITE_CROSS[name]) return;
    const ctx = ctxFor("owner");
    const r = await runTool(ctx, tool, { ...WRITE_CROSS[name], idempotency_key: key });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain(B_MARK);
    expect(ctx.db.tables.mcp_write_previews).toHaveLength(0);
  });

  it("is off when MCP_WRITE_ENABLED is off, or the connection has no write scope", async () => {
    process.env.MCP_WRITE_ENABLED = "false";
    const ctx = ctxFor("owner");
    expect(toolsFor(ctx).some((t) => t.name === name)).toBe(false);
    const r = await runTool(ctx, tool, { ...WRITE_INPUT[name], idempotency_key: key });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/switched off/);

    process.env.MCP_WRITE_ENABLED = "true";
    const readOnly = ctxFor("owner", { canWrite: false });
    expect(toolsFor(readOnly).some((t) => t.name === name)).toBe(false);
    expect((await runTool(readOnly, tool, { ...WRITE_INPUT[name], idempotency_key: key })).isError).toBe(true);
  });
});

describe("role rules from the brief", () => {
  it("P&L is owner / accountant only; salary is owner / manager only", () => {
    const pnl = READ_TOOLS.find((t) => t.name === "get_pnl_summary")!;
    const sal = READ_TOOLS.find((t) => t.name === "get_salary_summary")!;
    expect(deniedReason("owner", pnl)).toBeNull();
    for (const r of USER_ROLES.filter((x) => x !== "owner" && x !== "accountant")) expect(deniedReason(r, pnl)).not.toBeNull();
    for (const r of USER_ROLES.filter((x) => x !== "owner" && x !== "manager")) expect(deniedReason(r, sal)).not.toBeNull();
  });

  it("masks phone and email for a role without can_view_contact_details", async () => {
    const tool = READ_TOOLS.find((t) => t.name === "list_leads")!;
    const r = await runTool(ctxFor("sales"), tool, {});
    expect(textOf(r)).not.toContain("9876543210");
    expect(textOf(r)).not.toContain("ravi@acme.test");
    const o = await runTool(ctxFor("owner"), tool, {});
    expect(textOf(o)).toContain("9876543210");
  });

  it("shows GST separately: ₹10,000 ex-GST → ₹1,800 GST, CGST/SGST split on an intra-state invoice", async () => {
    const r = await runTool(ctxFor("owner"), READ_TOOLS.find((t) => t.name === "get_invoice")!, { id: "INV-A1" });
    const inv = JSON.parse(textOf(r).split("\n").pop()!);
    expect(inv.money).toMatchObject({ ex_gst: "₹10,000.00", gst: "₹1,800.00", gst_rate: "18%", total: "₹11,800.00", gst_split: "CGST ₹900.00 + SGST ₹900.00" });
    expect(inv.balance_due).toBe("₹10,000.00");
    expect(inv.status).toBe("overdue");
    expect(inv.due).toBe("15 Oct 2026");
  });

  it("rate-limits one person after 60 calls a minute", async () => {
    const ctx = ctxFor("owner");
    const tool = READ_TOOLS.find((t) => t.name === "list_staff")!;
    for (let i = 0; i < 60; i++) await runTool(ctx, tool, {});
    const r = await runTool(ctx, tool, {});
    expect(r.isError).toBe(true);
    expect(ctx.db.tables.mcp_audit_log.at(-1)).toMatchObject({ status: "rate_limited" });
  });
});
