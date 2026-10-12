/**
 * R-005 — a customer who buys custom software is not a dead account.
 *
 * The case that matters is Demo Co: one active ₹10,80,000 project, no
 * subscription. The list called it "No subscription, ₹0" and filed it under the filter
 * an owner uses to find churn.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  customerPortfolioStatus, countsAsNoBusiness, projectValue,
  wonProjects, proposedProjects,
} from "./portfolio-status";

const ACTIVE_ERP = { status: "active", total_amount: 1080000 };
const QUOTED     = { status: "quoted", total_amount: 500000 };
const CANCELLED  = { status: "cancelled", total_amount: 900000 };

describe("customerPortfolioStatus", () => {
  it("calls a customer with an active project a project client", () => {
    expect(customerPortfolioStatus({ projects: [ACTIVE_ERP], hasActiveSub: false, archived: false }))
      .toMatchObject({ label: "Project client" });
  });

  it("does NOT call a mere quotation a client", () => {
    /* A quotation is a document, not a relationship. Claiming otherwise is the same
       overstatement as counting a quote as revenue. */
    expect(customerPortfolioStatus({ projects: [QUOTED], hasActiveSub: false, archived: false }))
      .toMatchObject({ label: "Project quoted" });
  });

  it("still says 'No subscription' for a customer with nothing", () => {
    expect(customerPortfolioStatus({ projects: [], hasActiveSub: false, archived: false }))
      .toMatchObject({ label: "No subscription" });
  });

  it("a cancelled project is not work", () => {
    expect(customerPortfolioStatus({ projects: [CANCELLED], hasActiveSub: false, archived: false }))
      .toMatchObject({ label: "No subscription" });
  });

  it("a subscription outranks a project — recurring is the headline", () => {
    expect(customerPortfolioStatus({ projects: [ACTIVE_ERP], hasActiveSub: true, archived: false }))
      .toMatchObject({ label: "Active" });
  });

  it("archived beats everything — it is a statement about the record", () => {
    expect(customerPortfolioStatus({ projects: [ACTIVE_ERP], hasActiveSub: true, archived: true }))
      .toMatchObject({ label: "Inactive" });
  });
});

describe("countsAsNoBusiness — what the 'No subscription' filter should catch", () => {
  it("excludes a customer doing project work", () => {
    // THE BUG. Demo Co appeared in this filter beside dead accounts.
    expect(countsAsNoBusiness({ projects: [ACTIVE_ERP], hasActiveSub: false })).toBe(false);
  });

  it("still includes a customer with only a quotation", () => {
    // No subscription and nothing won is genuinely no business yet.
    expect(countsAsNoBusiness({ projects: [QUOTED], hasActiveSub: false })).toBe(true);
  });

  it("still includes a truly empty customer", () => {
    expect(countsAsNoBusiness({ projects: [], hasActiveSub: false })).toBe(true);
  });

  it("excludes anyone with a subscription", () => {
    expect(countsAsNoBusiness({ projects: [], hasActiveSub: true })).toBe(false);
  });
});

describe("projectValue", () => {
  it("totals won work only", () => {
    expect(projectValue([ACTIVE_ERP, QUOTED, CANCELLED])).toBe(1080000);
  });

  it("counts a completed project — the money was real", () => {
    expect(projectValue([{ status: "completed", total_amount: 250000 }])).toBe(250000);
  });

  it("is zero, not NaN, when a project has no amount", () => {
    expect(projectValue([{ status: "active", total_amount: null }])).toBe(0);
  });

  it("ignores a negative amount rather than subtracting it", () => {
    // A negative contract value is bad data; letting it reduce the portfolio total
    // would hide it behind a smaller-but-plausible number (AGENTS.md §2).
    expect(projectValue([ACTIVE_ERP, { status: "active", total_amount: -5000 }])).toBe(1080000);
  });

  it("is zero for a customer with no projects", () => {
    expect(projectValue([])).toBe(0);
  });
});

describe("status buckets", () => {
  it("treats a draft as proposed, not as work", () => {
    expect(wonProjects([{ status: "draft" }])).toHaveLength(0);
    expect(proposedProjects([{ status: "draft" }])).toHaveLength(1);
  });

  it("is case-insensitive about the status string", () => {
    expect(wonProjects([{ status: "ACTIVE" }])).toHaveLength(1);
  });

  it("treats a missing status as neither — an unknown is not a claim", () => {
    expect(wonProjects([{ status: null }])).toHaveLength(0);
    expect(proposedProjects([{ status: null }])).toHaveLength(0);
  });
});

describe("the customers page actually uses this rule", () => {
  /* The logic above is worthless if the page keeps its own copy — that is how the
     pill and the filter counts drifted apart in the first place. A scan, because a
     unit test cannot see a call site (L75, L98). */
  const src = readFileSync("src/app/(app)/customers/page.tsx", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("uses the shared status for the desktop row AND the mobile card", () => {
    const uses = src.split("customerPortfolioStatus({").length - 1;
    expect(uses, "both the table row and the phone card must call it").toBe(2);
  });

  it("has no local status function left behind", () => {
    expect(src).not.toMatch(/function subStatus\s*\(/);
  });

  it("the 'no business' filter goes through the tested rule", () => {
    expect(src).toContain("countsAsNoBusiness(");
  });

  it("offers a projects segment", () => {
    expect(src).toContain('id: "projects"');
  });

  it("keeps project value OUT of the recurring revenue figures", () => {
    /* The one mistake with real consequences here: a ₹10.8L one-off folded into
       "Yearly revenue" makes next year's forecast wrong by the whole amount. */
    expect(src).toMatch(/label: "Project value"/);
    expect(src).not.toMatch(/totalARR\s*\+\s*totalProjectValue/);
    expect(src).not.toMatch(/totalMRR\s*\+\s*totalProjectValue/);
  });
});
