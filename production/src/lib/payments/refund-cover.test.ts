import { describe, it, expect } from "vitest";
import { refundCover } from "./refund-cover";

describe("refundCover — R-1563: refund on an invoiced quote needs credit-note cover", () => {
  it("no credit note → the whole cash is the gap (Credit note first)", () => {
    expect(refundCover({ cash: 11800, ownOpenCredit: 0, creditNoteCredit: 0 })).toEqual({ need: 11800, gap: 11800 });
  });

  it("a full credit note covers it → gap 0 (go on to the refund, no loop back to the invoice)", () => {
    expect(refundCover({ cash: 11800, ownOpenCredit: 0, creditNoteCredit: 11800 })).toEqual({ need: 11800, gap: 0 });
  });

  it("a smaller credit note leaves the rest as the gap", () => {
    expect(refundCover({ cash: 11800, ownOpenCredit: 0, creditNoteCredit: 1180 })).toEqual({ need: 11800, gap: 10620 });
  });

  it("the payment's own open overpayment credit counts (the refund closes it)", () => {
    expect(refundCover({ cash: 15000, ownOpenCredit: 3200, creditNoteCredit: 11800 })).toEqual({ need: 11800, gap: 0 });
  });

  it("never negative, whole rupees", () => {
    expect(refundCover({ cash: 100, ownOpenCredit: 500, creditNoteCredit: 0 })).toEqual({ need: 0, gap: 0 });
    expect(refundCover({ cash: Number.NaN, ownOpenCredit: 0, creditNoteCredit: 0 })).toEqual({ need: 0, gap: 0 });
  });
});
