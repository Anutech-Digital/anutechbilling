/* R-2935 (staging 18 Nov 2026, Excel HDFC 4523): HDFC pays a closed FD on THREE bank lines —
   "FD REDEEM PRINCIPAL" (+₹10,00,000), "FD REDEEM INTEREST -50301205948354/1" (+₹8,014) and
   "FD REDEEM TAX - 50301205948354/1" (−₹801). The interest line was refused for ever ("looks like an
   FD coming back") only because its narration says REDEEM. */
import { describe, expect, it } from "vitest";

import { fdRedeemGuess, fdRedeemPart, looksLikeInterestTds, redeemVerdict } from "./interest-income";

describe("R-2935 fdRedeemPart — which part of an FD closure a line is", () => {
  it("the owner's three lines", () => {
    expect(fdRedeemPart("FD REDEEM INTEREST -50301205948354/1")).toBe("interest");
    expect(fdRedeemPart("FD REDEEM TAX - 50301205948354/1")).toBe("tax");
    expect(fdRedeemPart("FD REDEEM PRINCIPAL -50301205948354/1")).toBe("principal");
  });
  it("PRINCIPAL wins over INTEREST on one line; a plain redeem line is no part", () => {
    expect(fdRedeemPart("FD PREMAT PRINCIPAL AND INTEREST 5012")).toBe("principal");
    expect(fdRedeemPart("TO FD 50300112233 AUTO_REDEEM")).toBeNull();
    expect(fdRedeemPart("FD REDEEM PRIN 5012")).toBe("principal");
  });
});

describe("R-2935 redeemVerdict — may a redeem line be booked as plain interest?", () => {
  const fds = [{ id: "fd1", current_balance: 1000000 }, { id: "fd0", current_balance: 0 }, { id: "fdx", current_balance: null }];
  const ask = (description: string, credit: number, fdId: string | null, list: typeof fds = fds) =>
    redeemVerdict({ description, redeem: true, credit, fd: list.find((f) => f.id === fdId) ?? null, fds: list });

  it("owner's line: the FD it names is already at ₹0 (its principal line is reconciled) → free", () => {
    expect(ask("FD REDEEM INTEREST -50301205948354/1", 8014, "fd0")).toBe("free");
  });
  it("nothing proves the principal is elsewhere → the owner must say 'Interest only'", () => {
    expect(ask("FD REDEEM INTEREST -50301205948354/1", 8014, null)).toBe("ask");          // no FD picked
    expect(ask("FD REDEEM INTEREST -50301205948354/1", 8014, "fd1")).toBe("ask");         // FD still holds ₹10 L
    expect(ask("FD REDEEM INTEREST -50301205948354/1", 8014, "fdx")).toBe("ask");         // balance unknown
    expect(ask("FD PREMAT CLOSURE WITH INTEREST", 1008014, null, [])).toBe("ask");        // the FD is not in the app
    expect(ask("FD PREMAT PART WITHDRAWAL WITH INTEREST", 200500, "fd1")).toBe("ask");    // part of a ₹10 L FD
  });
  it("an 'interest' line as big as the FD it names is held (the principal is in it)", () => {
    expect(ask("FD PREMAT CLOSURE WITH INTEREST", 1008014, "fd1")).toBe("hold");
    expect(ask("FD PREMAT CLOSURE WITH INTEREST", 1000000, "fd1")).toBe("hold");
  });
  it("no FD picked: a line as big as one of the company's FDs is held", () => {
    expect(ask("FD PREMAT CLOSURE WITH INTEREST", 1008014, null)).toBe("hold");
  });
  it("a PRINCIPAL line, and a redeem line that says nothing about interest, are always held", () => {
    expect(ask("FD REDEEM PRINCIPAL -50301205948354/1", 1000000, "fd0")).toBe("hold");
    expect(ask("FD REDEEM PRINCIPAL -50301205948354/1", 500, "fd1")).toBe("hold");
    expect(ask("TO FD 50300112233 AUTO_REDEEM", 8014, "fd0")).toBe("hold");
  });
  it("a line that is not a redeem is free", () => {
    expect(redeemVerdict({ description: "INT ON FD 9911", redeem: false, credit: 5000000, fd: fds[0], fds })).toBe("free");
  });
});

describe("R-2935 the narration guess itself is unchanged for the interest line (R-2390 stays)", () => {
  it("FD REDEEM INTEREST is still a redeem line that names its FD", () => {
    const fd = { id: "fdx", name: "HDFC FD 50301205948354", account_number_last4: "8354" };
    expect(fdRedeemGuess("FD REDEEM INTEREST -50301205948354/1", [fd])).toEqual({ redeem: true, fdId: "fdx" });
  });
});

describe("R-2935 looksLikeInterestTds — the bank's own TDS line (money out)", () => {
  it("the owner's line and the usual bank words", () => {
    expect(looksLikeInterestTds("FD REDEEM TAX - 50301205948354/1")).toBe(true);
    expect(looksLikeInterestTds("TDS ON FD INT 50300112233")).toBe(true);
    expect(looksLikeInterestTds("TDS ON INTEREST")).toBe(true);
    expect(looksLikeInterestTds("TAX DEDUCTED ON TERM DEPOSIT 123456")).toBe(true);
  });
  it("a TDS challan, income tax, GST or a vendor are not it", () => {
    expect(looksLikeInterestTds("ITNS 281 TDS PAYMENT")).toBe(false);
    expect(looksLikeInterestTds("TDS CHALLAN CIN 12345")).toBe(false);
    expect(looksLikeInterestTds("ADVANCE TAX ITNS 280")).toBe(false);
    expect(looksLikeInterestTds("GST PAYMENT CIN 99")).toBe(false);
    expect(looksLikeInterestTds("NEFT DR-TAXMANN PUBLICATIONS")).toBe(false);
    expect(looksLikeInterestTds("TDS DEPOSIT Q2")).toBe(false);
    expect(looksLikeInterestTds("TDS DEPOSIT SEP")).toBe(false);
    expect(looksLikeInterestTds("TDS INTEREST 201(1A)")).toBe(false);
    expect(looksLikeInterestTds("TAX SAVER FD 5YR")).toBe(false);
    expect(looksLikeInterestTds("PROPERTY TAX MCD")).toBe(false);
    expect(looksLikeInterestTds(null)).toBe(false);
  });
});
