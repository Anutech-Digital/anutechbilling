// @vitest-environment jsdom
/* R-2871 — the quote page header names every subscription a together renewal quote renews. */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
import { ForSubscriptionLine } from "./for-subscription-line";
import { togetherMembers } from "@/lib/quotes/quote-kind";

afterEach(cleanup);
const subs = [
  { id: "s1", plan: "SCN Yearly Standard", domain: "a.in", seats: 20, renewal_date: "2026-11-26" },
  { id: "s2", plan: "SCN Yearly Starter", domain: "b.in", seats: 5, renewal_date: "2026-12-02" },
];

describe("ForSubscriptionLine (R-2871)", () => {
  it("together quote → 'For subscriptions:' and one line per member", () => {
    const members = togetherMembers([{ subscription_id: "s1" }, { subscription_id: "s2" }], subs);
    render(<ForSubscriptionLine single={subs[0]} singleText="SCN Yearly Standard" members={members} />);
    const box = screen.getByTestId("quote-for-subscription");
    expect(box.textContent).toContain("For subscriptions:");
    expect(box.textContent).not.toContain("For subscription:");
    const rows = screen.getAllByTestId("quote-for-subscription-member").map((r) => r.textContent);
    expect(rows).toEqual([
      "SCN Yearly Standard · a.in · 20 seats · renews 26 Nov 2026",
      "SCN Yearly Starter · b.in · 5 seats · renews 2 Dec 2026",
    ]);
  });
  it("single renewal quote → the same one line as before", () => {
    render(<ForSubscriptionLine single={subs[0]} singleText="SCN Yearly Standard · 20 seats · renews 26 Nov 2026" members={[]} />);
    expect(screen.getByTestId("quote-for-subscription").textContent).toBe("For subscription: SCN Yearly Standard · 20 seats · renews 26 Nov 2026");
    expect(screen.queryByTestId("quote-for-subscription-member")).toBeNull();
  });
  it("nothing known → nothing drawn", () => {
    const { container } = render(<ForSubscriptionLine single={null} singleText={null} members={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
