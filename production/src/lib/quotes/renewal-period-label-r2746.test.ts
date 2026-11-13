/** R-2746 — the "Renewal · <from> – <to>" label above a renewal quote's lines. */
import { describe, it, expect } from "vitest";
import { renewalPeriodLabel, lineStartsAddsInfo } from "./renewal-period-label";
import { lineServicePeriod, quoteLinePeriodContext, linePeriodText } from "./service-period";
import { renewalLineStart } from "./renewal-editor";

const ws = { name: "Google Workspace Business Starter", commitment: "annual_yearly" };
/* An app-made subscription (start 13 Nov 2025, yearly) renewing on 13 Nov 2026. */
const renewalQuote = { is_renewal: true, extension_months: 12, renewal_term_date: "2026-11-13", created_date: "2026-11-01" };
const appSub = { domain: "acme.in", start_date: "2025-11-13", term_months: 12 };

describe("renewalPeriodLabel", () => {
  it("renewal quote → 'Renewal · 13 Nov 2026 – 12 Nov 2027', the SAME dates as the line's Subscription period (R-2727)", () => {
    const ctx = quoteLinePeriodContext(renewalQuote, appSub);
    const label = renewalPeriodLabel([ws], ctx);
    expect(label?.text).toBe("Renewal · 13 Nov 2026 – 12 Nov 2027");
    const p = lineServicePeriod(ws, ctx)!;
    expect([label?.from, label?.to]).toEqual([p.from, p.to]);
    expect(linePeriodText(ws, ctx)).toBe("Subscription period: 1 Year (13/11/2026 – 12/11/2027)");
  });
  it("Zoho-import row (renewal_date = last day) → the day after, still equal to the line's period", () => {
    const ctx = quoteLinePeriodContext(renewalQuote, { start_date: "2025-11-14", term_months: 12 });
    expect(renewalPeriodLabel([ws], ctx)?.text).toBe("Renewal · 14 Nov 2026 – 13 Nov 2027");
    expect(lineServicePeriod(ws, ctx)?.from).toBe("2026-11-14");
  });
  it("multi-year renewal (36 months) spans 3 years", () => {
    const ctx = quoteLinePeriodContext({ ...renewalQuote, extension_months: 36 }, appSub);
    expect(renewalPeriodLabel([ws], ctx)?.text).toBe("Renewal · 13 Nov 2026 – 12 Nov 2029");
  });
  it("month extension (3 months) → 'Extension · …'", () => {
    const ctx = quoteLinePeriodContext({ ...renewalQuote, is_extension: true, extension_months: 3 }, appSub);
    expect(renewalPeriodLabel([ws], ctx)?.text).toBe("Extension · 13 Nov 2026 – 12 Feb 2027");
  });
  it("a non-renewal quote shows nothing", () => {
    const ctx = quoteLinePeriodContext({ created_date: "2026-11-13" }, null);
    expect(renewalPeriodLabel([ws], ctx)).toBeNull();
    expect(renewalPeriodLabel([ws], null)).toBeNull();
  });
  it("old renewal row without renewal_term_date → no label (never today's date)", () => {
    const ctx = quoteLinePeriodContext({ ...renewalQuote, renewal_term_date: null }, appSub);
    expect(renewalPeriodLabel([ws], ctx)).toBeNull();
  });
  it("one-time lines carry no period: ignored; only one-time lines → no label", () => {
    const ctx = quoteLinePeriodContext(renewalQuote, appSub);
    const setup = { name: "Setup", commitment: "one_time", one_time: true };
    expect(renewalPeriodLabel([ws, setup], ctx)?.text).toBe("Renewal · 13 Nov 2026 – 12 Nov 2027");
    expect(renewalPeriodLabel([setup], ctx)).toBeNull();
    expect(renewalPeriodLabel([], ctx)).toBeNull();
  });
  it("a subscription line whose period is unknown (monthly line on a 12-month renewal: conflict) → no label", () => {
    const ctx = quoteLinePeriodContext(renewalQuote, appSub);
    const flex = { name: "Flex seats", commitment: "monthly" };
    expect(lineServicePeriod(flex, ctx)).toBeNull();
    expect(renewalPeriodLabel([ws, flex], ctx)).toBeNull();
    // ...and the editor keeps that line's Starts ("—"), so the unknown period still shows.
    expect(lineStartsAddsInfo(renewalLineStart(flex, ctx), null)).toBe(true);
  });
  it("lines that name different periods → no single label", () => {
    const ctx = quoteLinePeriodContext(renewalQuote, appSub);
    const seats = { name: "Seats (pro-rata from 2026-12-01 to 2027-11-12)", commitment: "annual_yearly" };
    expect(renewalPeriodLabel([ws, seats], ctx)).toBeNull();
  });
});

describe("lineStartsAddsInfo — the editor's Starts stops repeating the label", () => {
  const ctx = quoteLinePeriodContext(renewalQuote, appSub);
  const label = renewalPeriodLabel([ws], ctx);
  it("renewal line whose start = the label's start → hidden", () => {
    expect(lineStartsAddsInfo(renewalLineStart(ws, ctx), label)).toBe(false);
  });
  it("a one-time line on a renewal ('—') → hidden too: the label already says the period", () => {
    expect(lineStartsAddsInfo(renewalLineStart({ name: "Setup", one_time: true }, ctx), label)).toBe(false);
  });
  it("no label (new sale, or unknown period) → Starts as before", () => {
    expect(lineStartsAddsInfo({ kind: "editable" }, null)).toBe(true);
    expect(lineStartsAddsInfo({ kind: "fixed", date: null }, null)).toBe(true);
  });
});
