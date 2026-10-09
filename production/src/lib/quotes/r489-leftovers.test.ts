/**
 * R-489 — leftovers of Abhishek's audit cards (R-468, R-453, R-444, R-446, R-457, R-456,
 * R-471). Pure rules are tested directly; screens are read as source, like the other
 * wiring tests in this repo (the pages need the whole data layer to render).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acceptHint } from "./quote-page-actions";
import { recordPaymentConsequences } from "@/lib/payments/record-consequences";
import { teamNoteCounts } from "@/lib/leads/list-page";

const SRC = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("R-468 (5) / R-453 (2): the Mark-accepted sentence fits the quote", () => {
  it("renewal, existing customer and lead each get their own words", () => {
    expect(acceptHint({ is_renewal: true, customer_id: "C1" })).toContain("subscription is renewed");
    expect(acceptHint({ is_renewal: false, customer_id: "C1" })).toBe("Customer accepted? Mark accepted to confirm the order.");
    expect(acceptHint({ customer_id: null })).toContain("convert the lead into a customer");
  });
  it("the quote page and the action bar use it", () => {
    expect(read("app/(app)/quotes/[id]/page.tsx")).toContain("{acceptHint(quote)}");
    expect(read("components/features/quotes/quote-action-bar.tsx")).toContain("title={acceptHint(quote)}");
  });
});

describe("R-453 (1): Record payment on a renewal says it renews", () => {
  const base = {
    quoteId: "Q1", customerName: "Gupta", amount: 19116, quoteAmount: 19116, priorReceived: 0,
    createsCustomer: false, createsSubscription: true, planLabel: "Business Starter",
  };
  it("renewal: no 'Creates a recurring subscription'", () => {
    const text = recordPaymentConsequences({ payment: { ...base, renewsSubscription: true }, receiptSeries: null })
      .map((c) => c.text).join(" ");
    expect(text).toContain("Renews the existing subscription");
    expect(text).not.toContain("Creates a recurring subscription");
  });
  it("a normal quote is unchanged", () => {
    const text = recordPaymentConsequences({ payment: base, receiptSeries: null }).map((c) => c.text).join(" ");
    expect(text).toContain("Creates a recurring subscription");
  });
  it("both payment callers on the quote pass isRenewal", () => {
    expect(read("app/(app)/quotes/[id]/page.tsx")).toMatch(/isRenewal=\{!!quote\.is_renewal\}/);
    expect(read("components/features/quotes/quote-action-bar.tsx")).toMatch(/isRenewal=\{!!quote\.is_renewal\}/);
  });
});

describe("R-446 (2): monthly quote page", () => {
  it("passes the split cycle to the money row and offers the billing schedule", () => {
    const page = read("app/(app)/quotes/[id]/page.tsx");
    expect(page).toContain("splitBilledCycle: splitCycle");
    expect(page).toMatch(/splitCycle && !money\.canGenerateInvoice/);
  });
});

describe("R-457 leftovers", () => {
  it("the team note counts this page's rows when the server sends them", () => {
    expect(teamNoteCounts({ total: 50, unassigned: 10, high_priority: 0, by_owner: {}, page_total: 37, page_unassigned: 2 }))
      .toEqual({ total: 37, unassigned: 2 });
    expect(teamNoteCounts({ total: 50, unassigned: 10, high_priority: 0, by_owner: {} })).toEqual({ total: 50, unassigned: 10 });
    expect(read("components/features/leads/leads-toolbar.tsx")).toContain("counts={teamNoteCounts(pool)}");
  });
  it("the migration adds page_unassigned with its deploy header", () => {
    const sql = readFileSync(join(SRC, "../supabase/migrations/20261009190500_lead_counts_page_pool.sql"), "utf8");
    expect(sql.split("\n")[1]).toMatch(/^-- deploy-peek: /);
    expect(sql).toContain("'page_unassigned'");
    expect(sql).toContain("grant execute on function public.lead_counts(jsonb) to authenticated");
  });
  it("'My assigned' is kept in the URL (?who=mine)", () => {
    expect(read("app/(app)/leads/page.tsx")).toMatch(/useUrlChoice<TeamViewMode>\("who", TEAM_VIEW_MODES, "team"\)/);
  });
});

describe("R-468 (7): no button inside a button on customer Transactions", () => {
  it("the phone card is a div with role=button", () => {
    const src = read("components/features/customers/customer-profile.tsx");
    const table = src.slice(src.indexOf("function RecordTable"));
    expect(table).toMatch(/role=\{r\.onClick \? "button" : undefined\}/);
    expect(table.slice(0, table.indexOf("Desktop / tablet table"))).not.toMatch(/<button/);
  });
});

describe("R-456 / R-471 in the leads folder", () => {
  it("the lead card shows the catalogue plan and estimated value", () => {
    const src = read("components/features/leads/lead-card.tsx");
    expect(src).toContain("leadPlanDisplay(lead, catalogItems)");
    expect(src).toContain("planShow.value");
  });
  it("the follow-ups tab uses the /tasks snooze menu", () => {
    const src = read("components/features/leads/lead-detail-followups-tab.tsx");
    expect(src).toContain("snoozeChoices().map");
    expect(src).toContain("Pick a date…");
    expect(src).not.toContain("Snooze 1 day");
  });
});
