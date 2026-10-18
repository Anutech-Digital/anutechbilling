/**
 * R-118 — a tile's link must land on a list that shows the same records.
 *
 * Three ways that silently breaks, each pinned here:
 *   1. a DRILL entry names a tab the target page does not accept → the page falls back to
 *      "All" and the owner sees more rows than the tile counted;
 *   2. a page stops reading its tab from the URL (someone swaps useUrlChoice back to useState);
 *   3. the lead smart views drift from LEAD_VIEWS.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRILL, PAGE_CHOICES, LEAD_VIEWS, drillHref, type DrillName } from "./drilldown";
import { pickChoice, withChoice } from "@/lib/hooks/use-url-choice";
import { summarizeDealStrip, wonDate, type DealRow } from "@/lib/deals/pipeline-summary";
import { wonThisMonth } from "@/lib/leads/list-selectors";

const SRC = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("every drill-down targets a tab its page accepts", () => {
  for (const [name, d] of Object.entries(DRILL)) {
    it(name, () => {
      const allowed = PAGE_CHOICES[d.path]?.[d.key];
      expect(allowed, `${d.path} does not read ?${d.key}=`).toBeDefined();
      expect(allowed).toContain(d.value);
    });
  }

  it("drillHref builds the link", () => {
    expect(drillHref("dealsWonMonth")).toBe("/deals?view=won-mtd");
    expect(drillHref("invoicesOverdue")).toBe("/invoices?tab=overdue");
  });
});

describe("list pages read their tab from the URL", () => {
  const PAGES: Array<[string, string, string]> = [
    ["app/(app)/leads/page.tsx", "view", "LEAD_VIEWS"],
    ["app/(app)/quotes/page.tsx", "tab", "QUOTE_TABS"],
    ["app/(app)/invoices/page.tsx", "tab", "INVOICE_TABS"],
    ["app/(app)/subscriptions/page.tsx", "tab", "SUBSCRIPTION_TABS"],
    ["app/(app)/tasks/page.tsx", "tab", "TASK_TABS"],
    ["app/(app)/renewals/page.tsx", "bucket", "RENEWAL_BUCKETS"],
    ["app/(app)/customers/page.tsx", "view", "CUSTOMER_VIEWS"],
    ["app/(app)/payments/page.tsx", "tab", "PAYMENT_TABS"],
  ];
  for (const [file, key, list] of PAGES) {
    it(file, () => {
      expect(read(file)).toMatch(new RegExp(`useUrlChoice<[^>]+>\\("${key}", ${list},`));
    });
  }

  it("LEAD_VIEWS is exactly the SmartView union", () => {
    const tsx = read("components/features/leads/leads-smart-views.tsx");
    const union = [...(tsx.match(/export type SmartView = ([^;]+);/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...LEAD_VIEWS].sort()).toEqual(union.sort());
  });

  it("each page's tab ids match its TabBar ids", () => {
    const ids = (file: string) => [...read(file).matchAll(/\{ id: "([a-z-]+)",\s+label:/g)].map((m) => m[1]);
    for (const t of ["all", "draft", "sent", "viewed", "accepted", "awaiting", "invoiced", "expired"]) {
      expect(ids("app/(app)/quotes/page.tsx")).toContain(t);
    }
    for (const t of ["all", "paid", "partial", "pending", "overdue", "draft", "void"]) {
      expect(ids("app/(app)/invoices/page.tsx")).toContain(t);
    }
  });
});

describe("pickChoice / withChoice", () => {
  const TABS = ["all", "overdue"] as const;
  it("takes an allowed value, falls back on anything else", () => {
    expect(pickChoice("overdue", TABS, "all")).toBe("overdue");
    expect(pickChoice("bogus", TABS, "all")).toBe("all");
    expect(pickChoice(null, TABS, "all")).toBe("all");
  });
  it("writes the key, drops it for the default, keeps other params", () => {
    expect(withChoice("?lead=L1", "tab", "overdue", "all")).toBe("?lead=L1&tab=overdue");
    expect(withChoice("?lead=L1&tab=overdue", "tab", "all", "all")).toBe("?lead=L1");
    expect(withChoice("", "tab", "all", "all")).toBe("");
  });
});

describe("deal strip counts what /deals shows", () => {
  const NOW = new Date("2026-10-15T06:30:00Z"); // 15 Oct, noon IST
  let n = 0;
  const deal = (p: Partial<DealRow>): DealRow => ({
    id: `d${++n}`, company: `Co ${n}`, stage: "quote", value: 100, expected_close_date: null,
    stage_changed_at: null, created_at: "2026-10-02T05:00:00Z", owner_id: null, lost_at: null, ...p,
  });

  it("closing this month includes open deals whose close date already passed (the list's rule)", () => {
    const s = summarizeDealStrip([
      deal({ expected_close_date: "2026-09-20" }), // past, still open → counted, as the list does
      deal({ expected_close_date: "2026-10-31" }),
      deal({ expected_close_date: "2026-11-01" }), // next month → not
      deal({ expected_close_date: null }),          // undated → not
    ], NOW);
    expect(s.closingThisMonth.count).toBe(2);
  });

  it("won this month falls back to created_at exactly like the won-mtd view", () => {
    const noStamp = { stage: "won" as const, stage_changed_at: null, created_at: "2026-10-03T05:00:00Z" };
    expect(wonDate(noStamp)).toBe("2026-10-03");
    expect(wonThisMonth(noStamp, NOW)).toBe(true);
    const s = summarizeDealStrip([deal(noStamp)], NOW);
    expect(s.wonThisMonth.count).toBe(1);
  });
});

/* Every name in DRILL is used somewhere — a dead entry is a link nobody can click. */
describe("no dead drill-downs", () => {
  it("each DRILL name appears in a component or page", () => {
    const files = [
      "app/(app)/dashboard/page.tsx",
      "components/features/deals/deals-strip.tsx",
      "components/features/dashboard/company-section.tsx",
    ].map(read).join("\n");
    for (const name of Object.keys(DRILL) as DrillName[]) {
      expect(files, name).toContain(`drillHref("${name}")`);
    }
  });
});

describe("won this month is not cut away by the open-only All folder", () => {
  it("folderForView moves won-mtd under All into the Won folder, leaves the rest alone", async () => {
    const { folderForView } = await import("@/lib/leads/list-selectors");
    expect(folderForView("all", "won-mtd")).toBe("won");
    expect(folderForView("all", "all")).toBe("all");
    expect(folderForView("quoted", "won-mtd")).toBe("quoted");
  });
  it("the leads page sends the adjusted folder to the server and the board", () => {
    const page = read("app/(app)/leads/page.tsx");
    expect(page).toMatch(/folder: folderForView\(folder, smartView\)/);
    expect(page).toMatch(/const cutFolder = folderForView\(folder, smartView\)/);
  });
});

describe("invoice money tiles: tile, list and dashboard agree", () => {
  it("INVOICE_FOCUS matches the page's INVOICE_FOCI", async () => {
    const { INVOICE_FOCI } = await import("@/lib/invoices/kpis");
    const { INVOICE_FOCUS } = await import("./drilldown");
    expect([...INVOICE_FOCUS]).toEqual([...INVOICE_FOCI]);
  });

  it("Company 'Still owed' takes receipts off, like the Outstanding tile", async () => {
    const { invoiceMoney } = await import("@/lib/company/summary");
    const { invoiceKpis } = await import("@/lib/invoices/kpis");
    const now = new Date("2026-10-15T06:30:00Z");
    const invs = [
      { status: "pending", due_date: "2026-10-30", amount: 100_000, paid_amount: 50_000, invoice_date: "2026-10-01" },
      { status: "pending", due_date: "2026-10-30", amount: 20_000, paid_amount: 20_000, invoice_date: "2026-10-01" }, // fully received, not yet flipped
      { status: "paid", due_date: "2026-10-05", amount: 9_000, paid_amount: 9_000, invoice_date: "2026-10-01", paid_date: "2026-10-04" },
    ];
    const co = invoiceMoney(invs, now).outstanding;
    const k = invoiceKpis(invs, now);
    expect(co).toEqual({ count: 1, value: 50_000 });
    expect(k.outstanding).toBe(50_000);
    expect(k.outstandingCount).toBe(1);
    expect(k.paidThisMonthCount).toBe(1);
  });

  it("the invoices page filters by the tile's predicate and shows the banner", () => {
    const page = read("app/(app)/invoices/page.tsx");
    expect(page).toMatch(/useUrlChoice<InvoiceFocus>\("focus", INVOICE_FOCI, ""\)/);
    expect(page).toMatch(/if \(focus && !invoiceInFocus\(i, focus\)\) return false;/);
    expect(page).toMatch(/onClick=\{\(\) => focusOn\("unpaid"\)\}/);
    expect(page).toMatch(/onClick=\{\(\) => focusOn\("paid-month"\)\}/);
    expect(page).toMatch(/<FocusBanner/);
  });
});

describe("quotes tiles: tile and list agree, and the nudge button is honest", () => {
  it("QUOTE_FOCUS matches QUOTE_FOCI", async () => {
    const { QUOTE_FOCI } = await import("@/lib/quotes/focus");
    const { QUOTE_FOCUS } = await import("./drilldown");
    expect([...QUOTE_FOCUS]).toEqual([...QUOTE_FOCI]);
  });
  it("review = sent + viewed; accepted includes invoiced", async () => {
    const { quoteInFocus, focusValue } = await import("@/lib/quotes/focus");
    const qs = [
      { status: "sent", amount: 10 }, { status: "viewed", amount: 20 }, { status: "draft", amount: 99 },
      { status: "accepted", amount: 5, payment_status: "invoiced" }, { status: "accepted", amount: 7 },
    ];
    expect(qs.filter((q) => quoteInFocus(q, "review")).length).toBe(2);
    expect(focusValue(qs, "review")).toBe(30);
    expect(focusValue(qs, "accepted")).toBe(12);
  });
  it("the page uses the predicates and no longer claims a nudge it never sent", () => {
    const page = read("app/(app)/quotes/page.tsx");
    expect(page).toMatch(/if \(focus && !quoteInFocus\(q, focus\)\) return false;/);
    expect(page).toMatch(/focusValue\(quotesByWorkspace, "review"\)/);
    expect(page).not.toContain("toast.success(`Nudge sent");
  });
});

describe("subscription money tiles open status = active", () => {
  it("SUB_FOCUS matches SUB_FOCI, and the page filters by subInFocus", async () => {
    const { SUB_FOCI, subInFocus } = await import("@/lib/subscriptions/focus");
    const { SUB_FOCUS } = await import("./drilldown");
    expect([...SUB_FOCUS]).toEqual([...SUB_FOCI]);
    expect(subInFocus({ status: "active" }, "active")).toBe(true);
    expect(subInFocus({ status: "paused" }, "active")).toBe(false);
    const page = read("app/(app)/subscriptions/page.tsx");
    expect(page).toMatch(/if \(focus && !subInFocus\(s, focus\)\) return false;/);
    expect(page).toMatch(/const activeSubs = subsByWorkspace\.filter\(\(s\) => subInFocus\(s, "active"\)\)/);
  });
});

describe("renewals and payments tiles", () => {
  it("every renewals tile opens a bucket the page has, High risk included", () => {
    const page = read("app/(app)/renewals/page.tsx");
    for (const b of ["urgent", "upcoming", "future", "risk"]) {
      expect(page).toContain(`onClick={() => setBucketTab("${b}")}`);
    }
    expect(page).toMatch(/bucketTab === "risk"/);
  });
  it("PAYMENT_FOCUS / QUOTE_FOCUS match their pages", async () => {
    const { PAYMENT_FOCI, paymentInFocus, projectReceivedInMonth } = await import("@/lib/payments/focus");
    const { QUOTE_FOCI, quoteInFocus } = await import("@/lib/quotes/focus");
    const dd = await import("./drilldown");
    expect([...dd.PAYMENT_FOCUS]).toEqual([...PAYMENT_FOCI]);
    expect([...dd.QUOTE_FOCUS]).toEqual([...QUOTE_FOCI]);
    const now = new Date("2026-10-15T06:30:00Z");
    expect(paymentInFocus({ status: "received", received_at: "2026-09-30T19:00:00Z" }, "received-month", now)).toBe(true); // 1 Oct IST
    expect(paymentInFocus({ status: "refunded", received_at: "2026-10-05T05:00:00Z" }, "received-month", now)).toBe(false);
    expect(projectReceivedInMonth([{ amount: 500, received_at: "2026-10-02" }, { amount: 9, received_at: "2026-09-30" }], now)).toBe(500);
    expect(quoteInFocus({ status: "accepted", payment_status: "partial" }, "partial")).toBe(true);
    expect(quoteInFocus({ status: "accepted", payment_status: "received" }, "to-invoice")).toBe(true);
  });
  it("Collected MTD = payments-in-focus + project receipts, the same helper sum", async () => {
    const { collectedInMonth } = await import("@/lib/company/summary");
    const { paymentInFocus, projectReceivedInMonth } = await import("@/lib/payments/focus");
    const now = new Date("2026-10-15T06:30:00Z");
    const pays = [
      { status: "received", amount: 100, received_at: "2026-10-03T05:00:00Z" },
      { status: "received", amount: 50, received_at: "2026-09-20T05:00:00Z" },
      { status: "refunded", amount: 70, received_at: "2026-10-04T05:00:00Z" },
    ];
    const proj = [{ amount: 30, received_at: "2026-10-05" }];
    const listed = pays.filter((p) => paymentInFocus(p, "received-month", now)).reduce((s, p) => s + p.amount, 0);
    expect(listed + projectReceivedInMonth(proj, now)).toBe(collectedInMonth(pays, proj, now));
  });
});

describe("customers strip opens the customers behind each figure", () => {
  it("MRR / ARR open With subscriptions (active only), Received opens Paid this FY", () => {
    const page = read("app/(app)/customers/page.tsx");
    expect(page).toMatch(/if \(!s\.customer_id \|\| s\.status !== "active"\) continue;/); // subsByCustomer = active only
    expect(page).toMatch(/\{ id: "subscribed", label: "With subscriptions", test: \(x\) => x\.hasSub \}/);
    expect(page).toMatch(/\{ id: "received",   label: "Paid this FY",     test: \(x\) => x\.received > 0 \}/);
    expect(page).toMatch(/onClick: \(\) => setView\("received"\)/);
    expect(page).toMatch(/onClick: \(\) => setView\("subscribed"\)/);
  });
});

describe("hissa 3: accounting, purchase orders, online orders", () => {
  it("bills Outstanding opens owed bills; TDS tiles open their statuses", () => {
    const bills = read("app/(app)/accounting/bills/page.tsx");
    expect(bills).toMatch(/onClick=\{\(\) => setStatusFilter\("owed"\)\}/);
    expect(read("lib/queries/vendor-bills.ts")).toMatch(/if \(status === "owed"\) q = q\.in\("status", \["unpaid", "partial"\]\)/);
    const tds = read("app/(app)/accounting/tds-receivable/page.tsx");
    for (const t of ["all", "pending_cert", "claimable", "claimed"]) expect(tds).toContain(`onClick={() => setActiveTab("${t}")}`);
    expect(read("lib/queries/tds-receivable.ts")).toMatch(/q\.in\("status", \["cert_received", "verified_26as"\]\)/);
  });
  it("purchase-order tiles open their tabs", () => {
    const po = read("app/(app)/purchase-orders/page.tsx");
    for (const t of ["draft", "placed", "provisioned"]) expect(po).toContain(`onClick={() => setTab("${t}")}`);
  });
  it("online-order tiles count and filter with the same predicate, in IST", async () => {
    const { orderInFocus } = await import("@/lib/online-orders/focus");
    const now = new Date("2026-10-15T06:30:00Z");
    expect(orderInFocus({ status: "active", type: "paid", paid: true, createdIso: "2026-10-14T20:00:00Z" }, "today", now)).toBe(true); // 15 Oct 01:30 IST
    expect(orderInFocus({ status: "active", type: "paid", paid: true, createdIso: "2026-09-30T19:00:00Z" }, "revenue-month", now)).toBe(true); // 1 Oct IST
    expect(orderInFocus({ status: "trial-converting", type: "trial", paid: false, createdIso: null }, "converting", now)).toBe(true);
    const page = read("app/(app)/online-orders/page.tsx");
    expect(page).toMatch(/if \(focus && !orderInFocus\(o, focus\)\) return false;/);
    expect(page).not.toMatch(/toLocaleDateString\("en-IN", \{ day: "2-digit", month: "short" \}\);\n\s*const today/);
  });
});

describe("aging, expenses and the prepaid form", () => {
  it("aging owes the balance (receipts taken off) and filters by bucket", () => {
    const page = read("app/(app)/accounting/aging/page.tsx");
    expect(page).toMatch(/const owed = invoiceBalance\(/);
    expect(page).not.toMatch(/const owed = inv\.net_payable \?\? inv\.amount/);
    // R-1586: the paged read lives next to the page (aging/read.ts).
    expect(read("app/(app)/accounting/aging/read.ts")).toMatch(/paid_amount, status, invoice_date/);
    expect(page).toMatch(/rows   = bucket \? allRows\.filter\(\(r\) => r\.buckets\[bucket\] > 0\) : allRows/);
  });
  it("expenses Top category opens that category; prepaid form points staff advances away", () => {
    expect(read("app/(app)/accounting/expenses/page.tsx")).toMatch(/onClick=\{\(\) => setCatFilter\(top\)\}/);
    expect(read("app/(app)/accounting/prepaid/page.tsx")).toContain(`href="/accounting/advances"`);
  });
});
