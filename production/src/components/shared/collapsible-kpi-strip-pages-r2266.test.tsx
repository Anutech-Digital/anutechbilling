// R-2266 (Design D6 — work list above the fold, audit 31 Oct at 1280×800: first list row at
// y=874 on Quotes, 686 Invoices, 557 Companies, 536 Subscriptions). The five list pages use the
// ONE shared strip (closed by default, remembered per user); the banners that sat under the
// strip are linked counts on its line; header lines do not repeat the strip's numbers.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const page = (name: string) => read(`src/app/(app)/${name}/page.tsx`);

/** The source between `<CollapsibleKpiStrip` and its closing tag. */
function stripBlock(src: string) {
  const open = src.indexOf("<CollapsibleKpiStrip");
  const close = src.indexOf("</CollapsibleKpiStrip>");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return { open, close, body: src.slice(open, close) };
}

describe("R-2266 — every list page uses the shared strip, closed by default", () => {
  for (const [name, id] of [["quotes", "quotes"], ["invoices", "invoices"], ["renewals", "renewals"], ["customers", "customers"]] as const) {
    it(`${name}: <CollapsibleKpiStrip stripId="${id}"> with the user's id, no own open/closed state`, () => {
      const src = page(name);
      expect(src).toContain('from "@/components/shared/collapsible-kpi-strip"');
      expect(src).toMatch(new RegExp(`<CollapsibleKpiStrip\\s+stripId="${id}"\\s+userId=\\{`));
      /* the old per-page toggles started OPEN and forgot the choice on every visit */
      expect(src).not.toMatch(/const \[kpiOpen, setKpiOpen\] = React\.useState\(true\)/);
      expect(src).not.toMatch(/\{kpiOpen \? "Collapse" : "Expand"\}/);
    });
  }

  it("subscriptions: SubsInsightsStrip is built on the shared strip and gets the user's id", () => {
    const strip = read("src/components/features/subscriptions/subs-insights-strip.tsx");
    expect(strip).toContain("<CollapsibleKpiStrip");
    expect(strip).not.toMatch(/React\.useState\(/);           // no second open/closed mechanism
    expect(page("subscriptions")).toMatch(/<SubsInsightsStrip\s+userId=\{/);
  });

  it("the shared strip starts closed and stores the choice per user", () => {
    const src = read("src/components/shared/collapsible-kpi-strip.tsx");
    expect(src).toMatch(/useState\(false\)/);
    expect(src).toMatch(/ros\.kpi-strip\.\$\{stripId\}\.\$\{userId\}/);
  });
});

describe("R-2266 — banners moved onto the strip line (one click, not pushing the list down)", () => {
  it("quotes: Quote intelligence lives inside the strip, its count is a link on the line", () => {
    const src = page("quotes");
    const { open, close, body } = stripBlock(src);
    const gemini = src.indexOf('title="Quote intelligence"');
    expect(gemini).toBeGreaterThan(open);
    expect(gemini).toBeLessThan(close);
    expect(body).toMatch(/<StripLink[\s\S]*?onClick=\{\(\) => focusOn\("review"\)\}[\s\S]*?waiting on customer/);
  });

  it("quotes: Commitment due is a compact linked count on the strip line, not a banner under it", () => {
    const src = page("quotes");
    const { body } = stripBlock(src);
    expect(body).toMatch(/<CommitmentDueStrip\s+compact/);
    expect(src.match(/<CommitmentDueStrip\b/g)).toHaveLength(1);
    /* the section (opened from the link) still replaces the tabbed list */
    expect(src).toMatch(/commitmentOn && \(\s*<CommitmentDueSection/);
  });

  it("invoices: Fill missing costs is on the line and its dialog mounts outside the strip", () => {
    const src = page("invoices");
    const { close, body } = stripBlock(src);
    expect(body).toMatch(/<StripLink onClick=\{\(\) => setFillCostsOpen\(true\)\}/);
    const dialog = src.indexOf("<FillCostsDialog");
    expect(dialog).toBeGreaterThan(close);
  });

  it("renewals: the Renewal AI top pick is a link on the line", () => {
    const { body } = stripBlock(page("renewals"));
    expect(body).toMatch(/<StripLink[\s\S]*?Top risk: \{topHighRisk\}/);
  });
});

describe("R-2266 — no header-line number repeats the strip (one fact, one place)", () => {
  it("renewals: the page header no longer prints the yearly value at risk", () => {
    const src = page("renewals");
    const header = src.slice(src.indexOf("<h1"), src.indexOf("<CollapsibleKpiStrip"));
    expect(header).not.toMatch(/yearly value at risk/);
    expect(header).not.toMatch(/atRiskArr/);
  });

  it("renewals: the strip line carries money, the tabs carry the counts", () => {
    const { body } = stripBlock(page("renewals"));
    const summary = body.slice(body.indexOf("summary={"), body.indexOf("extras="));
    expect(summary).not.toMatch(/\.length/);
  });

  it("customers: the company count is not on the strip line (the All chip says it)", () => {
    const src = page("customers");
    expect(src).not.toMatch(/\{total\} Accounts/);
    const { body } = stripBlock(src);
    expect(body).toMatch(/stats\.filter\(\(t\) => t\.label !== "Companies"\)/);
  });
});
