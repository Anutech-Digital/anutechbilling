/** R-1585 — PT has one home (pt.ts); the CTC calculator used to hard-code the slab (ctc.ts:147-149). */
import { describe, it, expect } from "vitest";
import { computePt } from "./pt";

describe("computePt", () => {
  it("keeps the slab the app has always used (moved out of ctc.ts, not changed)", () => {
    expect(computePt(10_000).monthly).toBe(0);
    expect(computePt(10_001).monthly).toBe(150);
    expect(computePt(15_000).monthly).toBe(150);
    expect(computePt(15_001).monthly).toBe(200);
    expect(computePt(30_000).monthly).toBe(200);
    expect(computePt(30_000).annual).toBe(2_400);
  });

  it("a custom PT for the employee overrides the slab; negatives become 0", () => {
    expect(computePt(30_000, { custom: 0 }).monthly).toBe(0);
    expect(computePt(30_000, { custom: 175 }).monthly).toBe(175);
    expect(computePt(30_000, { custom: -5 }).monthly).toBe(0);
  });

  it("an unknown state never gets invented slabs — it falls back to the default slab and says so", () => {
    const r = computePt(30_000, { state: "Atlantis" });
    expect(r.monthly).toBe(200);
    expect(r.slabSource).toBe("default");
  });
});
