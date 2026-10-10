import { describe, it, expect } from "vitest";
import {
  coverageFor, entitlementRows, entitlementSummary, productLabel, detectTicketProduct,
  type SupportCoverage, type LicenceHolding,
} from "./entitlement";

const support = (over: Partial<SupportCoverage> = {}): SupportCoverage => ({
  subscriptionId: "sub-sup-1",
  planName: "ANUTECH DIGITAL PVT LTD Standard Support",
  tier: "standard",
  covered: "all",
  ...over,
});

const licence = (over: Partial<LicenceHolding> = {}): LicenceHolding => ({
  subscriptionId: "sub-1",
  plan: "Google Workspace Business Starter",
  vendor: "google",
  seats: 10,
  ...over,
});

describe("covered", () => {
  it("an `all` plan covers whatever they hold", () => {
    expect(coverageFor("google", [support()]).state).toBe("covered");
    expect(coverageFor("microsoft", [support()]).state).toBe("covered");
  });

  it("a product-specific plan covers exactly that product", () => {
    const google = [support({ covered: "google" })];
    expect(coverageFor("google", google).state).toBe("covered");
    expect(coverageFor("microsoft", google).state).toBe("uncovered");
  });

  it("names the plan that covers it, so the card can link to it", () => {
    const v = coverageFor("google", [support()]);
    expect(v.state).toBe("covered");
    if (v.state === "covered") expect(v.by.subscriptionId).toBe("sub-sup-1");
  });

  it("reports the BETTER plan first when two could cover it", () => {
    /* The caller sorts by tier. Reporting the weaker one understates what the
       customer bought — and an Enterprise customer would be shown a 4-hour SLA. */
    const v = coverageFor("google", [
      support({ subscriptionId: "ent", tier: "enterprise", planName: "Enterprise Support" }),
      support({ subscriptionId: "std", tier: "standard" }),
    ]);
    if (v.state === "covered") expect(v.by.subscriptionId).toBe("ent");
  });
});

describe("uncovered", () => {
  it("no support plan at all is uncovered, and says what to sell", () => {
    const v = coverageFor("google", []);
    expect(v.state).toBe("uncovered");
    if (v.state === "uncovered") {
      expect(v.reason).toMatch(/No support plan/);
      expect(v.nextStep.length).toBeGreaterThan(20);
    }
  });

  it("names what they DO have, not just what they lack", () => {
    /* A rep about to upsell needs to know the customer already pays for something —
       walking in with "you have no support" when they hold a Google plan is how a
       renewal conversation goes wrong. */
    const v = coverageFor("microsoft", [support({ covered: "google" })]);
    if (v.state === "uncovered") {
      expect(v.reason).toContain("Google Workspace");
      expect(v.reason).toContain("Microsoft 365");
    }
  });
});

describe("unknown — the answer that stops both mistakes", () => {
  it("an unclassified plan is UNKNOWN, not `all`", () => {
    /* Reading null as `all` tells a customer they are entitled to support nobody
       sold them, and they find out at the moment they need it. */
    const v = coverageFor("microsoft", [support({ covered: null })]);
    expect(v.state).toBe("unknown");
  });

  it("an unclassified plan is UNKNOWN, not `none`", () => {
    /* Reading null as none refuses support a paying customer did buy, and puts an
       upsell button in front of somebody who already paid. */
    const v = coverageFor("microsoft", [support({ covered: null })]);
    expect(v.state).not.toBe("uncovered");
  });

  it("names the SKU that needs classifying and where to fix it", () => {
    const v = coverageFor("microsoft", [support({ covered: null, planName: "Legacy AMC" })]);
    if (v.state === "unknown") {
      expect(v.reason).toContain("Legacy AMC");
      expect(v.nextStep).toMatch(/in Products/);
    }
  });

  it("a real match still wins over an unclassified one", () => {
    /* Unknown is only the answer when nothing actually covered it. */
    const v = coverageFor("google", [
      support({ subscriptionId: "unclassified", covered: null }),
      support({ subscriptionId: "real", covered: "google" }),
    ]);
    expect(v.state).toBe("covered");
    if (v.state === "covered") expect(v.by.subscriptionId).toBe("real");
  });
});

describe("detectTicketProduct", () => {
  const held = [
    licence({ vendor: "google",    plan: "Google Workspace Business Starter" }),
    licence({ subscriptionId: "s2", vendor: "microsoft", plan: "Microsoft 365 Business Basic" }),
  ];

  it("finds the plan named in the ticket", () => {
    expect(detectTicketProduct("Cannot log in to Microsoft 365 Business Basic", held)).toBe("microsoft");
  });

  it("falls back to a vendor word", () => {
    expect(detectTicketProduct("Our Gmail is bouncing", held)).toBe(null);
    expect(detectTicketProduct("Our Google Workspace is bouncing", held)).toBe("google");
    expect(detectTicketProduct("Outlook keeps asking for a password", held)).toBe("microsoft");
  });

  it("only counts a vendor the customer actually HOLDS", () => {
    /* "We are thinking of moving to Zoho" from a Google customer is not a Zoho
       support ticket, and treating it as one would raise an uncovered warning about
       a product they never bought. */
    expect(detectTicketProduct("We are thinking of moving to Zoho", held)).toBeNull();
  });

  it("prefers the longest plan name over a bare vendor word", () => {
    const both = [
      licence({ vendor: "google", plan: "Google" }),
      licence({ subscriptionId: "s9", vendor: "microsoft", plan: "Microsoft 365 Business Basic" }),
    ];
    expect(detectTicketProduct("issue with Microsoft 365 Business Basic on Google day", both)).toBe("microsoft");
  });

  it("returns null rather than guessing", () => {
    /* A wrong guess puts a "Not covered — upsell" banner in front of a rep over a
       product the customer never mentioned. */
    expect(detectTicketProduct("The invoice total looks wrong", held)).toBeNull();
    expect(detectTicketProduct("", held)).toBeNull();
    expect(detectTicketProduct(null, held)).toBeNull();
  });

  it("finds nothing when the customer holds nothing", () => {
    expect(detectTicketProduct("Google Workspace is down", [])).toBeNull();
  });
});

describe("entitlementRows", () => {
  it("pairs every licence with its verdict", () => {
    const rows = entitlementRows(
      [licence(), licence({ subscriptionId: "sub-2", vendor: "microsoft", plan: "M365 Basic" })],
      [support({ covered: "google" })],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].verdict.state).toBe("covered");
    expect(rows[1].verdict.state).toBe("uncovered");
  });

  it("leaves the support subscription out of the licence list", () => {
    /* Otherwise the card shows a row claiming the customer has support for their
       support, which is true and useless. */
    const rows = entitlementRows(
      [licence(), licence({ subscriptionId: "sup", vendor: "support", plan: "Standard Support" })],
      [support()],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].licence.vendor).toBe("google");
  });

  it("R-526: a domain registration is not a licence the support plan covers", () => {
    const rows = entitlementRows(
      [
        licence(),
        licence({ subscriptionId: "d1", vendor: "other", plan: "Domain registration (.in / .com / yr)" }),
        licence({ subscriptionId: "d2", vendor: "domain", plan: ".in" }),
      ],
      [support()],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].licence.vendor).toBe("google");
  });

  it("a customer with no licences has nothing to judge", () => {
    expect(entitlementRows([], [support()])).toEqual([]);
  });
});

describe("entitlementSummary", () => {
  it("counts the three states separately", () => {
    const rows = entitlementRows(
      [
        licence(),
        licence({ subscriptionId: "s2", vendor: "microsoft" }),
        licence({ subscriptionId: "s3", vendor: "zoho" }),
      ],
      [support({ covered: "google" }), support({ subscriptionId: "u", covered: null })],
    );
    const s = entitlementSummary(rows);
    expect(s.covered).toBe(1);     // google
    expect(s.unknown).toBe(2);     // microsoft + zoho, blocked by the unclassified plan
    expect(s.uncovered).toBe(0);
    expect(s.total).toBe(3);
  });
});

describe("productLabel", () => {
  it("says what a customer would recognise", () => {
    expect(productLabel("google")).toBe("Google Workspace");
    expect(productLabel("microsoft")).toBe("Microsoft 365");
    expect(productLabel("all")).toBe("All products");
  });

  it("does not blow up on something unrecognised", () => {
    expect(productLabel(null)).toBe("Other");
    expect(productLabel("martian")).toBe("Other");
  });
});
