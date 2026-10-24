/**
 * R-1417 — while someone types in "Report a problem", show reports their own company already
 * filed that look like the same problem, so they can see it is known instead of filing it again.
 */
import { describe, it, expect } from "vitest";
import { findSimilarReports, matchWords, MAX_SIMILAR, type ReportTitle } from "./similar-reports";

const r = (id: string, title: string, created_at = "2026-10-10T00:00:00Z", status = "open"): ReportTitle => ({ id, title, status, created_at });

describe("matchWords", () => {
  it("keeps the meaningful words, lower-cased, without filler words or duplicates", () => {
    expect(matchWords("The Invoice PDF is not downloading, invoice pdf!")).toEqual(["invoice", "pdf", "downloading"]);
  });
  it("drops Hinglish filler too", () => {
    expect(matchWords("invoice nahi ho raha hai")).toEqual(["invoice"]);
  });
});

describe("findSimilarReports", () => {
  const reports = [
    r("a", "Invoice PDF download fails on mobile"),
    r("b", "Quote page shows wrong GST"),
    r("c", "Invoice email not sent to customer"),
    r("d", "PDF download blank for invoice INV-12", "2026-10-12T00:00:00Z"),
  ];

  it("returns nothing for a few letters — no noise while the person is still starting", () => {
    expect(findSimilarReports("inv", reports)).toEqual([]);
  });

  it("finds reports sharing two or more words, best match first, newest first on a tie", () => {
    const out = findSimilarReports("invoice pdf download is broken", reports);
    expect(out.map((x) => x.id)).toEqual(["d", "a"]);
  });

  it("a one-word report does not match every report containing that word", () => {
    expect(findSimilarReports("invoice", reports)).toEqual([]);
  });

  it("matches word starts, so 'downloading' finds 'download'", () => {
    expect(findSimilarReports("invoice downloading", reports).map((x) => x.id)).toEqual(["d", "a"]);
  });

  it("never returns more than MAX_SIMILAR", () => {
    const many = Array.from({ length: 12 }, (_, i) => r(`m${i}`, `Invoice PDF broken ${i}`));
    expect(findSimilarReports("invoice pdf broken", many)).toHaveLength(MAX_SIMILAR);
    expect(MAX_SIMILAR).toBe(5);
  });

  it("returns only id, title, status and date — never a report body", () => {
    const withBody = [{ ...r("x", "Invoice PDF fails"), body: "secret details" } as ReportTitle];
    const [hit] = findSimilarReports("invoice pdf fails", withBody);
    expect(Object.keys(hit).sort()).toEqual(["created_at", "id", "status", "title"]);
  });
});
