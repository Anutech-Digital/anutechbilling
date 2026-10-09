import { describe, it, expect } from "vitest";
import { dealHealth, healthBadge, HEALTH_WEIGHT, AT_RISK_BELOW, SLIPPING_BELOW } from "./deal-health";
import type { Lead } from "@/lib/supabase/database.types";

const NOW = new Date("2026-08-16T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const TODAY = "2026-08-16";

const input = (over: Partial<Parameters<typeof dealHealth>[0]> = {}) => ({
  lead: { stage: "quote", follow_up_date: "2026-08-20", stage_changed_at: daysAgo(2) } as Lead,
  lastActivityAt: daysAgo(1),
  customerResponded: true,
  today: TODAY,
  ...over,
});

describe("weights", () => {
  it("sum to 100, so the score is a percentage of something real", () => {
    const total = HEALTH_WEIGHT.recentTouch + HEALTH_WEIGHT.movement
                + HEALTH_WEIGHT.nextStep + HEALTH_WEIGHT.responded;
    expect(total).toBe(100);
  });

  it("a fully-worked deal scores 100", () => {
    const h = dealHealth(input(), NOW);
    expect(h.score).toBe(100);
    expect(h.band).toBe("healthy");
    expect(h.issues).toEqual([]);
    expect(h.incomplete).toBe(false);
  });

  it("the parts add up to the score", () => {
    const h = dealHealth(input({ lastActivityAt: daysAgo(10) }), NOW);
    const sum = h.parts.recentTouch + h.parts.movement + h.parts.nextStep + h.parts.responded;
    expect(sum).toBe(h.score);
  });
});

describe("it is not heat-score — different question, different inputs", () => {
  it("a great lead nobody has worked scores LOW here", () => {
    /* The combination this exists to surface: strong customer, badly worked deal.
       heatScore would call this hot; health calls it at risk, and both are right. */
    const h = dealHealth(input({
      lead: { stage: "quote", follow_up_date: null, stage_changed_at: daysAgo(40) } as Lead,
      lastActivityAt: daysAgo(30),
      customerResponded: false,
    }), NOW);
    expect(h.score).toBe(0);
    expect(h.band).toBe("at_risk");
  });

  it("every input is something the REP controls", () => {
    // Touch, movement, next step, reply — no company size, no domain, no seat count.
    const h = dealHealth(input(), NOW);
    expect(Object.keys(h.parts).sort()).toEqual(["movement", "nextStep", "recentTouch", "responded"]);
  });
});

describe("recent touch", () => {
  it.each([
    [0,  HEALTH_WEIGHT.recentTouch],
    [7,  HEALTH_WEIGHT.recentTouch],
    [14, 0],
    [30, 0],
  ])("%s days since contact scores %s", (days, expected) => {
    expect(dealHealth(input({ lastActivityAt: daysAgo(days) }), NOW).parts.recentTouch).toBe(expected);
  });

  it("decays between one and two weeks rather than falling off a cliff", () => {
    const at10 = dealHealth(input({ lastActivityAt: daysAgo(10) }), NOW).parts.recentTouch;
    expect(at10).toBeGreaterThan(0);
    expect(at10).toBeLessThan(HEALTH_WEIGHT.recentTouch);
  });

  it("scores ZERO — not full marks — when nothing has ever been logged", () => {
    /* Scoring an unmeasurable component as full marks would make the worst-documented
       deals look the healthiest. */
    const h = dealHealth(input({ lastActivityAt: null }), NOW);
    expect(h.parts.recentTouch).toBe(0);
    expect(h.incomplete).toBe(true);
    expect(h.issues.some((i) => /Nobody has logged/i.test(i))).toBe(true);
  });
});

describe("movement", () => {
  it("full marks inside the SLA, nothing after three times it", () => {
    expect(dealHealth(input({ lead: { stage: "quote", follow_up_date: "2026-08-20", stage_changed_at: daysAgo(3) } as Lead }), NOW).parts.movement)
      .toBe(HEALTH_WEIGHT.movement);
    expect(dealHealth(input({ lead: { stage: "quote", follow_up_date: "2026-08-20", stage_changed_at: daysAgo(21) } as Lead }), NOW).parts.movement)
      .toBe(0);
  });

  it("is unmeasurable — and says so — when no stage date was recorded", () => {
    const h = dealHealth(input({ lead: { stage: "quote", follow_up_date: "2026-08-20", stage_changed_at: null } as Lead }), NOW);
    expect(h.parts.movement).toBe(0);
    expect(h.incomplete).toBe(true);
    expect(h.issues.some((i) => /movement cannot be judged/i.test(i))).toBe(true);
  });
});

describe("next step", () => {
  it("scores nothing when no follow-up is booked, and says so", () => {
    const h = dealHealth(input({ lead: { stage: "quote", follow_up_date: null, stage_changed_at: daysAgo(1) } as Lead }), NOW);
    expect(h.parts.nextStep).toBe(0);
    expect(h.issues).toContain("No follow-up booked.");
  });

  it("distinguishes a PASSED follow-up from a missing one", () => {
    /* Different problems, different fixes: one rep forgot to book, the other let the
       date slip. A single message for both helps neither. */
    const h = dealHealth(input({ lead: { stage: "quote", follow_up_date: "2026-01-01", stage_changed_at: daysAgo(1) } as Lead }), NOW);
    expect(h.parts.nextStep).toBe(0);
    expect(h.issues.some((i) => /has passed/i.test(i))).toBe(true);
  });

  it("counts a follow-up dated today as still booked", () => {
    const h = dealHealth(input({ lead: { stage: "quote", follow_up_date: TODAY, stage_changed_at: daysAgo(1) } as Lead }), NOW);
    expect(h.parts.nextStep).toBe(HEALTH_WEIGHT.nextStep);
  });
});

describe("bands", () => {
  it("at risk, slipping and healthy sit at the stated thresholds", () => {
    expect(AT_RISK_BELOW).toBeLessThan(SLIPPING_BELOW);
    // No touch, no movement, no next step, no reply.
    const worst = dealHealth(input({
      lead: { stage: "quote", follow_up_date: null, stage_changed_at: daysAgo(40) } as Lead,
      lastActivityAt: daysAgo(40), customerResponded: false,
    }), NOW);
    expect(worst.band).toBe("at_risk");
    expect(dealHealth(input(), NOW).band).toBe("healthy");
  });

  it("a CLOSED deal has no health — it is finished", () => {
    /* Reporting at_risk on a won deal would train people to ignore the badge. */
    for (const stage of ["won", "lost"] as const) {
      const h = dealHealth(input({
        lead: { stage, follow_up_date: null, stage_changed_at: daysAgo(90) } as Lead,
        lastActivityAt: null, customerResponded: false,
      }), NOW);
      expect(h.band).toBe("unknown");
    }
  });
});

describe("issues double as the to-do list", () => {
  it("names every gap in plain language", () => {
    const h = dealHealth(input({
      lead: { stage: "quote", follow_up_date: null, stage_changed_at: daysAgo(30) } as Lead,
      lastActivityAt: daysAgo(30), customerResponded: false,
    }), NOW);
    expect(h.issues).toHaveLength(4);
    for (const i of h.issues) expect(i.endsWith(".")).toBe(true);
  });
});

describe("healthBadge", () => {
  it("marks an incomplete score with a + so it reads as a floor", () => {
    const h = dealHealth(input({ lastActivityAt: null }), NOW);
    expect(healthBadge(h).label).toMatch(/\+$/);
  });

  it("renders a closed deal as a dash, not as a number", () => {
    const h = dealHealth(input({ lead: { stage: "won", follow_up_date: null, stage_changed_at: null } as Lead }), NOW);
    expect(healthBadge(h)).toEqual({ label: "—", kind: "muted" });
  });
});

describe("a brand-new lead is never 'going cold' (R-490 / R-456)", () => {
  const fresh = (minutesOld: number, over: Partial<Lead> = {}) => ({
    lead: {
      stage: "new", follow_up_date: null, stage_changed_at: null,
      created_at: new Date(NOW.getTime() - minutesOld * 60_000).toISOString(), ...over,
    } as Lead,
    lastActivityAt: null,
    customerResponded: false,
    today: TODAY,
  });

  it("2 minutes old, nothing logged: not at risk, only the follow-up is asked for", () => {
    const h = dealHealth(fresh(2), NOW);
    expect(h.band).toBe("healthy");
    expect(h.issues).toEqual(["No follow-up booked."]);
    expect(h.incomplete).toBe(false);
  });

  it("23 hours old still gets the grace", () => {
    expect(dealHealth(fresh(23 * 60), NOW).band).not.toBe("at_risk");
  });

  it("after a day the same untouched lead is at risk again", () => {
    const h = dealHealth(fresh(25 * 60), NOW);
    expect(h.band).toBe("at_risk");
    expect(h.issues).toContain("No reply from the customer yet.");
  });

  it("a lead with no created_at is scored as before", () => {
    const h = dealHealth({ ...fresh(2), lead: { stage: "new", follow_up_date: null, stage_changed_at: null } as Lead }, NOW);
    expect(h.band).toBe("at_risk");
  });
});
