import { describe, it, expect } from "vitest";
import {
  channelReport, recommendationFor, MIN_SAMPLE_FOR_RATE, MIN_SPEND_COVERAGE, SCALE_ROAS,
  type ChannelLeadInput,
} from "./channel-economics";

/**
 * The fixture is this tenant's real shape as measured on 13 Aug 2026 — 61 leads
 * across 8 sources, ₹4,000 of recorded spend — because the whole point of this
 * module is behaving correctly on THAT data rather than on a tidy invention.
 */
function leadsFor(source: string, total: number, won: number, wonValueEach: number): ChannelLeadInput[] {
  const out: ChannelLeadInput[] = [];
  for (let i = 0; i < won; i++) out.push({ source, stage: "won", value: wonValueEach, paid: true });
  for (let i = won; i < total; i++) out.push({ source, stage: "lost", value: 0 });
  return out;
}

const PRODUCTION_SHAPE: ChannelLeadInput[] = [
  ...leadsFor("whatsapp",         23, 18, 162_575),   // ≈ ₹29,26,350 won
  ...leadsFor("manual",           14, 11, 174_506),   // ≈ ₹19,19,567 — NOT a channel
  ...leadsFor("buy-workspace-v2",  7,  6,  84_733),
  ...leadsFor("referral",          7,  6, 112_780),
  ...leadsFor("tele-calling",      5,  3,  52_344),
  ...leadsFor("csv",               2,  2, 228_528),   // NOT a channel
  ...leadsFor("email-inbound",     2,  0,       0),
  ...leadsFor("enquiry-form",      1,  1,  19_116),
];

describe("the ROAS this module refuses to print", () => {
  it("returns null instead of 1,650× when ₹4,000 of spend faces ₹66L of won value", () => {
    // The headline case. Rendering the multiple would invite "pour money into
    // Facebook" off the back of one ₹4,000 expense row.
    const r = channelReport(PRODUCTION_SHAPE, [{ channel: "whatsapp", rupees: 4_000 }]);
    const wa = r.channels.find((c) => c.channel === "whatsapp")!;
    expect(wa.spend).toBe(4_000);
    expect(wa.roas).toBeNull();
    expect(wa.confidence).toBe("spend_too_small");
  });

  it("says WHY the figure is missing, in words a non-engineer can act on", () => {
    const r = channelReport(PRODUCTION_SHAPE, [{ channel: "whatsapp", rupees: 4_000 }]);
    const wa = r.channels.find((c) => c.channel === "whatsapp")!;
    expect(wa.notes.join(" ")).toMatch(/missing spend data|reflect missing spend/i);
    expect(wa.notes.join(" ")).toMatch(/4,000/);
  });

  it("refuses a blended portfolio ROAS on the same grounds", () => {
    const r = channelReport(PRODUCTION_SHAPE, [{ channel: "whatsapp", rupees: 4_000 }]);
    expect(r.blendedRoas).toBeNull();
    expect(r.blendedNote).toMatch(/gap in the records/i);
  });

  it("DOES report ROAS once spend is genuinely tracked", () => {
    // Same wins, realistic spend — the metric must actually work when fed.
    const r = channelReport(
      leadsFor("google-ads", 20, 10, 100_000),          // ₹10,00,000 won
      [{ channel: "google-ads", rupees: 200_000 }],     // 20% coverage
    );
    const g = r.channels[0];
    expect(g.confidence).toBe("usable");
    expect(g.roas).toBeCloseTo(5, 5);
    expect(g.cac).toBe(20_000);
    expect(r.blendedRoas).toBeCloseTo(5, 5);
  });

  it("uses the documented coverage threshold, not a magic number", () => {
    const wonValue = 1_000_000;
    const justUnder = Math.floor(wonValue * MIN_SPEND_COVERAGE) - 1;
    const justOver  = Math.ceil(wonValue * MIN_SPEND_COVERAGE) + 1;
    const l = leadsFor("meta-ads", 10, 10, wonValue / 10);
    expect(channelReport(l, [{ channel: "meta-ads", rupees: justUnder }]).channels[0].roas).toBeNull();
    expect(channelReport(l, [{ channel: "meta-ads", rupees: justOver  }]).channels[0].roas).not.toBeNull();
  });
});

describe("data entry is not a marketing channel", () => {
  it("keeps manual and csv out of the channel ranking", () => {
    const r = channelReport(PRODUCTION_SHAPE);
    expect(r.channels.map((c) => c.channel)).not.toContain("manual");
    expect(r.channels.map((c) => c.channel)).not.toContain("csv");
  });

  it("reports them separately rather than dropping them", () => {
    // The size of this bucket is the most useful number here: the share of
    // pipeline whose origin nobody knows.
    const r = channelReport(PRODUCTION_SHAPE);
    expect(r.unattributed.map((c) => c.channel).sort()).toEqual(["csv", "manual"]);
    expect(r.totals.unattributedShare).toBeCloseTo(16 / 61, 3);
  });

  it("would otherwise have ranked 'manual' second by won value", () => {
    // Proof the exclusion matters: on raw won value manual outranks every real
    // channel but WhatsApp, and a dashboard would invite investing in it.
    const manual = channelReport(PRODUCTION_SHAPE).unattributed.find((c) => c.channel === "manual")!;
    const second = channelReport(PRODUCTION_SHAPE).channels[1];
    expect(manual.wonValue).toBeGreaterThan(second.wonValue);
  });

  it("ranks WhatsApp first on this tenant's real data", () => {
    const r = channelReport(PRODUCTION_SHAPE);
    expect(r.channels[0].channel).toBe("whatsapp");
    expect(r.channels[0].won).toBe(18);
  });

  it("treats a null or blank source as unattributed, not as a channel named ''", () => {
    const r = channelReport([{ source: null, stage: "won", value: 100, paid: true }, { source: "  ", stage: "lost", value: 0 }]);
    expect(r.channels).toEqual([]);
    expect(r.unattributed.length).toBeGreaterThan(0);
  });
});

describe("win rate", () => {
  it("divides by CLOSED deals, not by all leads", () => {
    // Dividing by every lead punishes a channel for having a full pipeline.
    const l: ChannelLeadInput[] = [
      ...leadsFor("referral", 6, 3, 1000),                      // 3 won, 3 lost
      { source: "referral", stage: "contacted", value: 5000 },  // still open
      { source: "referral", stage: "quote", value: 5000 },
    ];
    const c = channelReport(l).channels[0];
    expect(c.leads).toBe(8);
    expect(c.open).toBe(2);
    expect(c.winRate).toBeCloseTo(0.5, 5);
  });

  it("stays null when too few deals have closed to quote a rate", () => {
    const c = channelReport(leadsFor("enquiry-form", 1, 1, 19_116)).channels[0];
    expect(c.winRate).toBeNull();
    expect(c.notes.join(" ")).toMatch(/too few/i);
  });

  it("quotes a rate at exactly the documented sample size", () => {
    const c = channelReport(leadsFor("tele-calling", MIN_SAMPLE_FOR_RATE, 3, 50_000)).channels[0];
    expect(c.winRate).toBeCloseTo(3 / MIN_SAMPLE_FOR_RATE, 5);
  });

  it("reports BOTH problems when a channel has both", () => {
    // The bug that reshaped `notes` from a string into an array: this channel is
    // short of spend data AND short of closed deals. Reporting one and hiding the
    // other leaves the reader believing they have the full picture.
    const c = channelReport(leadsFor("enquiry-form", 1, 1, 19_116)).channels[0];
    expect(c.notes.length).toBeGreaterThanOrEqual(2);
    const joined = c.notes.join(" ");
    expect(joined).toMatch(/No marketing spend is recorded/i);
    expect(joined).toMatch(/too few/i);
  });

  it("says nothing when there is nothing to warn about", () => {
    const c = channelReport(
      leadsFor("google-ads", 20, 10, 100_000),
      [{ channel: "google-ads", rupees: 200_000 }],
    ).channels[0];
    expect(c.notes).toEqual([]);
  });
});

describe("CAC", () => {
  it("is null when no spend is attributed to the channel", () => {
    const c = channelReport(PRODUCTION_SHAPE).channels[0];
    expect(c.spend).toBeNull();
    expect(c.cac).toBeNull();
    expect(c.confidence).toBe("no_spend_data");
    expect(c.notes.join(" ")).toMatch(/No marketing spend is recorded/i);
  });

  it("is null when spend exists but nothing has been won yet", () => {
    const r = channelReport(
      leadsFor("linkedin-ads", 4, 0, 0),
      [{ channel: "linkedin-ads", rupees: 50_000 }],
    );
    const c = r.channels[0];
    expect(c.spend).toBe(50_000);
    expect(c.cac).toBeNull();
    expect(c.notes.join(" ")).toMatch(/nothing won yet/i);
  });

  it("matches spend to a channel case-insensitively", () => {
    const r = channelReport(leadsFor("whatsapp", 10, 10, 10_000), [{ channel: "WhatsApp", rupees: 30_000 }]);
    expect(r.channels[0].spend).toBe(30_000);
  });

  it("sums several spend rows for one channel", () => {
    const r = channelReport(leadsFor("meta-ads", 10, 10, 10_000), [
      { channel: "meta-ads", rupees: 15_000 },
      { channel: "meta-ads", rupees: 10_000 },
    ]);
    expect(r.channels[0].spend).toBe(25_000);
  });

  it("ignores zero and negative spend rows rather than reducing spend", () => {
    // A refund row must not make a channel look cheaper than it was.
    const r = channelReport(leadsFor("meta-ads", 10, 10, 10_000), [
      { channel: "meta-ads", rupees: 25_000 },
      { channel: "meta-ads", rupees: -5_000 },
      { channel: "meta-ads", rupees: 0 },
    ]);
    expect(r.channels[0].spend).toBe(25_000);
  });
});

describe("LTV:CAC", () => {
  it("is computed when both an LTV estimate and a CAC exist", () => {
    const r = channelReport(
      leadsFor("google-ads", 10, 10, 100_000),
      [{ channel: "google-ads", rupees: 200_000 }],
      60_000,
    );
    expect(r.channels[0].cac).toBe(20_000);
    expect(r.channels[0].ltvToCac).toBeCloseTo(3, 5);
  });

  it("stays null rather than inventing an LTV", () => {
    const r = channelReport(
      leadsFor("google-ads", 10, 10, 100_000),
      [{ channel: "google-ads", rupees: 200_000 }],
    );
    expect(r.channels[0].ltvToCac).toBeNull();
  });

  it("stays null when CAC is unknown, even with an LTV", () => {
    const r = channelReport(PRODUCTION_SHAPE, [], 60_000);
    for (const c of r.channels) expect(c.ltvToCac).toBeNull();
  });

  it("does not divide by a zero CAC", () => {
    const r = channelReport(leadsFor("x", 5, 5, 1000), [{ channel: "x", rupees: 1 }], 60_000);
    expect(Number.isFinite(r.channels[0].ltvToCac ?? 0)).toBe(true);
  });
});

describe("robustness", () => {
  it("never produces NaN in any numeric field", () => {
    const r = channelReport(
      [
        { source: "a", stage: "won",  value: NaN, paid: true },
        { source: "a", stage: "won",  value: null, paid: true },
        { source: "b", stage: null,   value: undefined },
        { source: undefined, stage: "lost", value: -5000 },
      ],
      [{ channel: "a", rupees: NaN }],
      NaN,
    );
    for (const c of [...r.channels, ...r.unattributed]) {
      for (const v of [c.leads, c.won, c.lost, c.open, c.wonValue]) {
        expect(Number.isFinite(v), `${c.channel}`).toBe(true);
      }
      if (c.roas !== null) expect(Number.isFinite(c.roas)).toBe(true);
      if (c.cac  !== null) expect(Number.isFinite(c.cac)).toBe(true);
    }
    expect(Number.isFinite(r.totals.wonValue)).toBe(true);
  });

  it("never counts a negative deal value as won revenue", () => {
    const r = channelReport([{ source: "a", stage: "won", value: -100_000, paid: true }]);
    expect(r.channels[0].wonValue).toBe(0);
  });

  it("gives the same ranking whatever order the leads arrive in", () => {
    const a = channelReport(PRODUCTION_SHAPE).channels.map((c) => c.channel);
    const b = channelReport([...PRODUCTION_SHAPE].reverse()).channels.map((c) => c.channel);
    expect(a).toEqual(b);
  });

  it("handles an empty period without throwing", () => {
    const r = channelReport([]);
    expect(r.channels).toEqual([]);
    expect(r.totals.leads).toBe(0);
    expect(r.totals.unattributedShare).toBe(0);
    expect(r.blendedRoas).toBeNull();
    expect(r.blendedNote).toMatch(/No marketing spend/i);
  });

  it("counts every lead exactly once across channels and unattributed", () => {
    const r = channelReport(PRODUCTION_SHAPE);
    const counted = [...r.channels, ...r.unattributed].reduce((s, c) => s + c.leads, 0);
    expect(counted).toBe(PRODUCTION_SHAPE.length);
    expect(r.totals.leads).toBe(PRODUCTION_SHAPE.length);
  });
});

describe("recommendationFor — advice that moves money", () => {
  const base = { attributable: true, roas: null as number | null, spend: null as number | null, won: 0, wonValue: 0 };

  it("NEVER says scale or cut without a trustworthy ROAS", () => {
    // The safety property. "Cut spend" on an unmeasured channel would kill the
    // best performer in this workspace (WhatsApp: 18 wins, ₹29L, no spend
    // recorded), and "Scale budget" off a ₹4,000 row moves real money on
    // arithmetic rather than evidence.
    for (const spend of [null, 0, 4_000, 1_000_000]) {
      const r = recommendationFor({ ...base, roas: null, spend, won: 18, wonValue: 2_926_350 });
      expect(["scale", "cut"]).not.toContain(r.action);
      expect(r.action).toBe("track_spend");
    }
  });

  it("explains WHICH kind of missing spend it is", () => {
    expect(recommendationFor({ ...base, spend: null }).reason).toMatch(/No spend is recorded/i);
    expect(recommendationFor({ ...base, spend: 4_000 }).reason).toMatch(/too small a share/i);
  });

  it("says cut below break-even", () => {
    const r = recommendationFor({ ...base, roas: 0.6, spend: 500_000, won: 3, wonValue: 300_000 });
    expect(r.action).toBe("cut");
    expect(r.reason).toMatch(/0\.60/);
  });

  it("says scale at or above the documented bar, optimise below it", () => {
    expect(recommendationFor({ ...base, roas: SCALE_ROAS,       spend: 100, won: 1 }).action).toBe("scale");
    expect(recommendationFor({ ...base, roas: SCALE_ROAS - 0.01, spend: 100, won: 1 }).action).toBe("optimise");
  });

  it("says review when spend exists but nothing has closed", () => {
    const r = recommendationFor({ ...base, roas: 0, spend: 50_000, won: 0, wonValue: 0 });
    expect(r.action).toBe("review");
  });

  it("gives no budget advice for data-entry sources", () => {
    const r = recommendationFor({ ...base, attributable: false, roas: 9, spend: 1000, won: 11 });
    expect(r.action).toBe("not_a_channel");
  });

  it("always returns a label and a reason", () => {
    for (const c of [
      { ...base },
      { ...base, attributable: false },
      { ...base, roas: 5, spend: 1000, won: 2 },
      { ...base, roas: 0.2, spend: 1000, won: 2 },
    ]) {
      const r = recommendationFor(c);
      expect(r.label.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});

/* R-375 (audit finding 8): accept_quote sets stage 'won' on ACCEPTANCE, before any payment. */
describe("won revenue needs a recorded payment", () => {
  it("an accepted-but-unpaid won lead is a won deal but adds ₹0 of won value (and ROAS)", () => {
    const r = channelReport([
      { source: "google-ads", stage: "won", value: 100_000, paid: true },
      { source: "google-ads", stage: "won", value: 900_000, paid: false },
      { source: "google-ads", stage: "won", value: 500_000 },             // unknown = not paid
    ], [{ channel: "google-ads", rupees: 50_000 }]);
    const c = r.channels[0];
    expect(c.won).toBe(3);
    expect(c.wonValue).toBe(100_000);
    expect(c.roas).toBe(2);
    expect(r.totals.wonValue).toBe(100_000);
  });
});
