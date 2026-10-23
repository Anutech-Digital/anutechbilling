/**
 * R-1635 — a written-off invoice is not owed, not overdue and not chased, anywhere.
 *
 * write_off_subscription (migration 20261023184545) stamps invoices.written_off_at and leaves
 * every money column as it was (the invoice stays issued, in GST and in sales). So the
 * "still owed" rule has to read the stamp: the pure helpers below answer 0 / false for it,
 * and every query that fetches open invoices (pending / overdue) leaves it out.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { invoiceBalance, invoiceInFocus, invoiceKpis } from "@/lib/invoices/kpis";
import { invoiceIsOverdue } from "@/lib/invoices/overdue";
import { buildCollectionRows, type CollectionsInput } from "@/lib/queries/collections";

const NOW = new Date("2026-10-23T06:00:00Z");
const open = { status: "pending", amount: 11800, net_payable: 11800, paid_amount: 1800, due_date: "2026-09-15" };
const writtenOff = { ...open, written_off_at: "2026-10-23T06:00:00Z" };

describe("the shared 'still owed' rule (R-1635)", () => {
  it("an open invoice owes its balance and is overdue", () => {
    expect(invoiceAmountDue(open)).toBe(10000);
    expect(invoiceBalance(open)).toBe(10000);
    expect(invoiceIsOverdue(open, "2026-10-23")).toBe(true);
  });

  it("the same invoice written off owes nothing and is not overdue", () => {
    expect(invoiceAmountDue(writtenOff)).toBe(0);
    expect(invoiceBalance(writtenOff)).toBe(0);
    expect(invoiceIsOverdue(writtenOff, "2026-10-23")).toBe(false);
    expect(invoiceIsOverdue({ ...writtenOff, status: "overdue" }, "2026-10-23")).toBe(false);
    expect(invoiceInFocus(writtenOff, "unpaid", NOW)).toBe(false);
  });

  it("/invoices Outstanding and Overdue tiles leave it out", () => {
    const k = invoiceKpis([open, writtenOff], NOW);
    expect(k.outstanding).toBe(10000);
    expect(k.overdueTotal).toBe(10000);
    expect(k.outstandingCount).toBe(1);
  });

  it("Payment Follow-up has no row for a customer whose only invoice is written off", () => {
    const base: CollectionsInput = {
      invoices: [], subscriptions: [], quoteSubscriptions: [], invoicedQuoteIds: new Set(),
      customers: [{ id: "c1", name: "Closed Co", display_name: null, account_manager_id: null }],
      followups: [],
    };
    const inv = {
      id: "INV-1", customer_id: "c1", customer_name: "Closed Co", invoice_date: "2026-09-01", quote_id: null,
      taxable_value: 10000, tax_amount: 1800, tax_rate: 18, ...open,
    };
    expect(buildCollectionRows({ ...base, invoices: [inv] }, "2026-10-23")).toHaveLength(1);
    expect(buildCollectionRows({ ...base, invoices: [{ ...inv, written_off_at: "2026-10-23T06:00:00Z" }] }, "2026-10-23")).toHaveLength(0);
  });
});

/* ─── the scan: every open-invoice query leaves written-off invoices out ───────────────── */

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.posix.join(dir, d.name);
    if (d.isDirectory()) return d.name === "generated" ? [] : walk(p);
    return /\.tsx?$/.test(d.name) && !/\.test\.|\.spec\./.test(d.name) ? [p] : [];
  });

/** A read of open invoices (pending + overdue, or "not paid / void") with no written_off_at filter. */
function unfilteredOpenReads(src: string): number {
  let n = 0;
  for (const m of src.matchAll(/\.in\(\s*["']status["']\s*,\s*\[\s*["']pending["']\s*,\s*["']overdue["']\s*\]\s*\)|\.not\(\s*["']status["']\s*,\s*["']in["']\s*,\s*["']\(paid,void\)["']\s*\)/g)) {
    const after = src.slice(m.index! + m[0].length, m.index! + m[0].length + 120);
    if (!/^\s*\.is\(\s*["']written_off_at["']\s*,\s*null\s*\)/.test(after)) n++;
  }
  return n;
}

/** Reads that deliberately still see written-off invoices. */
const ALLOWED: Record<string, string> = {
  /* Bank matching: money that DOES come in later for a written-off invoice must still find it. */
  "src/lib/queries/bank.ts": "a recovered payment is matched to its invoice",
};

describe("open-invoice queries skip written-off invoices (R-1635 scan)", () => {
  it("the scan catches the shapes (fixtures)", () => {
    expect(unfilteredOpenReads('q.from("invoices").in("status", ["pending", "overdue"]).order("id")')).toBe(1);
    expect(unfilteredOpenReads('q.from("invoices").not("status", "in", "(paid,void)").order("id")')).toBe(1);
    expect(unfilteredOpenReads('q.from("invoices").in("status", ["pending", "overdue"]).is("written_off_at", null)')).toBe(0);
    expect(unfilteredOpenReads('q.not("status", "in", "(paid,void)")\n  .is("written_off_at", null)')).toBe(0);
  });

  it("src/: every open-invoice read filters written_off_at", () => {
    const bad = walk("src")
      .filter((f) => !ALLOWED[f])
      .filter((f) => unfilteredOpenReads(readFileSync(f, "utf8")) > 0);
    expect(bad, "reads open invoices without .is(\"written_off_at\", null) — a written-off invoice would be chased again").toEqual([]);
  });

  it("ALLOWED has no stale entries", () => {
    for (const f of Object.keys(ALLOWED)) expect(unfilteredOpenReads(readFileSync(f, "utf8")), f).toBeGreaterThan(0);
  });
});
