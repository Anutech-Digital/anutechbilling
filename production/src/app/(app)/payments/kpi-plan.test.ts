/* R-1730 owner example: "Payments page → Awaiting GST invoice ek hi jagah" — a figure appears
   once on /payments, never in the strip AND a box AND Action needed. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { paymentsKpiPlan, type PaymentsKpi } from "./kpi-plan";

const all = (p: ReturnType<typeof paymentsKpiPlan>): PaymentsKpi[] => [...p.strip, ...p.tiles, ...p.actionCard];
const count = (xs: PaymentsKpi[], k: PaymentsKpi) => xs.filter((x) => x === k).length;

describe("paymentsKpiPlan (R-1730)", () => {
  for (const expanded of [true, false]) {
    for (const actionCardShown of [true, false]) {
      it(`every figure at most once — expanded=${expanded}, Action needed shown=${actionCardShown}`, () => {
        const p = paymentsKpiPlan({ expanded, actionCardShown });
        for (const k of ["collected", "partial", "awaiting", "topMethod"] as const) {
          expect(count(all(p), k)).toBeLessThanOrEqual(1);
        }
        /* …and never lost: awaiting-invoice is always somewhere. */
        expect(count(all(p), "awaiting")).toBe(1);
      });
    }
  }

  it("owner's screen (expanded, 3 awaiting → Action needed shown): Awaiting only in Action needed", () => {
    const p = paymentsKpiPlan({ expanded: true, actionCardShown: true });
    expect(p.strip).toEqual([]);
    expect(p.tiles).not.toContain("awaiting");
    expect(p.actionCard).toContain("awaiting");
  });
});

describe("/payments page uses the plan (R-1730)", () => {
  const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
  it("the strip and the boxes render from paymentsKpiPlan, not unconditionally", () => {
    expect(src).toMatch(/paymentsKpiPlan\(\{ expanded: kpiOpen, actionCardShown \}\)/);
    expect(src).toMatch(/kpi\.strip\.includes\("awaiting"\)/);
    expect(src).toMatch(/kpi\.tiles\.includes\("awaiting"\)/);
  });
});
