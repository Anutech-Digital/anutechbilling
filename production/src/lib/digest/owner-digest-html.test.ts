import { describe, expect, it } from "vitest";
import { buildDigestEmail, escapeHtml, ownerDigestHtml } from "./owner-digest-html";
import type { OwnerDigest } from "./owner-digest";

const D: OwnerDigest = {
  day: "2026-10-06",
  moneyIn: { count: 2, value: 61800 },
  overdue: { count: 1, value: 23600 },
  waiting: { held: 1, quotes: 1, total: 2, examples: ["Reply to <script>alert(1)</script> held"] },
  renewals: { count: 3, value: 4950 },
};

describe("R-112 owner digest email body", () => {
  it("HTML carries all four numbers with Indian grouping and links into the app", () => {
    const html = ownerDigestHtml(D, "https://app.example/");
    expect(html).toContain("₹61,800");
    expect(html).toContain("from 2 payments");
    expect(html).toContain("₹23,600 still owed");
    expect(html).toContain("1 AI action held, 1 quote to approve");
    expect(html).toContain("₹4,950 MRR at stake");
    expect(html).toContain('href="https://app.example/invoices?tab=overdue"');
    expect(html).toContain('href="https://app.example/subscriptions?tab=expiring"');
  });

  it("escapes AI-written reasons so they cannot inject markup", () => {
    const html = ownerDigestHtml(D, "");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(escapeHtml(`a&b"'`)).toBe("a&amp;b&quot;&#39;");
  });

  it("quiet day: nothing highlighted red", () => {
    const quiet: OwnerDigest = {
      day: "2026-10-06", moneyIn: { count: 0, value: 0 }, overdue: { count: 0, value: 0 },
      waiting: { held: 0, quotes: 0, total: 0, examples: [] }, renewals: { count: 0, value: 0 },
    };
    expect(ownerDigestHtml(quiet, "")).not.toContain("#b42318");
    expect(ownerDigestHtml(D, "")).toContain("#b42318");
  });

  it("subject, text and html come from the same digest", () => {
    const e = buildDigestEmail(D, "https://app.example");
    expect(e.subject).toBe("ResellerOS morning: ₹61,800 in, 1 overdue, 2 waiting on you");
    expect(e.text).toContain("Money in yesterday: ₹61,800");
    expect(e.html).toContain("₹61,800");
  });
});
