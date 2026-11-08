/**
 * R-2587 (8 Nov 2026, Pardeep) — staging Q-A378-27-0021, billed quarterly: Part 1 ₹81,350 + GST
 * = ₹95,993, received ₹95,933. The page said "₹60 due now" with a big "Record instalment payment"
 * and no date for Part 2 — it read as if the customer owed money now.
 */
import { describe, it, expect } from "vitest";
import type { QuoteInstalmentPlan } from "@/lib/billing/instalments";
import { instalmentStatus, isSmallShort, instalmentHeadline, paidStepText } from "./instalment-status";

const rupee = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const fmt = (iso: string) => `d:${iso}`;

function quarterly(gross = 95_993): QuoteInstalmentPlan {
  const starts = ["2026-11-01", "2027-02-01", "2027-05-01", "2027-08-01"];
  const lines = starts.map((s, i) => ({
    index: i + 1, billOn: s, periodStart: s, periodEnd: starts[i + 1] ?? "2027-11-01",
    taxable: 81_350, tax: gross - 81_350, gross,
  }));
  return { cycle: "quarterly", count: 4, lines, instalmentsGross: gross * 4 };
}

describe("owner's quote Q-A378-27-0021 — ₹95,933 in on a ₹95,993 part", () => {
  const s = instalmentStatus(quarterly(), { received: 95_933, todayISO: "2026-11-08" });

  it("Part 1 is received with ₹60 short — not 'due'", () => {
    expect(s.parts[0]).toMatchObject({ index: 1, state: "short", received: 95_933, short: 60 });
    expect(s.smallShort).toEqual({ index: 1, amount: 60 });
    expect(s.settled).toBe(1);
  });

  it("the next part is Part 2 with its own date and amount", () => {
    expect(s.next).toMatchObject({ index: 2, billOn: "2027-02-01", gross: 95_993, state: "upcoming" });
  });

  it("headline says received (₹60 short) and the next part's date — never 'due now'", () => {
    const h = instalmentHeadline(s, fmt, rupee)!;
    expect(h).toBe("Part 1 of 4 received (₹60 short) · next part ₹95,993 on d:2027-02-01");
    expect(h).not.toMatch(/due now/);
  });

  it("PAID step: 'Part 1 of 4 paid (₹60 short) · next on <date>'", () => {
    expect(paidStepText(s, fmt, rupee)).toBe("Part 1 of 4 paid (₹60 short) · next on d:2027-02-01");
  });
});

describe("other shapes", () => {
  it("Part 1 paid in full → paid, next Part 2", () => {
    const s = instalmentStatus(quarterly(), { received: 95_993, todayISO: "2026-11-08" });
    expect(s.parts[0].state).toBe("paid");
    expect(s.smallShort).toBeNull();
    expect(instalmentHeadline(s, fmt, rupee)).toBe("Part 1 of 4 received · next part ₹95,993 on d:2027-02-01");
    expect(paidStepText(s, fmt, rupee)).toBe("Part 1 of 4 paid · next on d:2027-02-01");
  });

  it("half of Part 1 in → a real part payment, still due (no 'received' headline)", () => {
    const s = instalmentStatus(quarterly(), { received: 50_000, todayISO: "2026-11-08" });
    expect(s.parts[0]).toMatchObject({ state: "part", received: 50_000, short: 45_993 });
    expect(s.settled).toBe(0);
    expect(instalmentHeadline(s, fmt, rupee)).toBeNull();
    expect(paidStepText(s, fmt, rupee)).toBeNull();
  });

  it("nothing in → Part 1 due today, later parts upcoming; no headline", () => {
    const s = instalmentStatus(quarterly(), { received: 0, todayISO: "2026-11-08" });
    expect(s.parts.map((p) => p.state)).toEqual(["due", "upcoming", "upcoming", "upcoming"]);
    expect(instalmentHeadline(s, fmt, rupee)).toBeNull();
  });

  it("Part 2's date has come and it is unpaid → it is 'due', not upcoming", () => {
    const s = instalmentStatus(quarterly(), { received: 95_993, todayISO: "2027-02-03" });
    expect(s.parts[1].state).toBe("due");
  });

  it("every part paid → 'All 4 parts paid', no next", () => {
    const s = instalmentStatus(quarterly(), { received: 95_993 * 4, todayISO: "2027-09-01" });
    expect(s.next).toBeNull();
    expect(paidStepText(s, fmt, rupee)).toBe("All 4 parts paid");
  });

  it("small = at most 1% of the part, never over ₹500, at least ₹1", () => {
    expect(isSmallShort(60, 95_993)).toBe(true);
    expect(isSmallShort(500, 95_993)).toBe(true);
    expect(isSmallShort(501, 95_993)).toBe(false);
    expect(isSmallShort(9_990, 10_00_000)).toBe(false);
    expect(isSmallShort(200, 20_000)).toBe(true);
    expect(isSmallShort(201, 20_000)).toBe(false);
    expect(isSmallShort(1, 50)).toBe(true);
    expect(isSmallShort(0, 95_993)).toBe(false);
  });
});
