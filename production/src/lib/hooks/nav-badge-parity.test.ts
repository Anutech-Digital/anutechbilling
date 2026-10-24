import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAV_BADGE_KEYS } from "./nav-badge-counts";
import { NAV_BADGE_VIEWS, shownBadge } from "./nav-badge-views";
import { ENQUIRY_FOLDERS, PAGE_CHOICES } from "@/lib/navigation/drilldown";
import { groupTasks, taskTabCounts } from "@/components/features/tasks/task-groups";
import { TASK_OPEN_STATUSES } from "@/lib/queries/tasks";
import { RENEWAL_EXCLUDED_STATUS, RENEWAL_URGENT_DAYS, daysUntilRenewal, onRenewalsPage, renewalBucket } from "@/lib/renewals/buckets";
import { INVOICE_OWED_STATUSES, invoiceInFocus } from "@/lib/invoices/kpis";
import { QUOTE_TO_INVOICE_PAYMENT_STATUS, quoteInFocus } from "@/lib/quotes/focus";
import { INBOX_HIDDEN_STATUSES, MAIL_FOLDERS, inboxUnread } from "@/lib/inbound/folders";
import { REPLY_PREFIX } from "@/lib/inbound/threads";

/* R-1541 (audit 18 Oct 2026): six sidebar badges counted one thing and opened a page showing
   another. Each badge now counts what still needs doing and its click opens the view that
   lists exactly those rows (nav-badge-views.ts). This file holds the three parts together:
   the badge's link, the page's own predicate over fixture rows, and the SQL in nav_badges(). */

function latestNavBadgesSql(): string {
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const hits = files.filter((f) => /function\s+public\.nav_badges\s*\(/i.test(readFileSync(join(dir, f), "utf8")));
  return readFileSync(join(dir, hits[hits.length - 1]), "utf8");
}
const SQL = latestNavBadgesSql();
function countSql(key: string): string {
  const m = SQL.match(new RegExp(`^\\s*'${key}',\\s*(.*)$`, "m"));
  if (!m) throw new Error(`nav_badges() returns no '${key}'`);
  return m[1];
}
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();

describe("R-1541: every badge opens a view the page understands", () => {
  it("each nav_badges() key has a view", () => {
    expect(Object.keys(NAV_BADGE_VIEWS).sort()).toEqual([...NAV_BADGE_KEYS].sort());
  });

  it("each view's ?key=value is one the page reads (PAGE_CHOICES)", () => {
    for (const key of NAV_BADGE_KEYS) {
      const url = new URL(NAV_BADGE_VIEWS[key].href, "http://x");
      const choices = PAGE_CHOICES[url.pathname];
      for (const [k, v] of url.searchParams) {
        expect(choices?.[k], `${key}: ${url.pathname} reads ?${k}=`).toBeDefined();
        expect(choices[k]).toContain(v);
      }
    }
  });

  it("the old links are gone: tasks, renewals, invoices, enquiries, payments, quotes open their filtered view", () => {
    expect(NAV_BADGE_VIEWS.tasks.href).toBe("/tasks?tab=overdue");
    expect(NAV_BADGE_VIEWS.renewals.href).toBe("/renewals?bucket=urgent");
    expect(NAV_BADGE_VIEWS.invoices.href).toBe("/invoices?focus=unpaid");
    expect(NAV_BADGE_VIEWS.enquiries.href).toBe("/enquiries?folder=inbox");
    expect(NAV_BADGE_VIEWS.payments.href).toBe("/quotes?focus=to-invoice");
    expect(NAV_BADGE_VIEWS.quotes.href).toBe("/quotes?approvals=mine");
  });

  it("hover says what the number means", () => {
    expect(shownBadge("invoices", "12", "owner")).toEqual({ text: "12", href: "/invoices?focus=unpaid", title: "12 unpaid invoices" });
    expect(shownBadge("tasks", "1", "sales")?.title).toBe("1 overdue task");
  });

  it("no badge for a role that cannot open its view (Payments' view is on Quotes)", () => {
    expect(shownBadge("payments", "3", "billing")).toBeNull();
    expect(shownBadge("payments", "3", "accountant")).toBeNull();
    expect(shownBadge("payments", "3", "owner")?.href).toBe("/quotes?focus=to-invoice");
    expect(shownBadge("invoices", undefined, "owner")).toBeNull();
    expect(shownBadge("support", "2", "owner")).toBeNull();
  });
});

/* ── Fixtures: each badge's count == the rows its view lists ─────────────────────────────
   The SAME rows are seeded in supabase/tests/nav_badges.test.sql, where nav_badges() must
   return the numbers asserted here. */
const NOW = new Date("2026-10-18T06:30:00Z"); // 12:00 IST

describe("R-1541: tasks — badge == /tasks?tab=overdue", () => {
  const rows = [
    { status: "pending" as const, due_at: "2026-10-16T06:30:00Z" },   // overdue
    { status: "snoozed" as const, due_at: "2026-10-18T05:30:00Z" },   // overdue — 11:00 IST today, passed
    { status: "pending" as const, due_at: "2026-10-18T12:00:00Z" },   // today, not yet due — no
    { status: "pending" as const, due_at: "2026-10-21T06:30:00Z" },   // upcoming — no
    { status: "pending" as const, due_at: null },                     // no date — no
    { status: "done" as const, due_at: "2026-10-16T06:30:00Z" },      // done — no
    { status: "cancelled" as const, due_at: "2026-10-16T06:30:00Z" }, // cancelled — no
  ];
  it("the page's Overdue tab holds 2", () => {
    expect(taskTabCounts(groupTasks(rows, NOW)).overdue).toBe(2);
  });
  it("SQL: open statuses, due time passed, own tenant (the page reads tenant_id = mine)", () => {
    const sql = countSql("tasks");
    expect(quoted(sql.match(/t\.status in \(([^)]*)\)/)?.[1] ?? "")).toEqual([...TASK_OPEN_STATUSES].sort());
    expect(sql).toMatch(/t\.due_at < v_now/);
    expect(sql).toMatch(/t\.tenant_id = v_tenant/);
  });
});

describe("R-1541: renewals — badge == /renewals?bucket=urgent", () => {
  const today = NOW;
  const rows = [
    { status: "active", renewal_date: "2026-10-25" },     // +7 → urgent
    { status: "paused", renewal_date: "2026-10-20" },     // any status but cancelled → urgent
    { status: "expired", renewal_date: "2026-10-01" },    // lapsed → urgent
    { status: "active", renewal_date: "2026-10-26" },     // +8 → upcoming, no
    { status: "cancelled", renewal_date: "2026-10-19" },  // cancelled — no
    { status: "active", renewal_date: null },             // no date — no
  ];
  it("the page's Urgent tab holds 3", () => {
    const urgent = rows.filter(onRenewalsPage).filter((r) => renewalBucket(daysUntilRenewal(r.renewal_date!, today)) === "urgent");
    expect(urgent.length).toBe(3);
  });
  it("SQL: not cancelled, has a date, within RENEWAL_URGENT_DAYS of the IST today", () => {
    const sql = countSql("renewals");
    expect(sql).toContain(`s.status <> '${RENEWAL_EXCLUDED_STATUS}'`);
    expect(sql).toMatch(/s\.renewal_date is not null/);
    expect(sql).toContain(`s.renewal_date <= v_today + ${RENEWAL_URGENT_DAYS}`);
    expect(SQL).toMatch(/v_today\s+date := \(now\(\) at time zone 'Asia\/Kolkata'\)::date/);
  });
});

describe("R-1541: invoices — badge == /invoices?focus=unpaid", () => {
  const rows = [
    { status: "pending", due_date: "2026-10-10", amount: 1000, net_payable: 1000, paid_amount: 0 },   // yes
    { status: "overdue", due_date: "2026-10-10", amount: 1000, net_payable: null, paid_amount: 400 }, // yes — part paid
    { status: "pending", due_date: "2026-10-10", amount: 1000, net_payable: 600, paid_amount: 600 },  // settled — no
    { status: "paid", due_date: "2026-10-10", amount: 1000, net_payable: 1000, paid_amount: 1000 },   // no
    { status: "void", due_date: "2026-10-10", amount: 1000, net_payable: 1000, paid_amount: 0 },      // no
    { status: "draft", due_date: "2026-10-10", amount: 1000, net_payable: 1000, paid_amount: 0 },     // no
    { status: "pending", due_date: "2026-10-10", amount: 1000, net_payable: 1000, paid_amount: 0, written_off_at: "2026-10-20T00:00:00Z" }, // R-1635 written off — no
  ];
  it("the Outstanding focus holds 2", () => {
    expect(rows.filter((r) => invoiceInFocus(r, "unpaid", NOW)).length).toBe(2);
  });
  it("SQL: owed statuses with a balance left", () => {
    const sql = countSql("invoices");
    expect(quoted(sql.match(/i\.status in \(([^)]*)\)/)?.[1] ?? "")).toEqual([...INVOICE_OWED_STATUSES].sort());
    expect(sql).toMatch(/coalesce\(i\.net_payable, i\.amount\) - coalesce\(i\.paid_amount, 0\) > 0/);
    expect(sql, "R-1635: a written-off invoice is not unpaid").toMatch(/i\.written_off_at is null/);
  });
});

describe("R-1541: payments — badge == /quotes?focus=to-invoice", () => {
  it("the focus and the SQL use the same payment_status", () => {
    expect(quoteInFocus({ status: "accepted", payment_status: QUOTE_TO_INVOICE_PAYMENT_STATUS }, "to-invoice")).toBe(true);
    expect(quoteInFocus({ status: "accepted", payment_status: "partial" }, "to-invoice")).toBe(false);
    expect(countSql("payments")).toContain(`q.payment_status = '${QUOTE_TO_INVOICE_PAYMENT_STATUS}'`);
  });
});

describe("R-1541: enquiries — badge == the Inbox's unread conversations", () => {
  const base = { lead_id: null, starred: false, snoozed_until: null, archived_at: null };
  const nowISO = NOW.toISOString();
  const rows = [
    { ...base, id: "1", status: "received", from_email: "a@x.in", subject: "Quote please", created_at: "2026-10-17T01:00:00Z", read_at: null },
    { ...base, id: "2", status: "received", from_email: " A@x.in ", subject: "Re: Fwd:  quote  please", created_at: "2026-10-17T02:00:00Z", read_at: "2026-10-17T03:00:00Z" }, // same thread
    { ...base, id: "3", status: "lead_created", from_email: "b@x.in", subject: "Hi", created_at: "2026-10-17T01:00:00Z", read_at: null },                  // unread, own thread
    { ...base, id: "4", status: "received", from_email: "c@x.in", subject: "Read", created_at: "2026-10-17T01:00:00Z", read_at: "2026-10-17T02:00:00Z" }, // read — no
    { ...base, id: "5", status: "received", from_email: "d@x.in", subject: "Done", created_at: "2026-10-17T01:00:00Z", read_at: null, archived_at: "2026-10-17T02:00:00Z" }, // archived — no
    { ...base, id: "6", status: "received", from_email: "e@x.in", subject: "Later", created_at: "2026-10-17T01:00:00Z", read_at: null, snoozed_until: "2026-10-19T03:30:00Z" }, // snoozed — no
    { ...base, id: "7", status: "skipped_non_enquiry", from_email: "f@x.in", subject: "Newsletter", created_at: "2026-10-17T01:00:00Z", read_at: null }, // spam — no
    { ...base, id: "8", status: "reply_sent", from_email: "us@x.in", subject: "Re: Hi", created_at: "2026-10-17T01:00:00Z", read_at: null },             // our reply — no
    { ...base, id: "9", status: "received", from_email: null, subject: "Quote please", created_at: "2026-10-17T01:00:00Z", read_at: null },               // no sender: own thread
    { ...base, id: "10", status: "received", from_email: "", subject: "Quote please", created_at: "2026-10-17T01:00:00Z", read_at: null },                // no sender: own thread
    { ...base, id: "11", status: "received", from_email: "g@x.in", subject: "Snooze over", created_at: "2026-10-17T01:00:00Z", read_at: null, snoozed_until: "2026-10-18T05:30:00Z" }, // snooze over: back, counts
  ];
  it("the Inbox's red number is 5", () => {
    expect(inboxUnread(rows, nowISO)).toBe(5);
  });
  it("?folder= lists the page's folders", () => {
    expect([...ENQUIRY_FOLDERS]).toEqual(MAIL_FOLDERS.map((f) => f.id));
  });
  it("SQL: same hidden statuses, same Re:/Fwd: prefixes, grouped by sender + subject", () => {
    const m = SQL.match(/e\.status not in \(([^)]*)\)/);
    expect(quoted(m?.[1] ?? "")).toEqual([...INBOX_HIDDEN_STATUSES].sort());
    const alternation = REPLY_PREFIX.source.match(/\(([a-z|]+)\)/)?.[1];
    expect(SQL).toContain(`(${alternation})`);
    expect(SQL).toMatch(/e\.archived_at is null/);
    expect(SQL).toMatch(/e\.snoozed_until is null or e\.snoozed_until <= v_now/);
    expect(SQL).toMatch(/having bool_or\(m\.read_at is null\)/);
    expect(countSql("enquiries")).toMatch(/^v_enquiries,/);
  });
});

describe("R-1541: quotes — badge == /quotes?approvals=mine", () => {
  it("the Quotes page reads ?approvals= into its approvals filter", () => {
    const page = readFileSync(join(process.cwd(), "src", "app", "(app)", "quotes", "page.tsx"), "utf8");
    expect(page).toMatch(/useUrlChoice<[^>]*>\("approvals", QUOTE_APPROVALS, ""\)/);
    expect(page).toMatch(/const onlyMyApprovals = approvalsParam === "mine"/);
  });
  it("the SQL keeps the approvals rule (pending, tiers passed in, never my own request)", () => {
    expect(SQL).toMatch(/q\.approval_status = 'pending'/);
    expect(SQL).toMatch(/q\.approval_requested_by <> v_me/);
    expect(countSql("quotes")).toMatch(/^v_quotes/);
  });
});

describe("nav_badges() stays SECURITY INVOKER and fails closed (CLAUDE.md §17c)", () => {
  it("invoker, no workspace → error, authenticated only", () => {
    expect(SQL).toMatch(/security invoker/);
    expect(SQL).not.toMatch(/security definer/i);
    expect(SQL).toMatch(/raise exception 'nav_badges: no workspace/);
    expect(SQL).toMatch(/revoke all on function public\.nav_badges\(text\[\]\) from anon/);
    expect(SQL).toMatch(/grant execute on function public\.nav_badges\(text\[\]\) to authenticated/);
  });
});
