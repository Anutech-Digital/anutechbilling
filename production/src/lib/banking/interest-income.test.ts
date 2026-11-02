/* R-2366: interest income split — FD closure principal + interest (+ TDS). */
import { describe, expect, it } from "vitest";

import { guessInterestSource, interestSplit } from "./interest-income";

describe("R-2366 guessInterestSource", () => {
  it("reads FD / savings from the narration", () => {
    expect(guessInterestSource("FD PREMAT CLOSURE 50100")).toBe("fd");
    expect(guessInterestSource("INT ON FD 501234")).toBe("fd");
    expect(guessInterestSource("SB INT CREDIT")).toBe("savings");
    expect(guessInterestSource("INT.PD 01-07-26 TO 30-09-26")).toBe("other");
  });
});

describe("R-2366 interestSplit", () => {
  it("plain interest: the whole line is interest", () => {
    expect(interestSplit({ credit: 88, principal: 0, tds: 0 })).toEqual({ interest: 88, gross: 88, error: null });
  });
  it("FD closure ₹1,05,400 = ₹1,00,000 principal + ₹5,400 interest, TDS ₹600 → income ₹6,000", () => {
    expect(interestSplit({ credit: 105400, principal: 100000, tds: 600, fdBalance: 100000 }))
      .toEqual({ interest: 5400, gross: 6000, error: null });
  });
  it("principal above the FD balance or the whole line is refused", () => {
    expect(interestSplit({ credit: 105400, principal: 100001, tds: 0, fdBalance: 100000 }).error).toMatch(/FD's balance/);
    expect(interestSplit({ credit: 105400, principal: 105400, tds: 0 }).error).toMatch(/less than the bank line/);
    expect(interestSplit({ credit: 100, principal: 0, tds: -1 }).error).toMatch(/negative/);
  });
});
