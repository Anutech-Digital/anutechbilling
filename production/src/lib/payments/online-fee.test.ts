/**
 * R-2416 — who pays the online (Razorpay) fee on a bill, and how much.
 * Owner's ask (Pardeep, 3 Nov 2026): the customer pays the fee by default, but for some
 * customers / some bills we absorb it.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONLINE_FEE_SETTINGS,
  ONLINE_FEE_GST_PCT,
  onlineFeeFor,
  onlineFeeLine,
  parseOnlineFeeSettings,
  type OnlineFeeSettings,
} from "./online-fee";

const settings = (over: Partial<OnlineFeeSettings> = {}): OnlineFeeSettings => ({ ...DEFAULT_ONLINE_FEE_SETTINGS, ...over });

describe("onlineFeeFor (R-2416)", () => {
  it("default: the customer pays 2% of the bill total + 18% GST on that fee, whole rupees", () => {
    // ₹11,800 bill (₹10,000 + GST) → fee 2% = ₹236, GST 18% of ₹236 = ₹42.48 → ₹42; total ₹278.
    const r = onlineFeeFor({ billTotal: 11800 }, null, settings());
    expect(r).toEqual({ bearer: "customer", fee: 236, gst: 42, total: 278, reason: "customer_pays", note: null });
    expect(ONLINE_FEE_GST_PCT).toBe(18);
  });

  it("rounds the fee first, then GST on the rounded fee — both half up to the rupee", () => {
    // ₹1,025 × 2% = ₹20.50 → ₹21; GST 18% of ₹21 = ₹3.78 → ₹4.
    expect(onlineFeeFor({ billTotal: 1025 }, null, settings())).toMatchObject({ fee: 21, gst: 4, total: 25 });
    // ₹1,024 × 2% = ₹20.48 → ₹20; GST ₹3.60 → ₹4.
    expect(onlineFeeFor({ billTotal: 1024 }, null, settings())).toMatchObject({ fee: 20, gst: 4, total: 24 });
    // A paise bill total is taken as given: ₹999.99 × 2% = ₹19.9998 → ₹20.
    expect(onlineFeeFor({ billTotal: 999.99 }, null, settings())).toMatchObject({ fee: 20 });
  });

  it("uses the owner's rate (e.g. 2.15%)", () => {
    // ₹50,000 × 2.15% = ₹1,075; GST ₹193.50 → ₹194.
    expect(onlineFeeFor({ billTotal: 50000 }, null, settings({ ratePct: 2.15 }))).toMatchObject({ fee: 1075, gst: 194, total: 1269 });
  });

  it("company default 'Us' → we absorb on every bill; the fee is still worked out (what it costs us)", () => {
    const r = onlineFeeFor({ billTotal: 11800 }, null, settings({ bearer: "business" }));
    expect(r).toEqual({ bearer: "business", fee: 236, gst: 42, total: 278, reason: "company_default", note: null });
  });

  it("customer 'We absorb for this customer' beats the company default, with its reason", () => {
    const r = onlineFeeFor({ billTotal: 11800 }, { override: "absorb", reason: "Key account since 2019" }, settings());
    expect(r).toMatchObject({ bearer: "business", reason: "customer_absorbs", note: "Key account since 2019" });
  });

  it("customer 'Default' follows the company setting", () => {
    expect(onlineFeeFor({ billTotal: 11800 }, { override: null, reason: null }, settings()).bearer).toBe("customer");
  });

  it("'Waive online fee for this bill' beats everything, with its reason", () => {
    const r = onlineFeeFor(
      { billTotal: 11800, waived: true, waiveReason: "Promised on call" },
      { override: "absorb", reason: "Key account" },
      settings(),
    );
    expect(r).toMatchObject({ bearer: "business", reason: "bill_waived", note: "Promised on call" });
  });

  it("waive when bill ≥ ₹X: at the line and above we absorb; below it the customer pays", () => {
    const s = settings({ waiveAbove: 100000 });
    expect(onlineFeeFor({ billTotal: 100000 }, null, s)).toMatchObject({ bearer: "business", reason: "above_threshold" });
    expect(onlineFeeFor({ billTotal: 150000 }, null, s)).toMatchObject({ bearer: "business", reason: "above_threshold" });
    expect(onlineFeeFor({ billTotal: 99999 }, null, s)).toMatchObject({ bearer: "customer", reason: "customer_pays" });
  });

  it("a zero or missing bill has no fee", () => {
    expect(onlineFeeFor({ billTotal: 0 }, null, settings())).toMatchObject({ fee: 0, gst: 0, total: 0 });
    expect(onlineFeeFor({ billTotal: Number.NaN }, null, settings())).toMatchObject({ fee: 0, gst: 0, total: 0 });
  });
});

describe("parseOnlineFeeSettings (R-2416)", () => {
  it("missing columns / nulls → Customer pays 2%, no threshold", () => {
    expect(parseOnlineFeeSettings(null)).toEqual(DEFAULT_ONLINE_FEE_SETTINGS);
    expect(DEFAULT_ONLINE_FEE_SETTINGS).toEqual({ bearer: "customer", ratePct: 2, waiveAbove: null, lineText: null });
  });
  it("reads the tenant row", () => {
    expect(parseOnlineFeeSettings({
      online_fee_bearer: "business", online_fee_rate_pct: "2.15", online_fee_waive_above: 200000, online_fee_line_text: "Card / UPI fee",
    })).toEqual({ bearer: "business", ratePct: 2.15, waiveAbove: 200000, lineText: "Card / UPI fee" });
  });
});

describe("onlineFeeLine (R-2416) — what the quote / invoice shows", () => {
  it("customer pays", () => {
    expect(onlineFeeLine(onlineFeeFor({ billTotal: 11800 }, null, settings()))).toBe(
      "Online fee: customer pays ₹278 (₹236 + ₹42 GST) if paid online. Bank transfer is free.",
    );
  });
  it("waived for the bill, with the reason", () => {
    expect(onlineFeeLine(onlineFeeFor({ billTotal: 11800, waived: true, waiveReason: "Promised on call" }, null, settings()))).toBe(
      "Online fee: waived for this bill — Promised on call",
    );
  });
  it("absorbed for the customer / by company default / above the threshold", () => {
    expect(onlineFeeLine(onlineFeeFor({ billTotal: 11800 }, { override: "absorb", reason: "Key account" }, settings())))
      .toBe("Online fee: we absorb it for this customer — Key account");
    expect(onlineFeeLine(onlineFeeFor({ billTotal: 11800 }, null, settings({ bearer: "business" }))))
      .toBe("Online fee: we absorb it (company setting)");
    const s = settings({ waiveAbove: 100000 });
    expect(onlineFeeLine(onlineFeeFor({ billTotal: 150000 }, null, s), s))
      .toBe("Online fee: we absorb it — bill is ₹1,00,000 or more");
  });
});
