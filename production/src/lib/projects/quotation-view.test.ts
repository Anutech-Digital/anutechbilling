import { describe, it, expect } from "vitest";
import { projectQuotationView, isQuotableProject } from "./quotation-view";

describe("projectQuotationView", () => {
  it("reads a quoted project as a live Quotation", () => {
    expect(projectQuotationView("quoted", null)).toMatchObject({ label: "Quotation", pending: true });
  });

  it("reads an accepted one as Accepted", () => {
    expect(projectQuotationView("active", "2026-09-20T10:00:00Z"))
      .toMatchObject({ label: "Accepted", pending: false });
  });

  it("prefers the acceptance timestamp over the status", () => {
    /* The timestamp is the event; the status is a summary of it and can be moved by
       other paths. */
    expect(projectQuotationView("quoted", "2026-09-20T10:00:00Z"))
      .toMatchObject({ label: "Accepted" });
  });

  it("still says Accepted for an older row with no timestamp", () => {
    // Projects created straight from a bank receipt never stamped accepted_at.
    expect(projectQuotationView("completed", null)).toMatchObject({ label: "Accepted" });
  });

  it("a cancelled project reads as Declined, and beats a stale timestamp", () => {
    expect(projectQuotationView("cancelled", "2026-09-20T10:00:00Z"))
      .toMatchObject({ label: "Declined", pending: false });
  });

  it("a draft is pending but not a quotation sent", () => {
    expect(projectQuotationView("draft", null)).toMatchObject({ label: "Draft", pending: true });
  });

  it("surfaces an unknown status instead of guessing a friendly one", () => {
    /* Picking the nicest label would make the list under-report open proposals, and
       nothing would ever show the mistake. */
    expect(projectQuotationView("on_hold", null)).toMatchObject({ label: "on_hold", pending: false });
    expect(projectQuotationView(null, null)).toMatchObject({ label: "Unknown" });
  });

  it("is case-insensitive", () => {
    expect(projectQuotationView("QUOTED", null)).toMatchObject({ label: "Quotation" });
  });
});

describe("isQuotableProject", () => {
  it("includes accepted projects — an accepted quote is still a quote", () => {
    // Hiding them is what made the Quotes tab look empty for Demo Co.
    expect(isQuotableProject("active")).toBe(true);
  });

  it("includes a cancelled one, so the trail stays complete", () => {
    expect(isQuotableProject("cancelled")).toBe(true);
  });

  it("excludes a row with no status at all", () => {
    expect(isQuotableProject(null)).toBe(false);
    expect(isQuotableProject("  ")).toBe(false);
  });
});
