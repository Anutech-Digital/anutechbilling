/**
 * R-2416 — who pays the online (Razorpay) fee on a bill, and how much.
 * Owner's ask (Pardeep, 3 Nov 2026): the customer pays the fee by default, but for some
 * customers / some bills we absorb it.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONLINE_FEE_SETTINGS,
  ONLINE_FEE_GST_PCT,
  onlineFeeEffectivePct,
  onlineFeeFor,
  onlineFeeLine,
  parseOnlineFeeSettings,
  type OnlineFeeSettings,
} from "./online-fee";

const settings = (over: Partial<OnlineFeeSettings> = {}): OnlineFeeSettings => ({ ...DEFAULT_ONLINE_FEE_SETTINGS, ...over });

describe("onlineFeeFor (R-2416)", () => {
  it("default: the customer pays the fee GROSSED UP so Razorpay's 2% on the fee is covered (owner decision 3 Nov)", () => {
    // B ₹11,800: fee = 0.02 × 11,800 / (1 − 0.02 × 1.18) = 236 / 0.9764 = ₹241.70 → ₹242;
    // GST 18% of ₹242 = ₹43.56 → ₹44; extra ₹286; the customer pays ₹12,086 online.
    const r = onlineFeeFor({ billTotal: 11800 }, null, settings());
    expect(r).toEqual({ bearer: "customer", fee: 242, gst: 44, total: 286, payable: 12086, reason: "customer_pays", note: null });
    expect(ONLINE_FEE_GST_PCT).toBe(18);
    // Razorpay's 2% + 18% GST on what is captured leaves the bill (± a rupee of rounding).
    expect(Math.abs(r.payable - r.payable * 0.02 * 1.18 - 11800)).toBeLessThanOrEqual(1);
  });

  it("rounds the grossed-up fee half up to the rupee, then GST on the ROUNDED fee, half up", () => {
    // ₹1,025: fee 20.995 → ₹21; GST 18% of ₹21 = ₹3.78 → ₹4.
    expect(onlineFeeFor({ billTotal: 1025 }, null, settings())).toMatchObject({ fee: 21, gst: 4, total: 25, payable: 1050 });
    // ₹1,000: fee 20.483 → ₹20 (down); GST ₹3.60 → ₹4 (up).
    expect(onlineFeeFor({ billTotal: 1000 }, null, settings())).toMatchObject({ fee: 20, gst: 4, total: 24, payable: 1024 });
    // A paise bill total is taken as given: ₹999.99 → fee 20.483 → ₹20.
    expect(onlineFeeFor({ billTotal: 999.99 }, null, settings())).toMatchObject({ fee: 20 });
  });

  it("uses the owner's rate (e.g. 2.15%)", () => {
    // ₹50,000: 1,075 / (1 − 0.0215 × 1.18) = 1,075 / 0.97463 = ₹1,102.98 → ₹1,103; GST ₹198.54 → ₹199.
    expect(onlineFeeFor({ billTotal: 50000 }, null, settings({ ratePct: 2.15 }))).toMatchObject({ fee: 1103, gst: 199, total: 1302, payable: 51302 });
  });

  it("the settings screen's effective rate: 2% → ≈2.05% of the bill", () => {
    expect(onlineFeeEffectivePct(2)).toBe(2.05);
    expect(onlineFeeEffectivePct(0)).toBe(0);
  });

  it("company default 'Us' → we absorb on every bill; the fee is still worked out (what it costs us)", () => {
    const r = onlineFeeFor({ billTotal: 11800 }, null, settings({ bearer: "business" }));
    expect(r).toEqual({ bearer: "business", fee: 242, gst: 44, total: 286, payable: 12086, reason: "company_default", note: null });
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
    expect(onlineFeeFor({ billTotal: 0 }, null, settings())).toMatchObject({ fee: 0, gst: 0, total: 0, payable: 0 });
    expect(onlineFeeFor({ billTotal: Number.NaN }, null, settings())).toMatchObject({ fee: 0, gst: 0, total: 0, payable: 0 });
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
      "Online fee: customer pays ₹286 (₹242 + ₹44 GST) if paid online — ₹12,086 in all. Bank transfer is free.",
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
