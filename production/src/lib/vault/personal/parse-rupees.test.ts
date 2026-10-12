// R-1419: "Add investment" sent 1e+21 into a bigint column and got a 400.
import { describe, it, expect } from "vitest";
import { parseRupees, MAX_RUPEES } from "./parse-rupees";

describe("parseRupees (R-1419)", () => {
  it("reads plain, comma'd and ₹ amounts as whole rupees", () => {
    expect(parseRupees("50000")).toEqual({ ok: true, value: 50000 });
    expect(parseRupees("₹ 1,50,000")).toEqual({ ok: true, value: 150000 });
    expect(parseRupees("1999.6")).toEqual({ ok: true, value: 2000 });
    expect(parseRupees("")).toEqual({ ok: true, value: 0 });
  });

  it("refuses text", () => {
    expect(parseRupees("abc")).toEqual({ ok: false, reason: "not_a_number" });
    expect(parseRupees("1e5")).toEqual({ ok: false, reason: "not_a_number" });
    expect(parseRupees("-5")).toEqual({ ok: false, reason: "not_a_number" });
  });

  it("refuses a huge number instead of sending 1e+21 to a bigint column", () => {
    expect(parseRupees("1000000000000000000000")).toEqual({ ok: false, reason: "too_big" });
    expect(parseRupees(String(MAX_RUPEES + 1))).toEqual({ ok: false, reason: "too_big" });
  });

  it("a large but real amount serialises as plain digits", () => {
    const r = parseRupees("99,00,00,00,000"); // ₹9,900 crore
    expect(r).toEqual({ ok: true, value: 99_00_00_00_000 });
    if (r.ok) expect(JSON.stringify({ invested: r.value })).toBe('{"invested":99000000000}');
    const max = parseRupees(String(MAX_RUPEES));
    expect(max.ok && JSON.stringify(max.value)).toBe("1000000000000");
  });
});
