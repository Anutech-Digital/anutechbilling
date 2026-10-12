import { describe, it, expect } from "vitest";
import { tdsSplitFromNet, TDS_SECTIONS } from "./tds-split";

describe("tdsSplitFromNet — back from the bank receipt to the invoice", () => {
  it("the Demo Co receipt: ₹5,40,000 at 18% GST, 10% TDS = ₹5,00,000 + GST, ₹50,000 TDS", () => {
    expect(tdsSplitFromNet(540_000, 18, 10)).toEqual({ taxable: 500_000, gst: 90_000, gross: 590_000, tds: 50_000, net: 540_000 });
  });

  it("TDS is on the pre-GST value, not on the invoice total", () => {
    const s = tdsSplitFromNet(540_000, 18, 10);
    expect(s.tds).toBe(Math.round(s.taxable * 0.1));
    expect(s.tds).not.toBe(Math.round(s.gross * 0.1));
  });

  it("the parts always add up to the rupee, even when the numbers are not round", () => {
    for (const [net, tds] of [[117_640, 2], [99_999, 1], [1_23_457, 10]] as const) {
      const s = tdsSplitFromNet(net, 18, tds);
      expect(s.gross - s.tds).toBe(net);
      expect(s.taxable + s.gst).toBe(s.gross);
    }
  });

  it("offers 194J 10% first — the software-development case", () => {
    expect(TDS_SECTIONS[0]).toMatchObject({ section: "194J", ratePct: 10 });
  });
});
