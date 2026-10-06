import { describe, it, expect } from "vitest";
import { summariseSpend, headOf, channelLabel, type SpendRow } from "./spend-summary";

const row = (p: Partial<SpendRow>): SpendRow => ({
  id: Math.random().toString(36).slice(2), expense_date: "2026-09-10",
  category: "Advertising", channel: null, vendor_name: null, amount: 0, ...p,
});

describe("marketing & advertising spend", () => {
  const rows: SpendRow[] = [
    row({ category: "Advertising", channel: "google-ads", vendor_name: "Google India", amount: 11_800, expense_date: "2026-08-05" }),
    row({ category: "Advertising", channel: "meta-ads",   vendor_name: "Meta Platforms", amount: 5_900, expense_date: "2026-09-02" }),
    row({ category: "Marketing",   channel: null,         vendor_name: "SEO Wale", amount: 20_000, expense_date: "2026-09-12" }),
    row({ category: "Marketing",   channel: "google-ads", vendor_name: "google india ", amount: 3_000, expense_date: "2026-09-20" }),
    row({ category: "Office Rent", channel: null,         vendor_name: "Landlord", amount: 50_000 }),
  ];
  const s = summariseSpend(rows);

  it("splits the total into Marketing and Advertising, and ignores rent", () => {
    expect(s.total).toBe(40_700);
    expect(s.byHead.Advertising).toBe(17_700);
    expect(s.byHead.Marketing).toBe(23_000);
    expect(s.byHead.Other).toBe(0);
  });

  it("monthly points, oldest first, each head apart", () => {
    expect(s.monthly).toEqual([
      { month: "2026-08", Marketing: 0, Advertising: 11_800, Other: 0 },
      { month: "2026-09", Marketing: 23_000, Advertising: 5_900, Other: 0 },
    ]);
  });

  it("by channel, biggest first, untagged kept as its own line", () => {
    expect(s.byChannel.map((c) => [c.channel, c.total])).toEqual([
      [null, 20_000], ["google-ads", 14_800], ["meta-ads", 5_900],
    ]);
    const g = s.byChannel.find((c) => c.channel === "google-ads")!;
    expect(g.Advertising).toBe(11_800);
    expect(g.Marketing).toBe(3_000);
    expect(s.untagged).toEqual({ count: 1, amount: 20_000 });
  });

  it("one vendor line whatever the spacing or case", () => {
    const g = s.byVendor.find((v) => v.vendor === "Google India")!;
    expect(g.total).toBe(14_800);
    expect(g.count).toBe(2);
    expect(s.byVendor[0].vendor).toBe("SEO Wale");
  });

  it("a custom marketing category is kept under Other, not dropped", () => {
    const t = summariseSpend([row({ category: "Digital Marketing Retainer", amount: 1_000 })]);
    expect(t.total).toBe(1_000);
    expect(t.byHead.Other).toBe(1_000);
  });

  it("heads and labels", () => {
    expect(headOf("Advertising")).toBe("Advertising");
    expect(headOf(" marketing ")).toBe("Marketing");
    expect(channelLabel("meta-ads")).toBe("Facebook / Instagram Ads");
    expect(channelLabel(null)).toBe("No channel");
  });

  it("nothing in → zeros, not NaN", () => {
    const z = summariseSpend([]);
    expect(z.total).toBe(0);
    expect(z.monthly).toEqual([]);
    expect(z.untagged).toEqual({ count: 0, amount: 0 });
  });
});
