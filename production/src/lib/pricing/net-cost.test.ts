import { describe, it, expect } from "vitest";
import { authorisedNetCostFigures, computeNetCost, netCostLines } from "./net-cost";

/** ANUTECH's own, and a real checksum-valid GSTIN (CLAUDE.md §1). */
const GSTIN = "07ABDCA0298H1ZP";

/* The live deal from 24 Aug: 12 seats of Business Standard, annual.
   12 × (864 × 12) = ₹1,24,416 ex-GST; +18% = ₹1,46,811. */
const REAL_DEAL = { subtotal: 124_416, discountPct: 0, taxRate: 18 };

describe("computeNetCost", () => {
  it("reproduces the real quote to the rupee", () => {
    /* Q-ADPL-2026-27-0058, priced live on 24 Aug. If this module and the quote disagree by a
       rupee, one of them is telling the customer something the document does not say. */
    const net = computeNetCost({ ...REAL_DEAL, buyerGstin: GSTIN });
    expect(net.taxableValue).toBe(124_416);
    expect(net.gst).toBe(22_395);
    expect(net.payable).toBe(146_811);
    expect(net.netCost).toBe(124_416);
  });

  it("applies the volume discount BEFORE the GST, as the document does", () => {
    /* Every screen computes `discount = round(subtotal × pct/100)` and taxes what is left.
       Taxing the full subtotal and discounting afterwards gives a different number, and the
       customer would be reading one while we stated the other. */
    const net = computeNetCost({ subtotal: 162_000, discountPct: 3, taxRate: 18, buyerGstin: GSTIN });
    expect(net.discountValue).toBe(4_860);
    expect(net.taxableValue).toBe(157_140);
    expect(net.gst).toBe(28_285);
    expect(net.payable).toBe(185_425);
  });

  it("keeps whole rupees throughout", () => {
    const net = computeNetCost({ subtotal: 48_601, discountPct: 3, taxRate: 18, buyerGstin: GSTIN });
    for (const v of [net.discountValue, net.taxableValue, net.gst, net.payable, net.netCost]) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe("ITC is gated on a GSTIN we actually have", () => {
  it("claims nothing when there is no GSTIN on record", () => {
    /* THE TEST THIS MODULE EXISTS FOR. Measured on production: 16 of 28 leads have no GSTIN.
       Input tax credit is worth nothing to an unregistered business, so telling those sixteen
       they are "saving" the GST is not optimism, it is false. */
    const net = computeNetCost({ ...REAL_DEAL, buyerGstin: null });
    expect(net.itcApplicable).toBe(false);
    expect(net.itcClaimable).toBe(0);
    expect(net.netCost, "net cost is the full payable when nothing can be claimed").toBe(146_811);
  });

  it.each([null, undefined, "", "   ", "not-a-gstin", "07ABDCA0298H1ZQ"])(
    "refuses to claim ITC for %s",
    (gstin) => {
      /* The last one is checksum-invalid: right length, one character wrong. A length check
         would put a claimable-tax figure against an invalid tax identity. */
      expect(computeNetCost({ ...REAL_DEAL, buyerGstin: gstin }).itcApplicable).toBe(false);
    },
  );

  it("claims the full GST when the GSTIN is valid", () => {
    const net = computeNetCost({ ...REAL_DEAL, buyerGstin: `  ${GSTIN}  ` });
    expect(net.itcApplicable).toBe(true);
    expect(net.itcClaimable).toBe(net.gst);
  });
});

describe("netCostLines — what the agent is allowed to say", () => {
  const withGstin = () => netCostLines(computeNetCost({ ...REAL_DEAL, buyerGstin: GSTIN }), "ANUTECH DIGITAL PVT LTD").join("\n");
  const without = () => netCostLines(computeNetCost({ ...REAL_DEAL, buyerGstin: null }), "ANUTECH DIGITAL PVT LTD").join("\n");

  it("states the payable, the claimable GST and the net cost", () => {
    const text = withGstin();
    expect(text).toContain("Rs 1,46,811");
    expect(text).toContain("Rs 22,395");
    expect(text).toContain("Rs 1,24,416");
  });

  it("says CLAIM, never SAVE, about input tax credit", () => {
    /* ITC is tax the buyer pays and reclaims — a real benefit, and not a discount. "Saved"
       overstates it, because they were never going to keep that money either way. */
    const text = withGstin();
    expect(text).toContain("claim back as input tax credit");
    expect(text.toLowerCase()).not.toContain("saved");
    expect(text.toLowerCase()).not.toContain("savings");
  });

  it("asks for the GSTIN instead of claiming ITC when there is none", () => {
    /* CLAUDE.md §24 — no dead ends. The number is real and the only missing input is theirs. */
    const text = without();
    expect(text).toContain("Share your GSTIN");
    expect(text).not.toContain("claim back as input tax credit");
  });

  it("NEVER mentions Google, reverse charge, or what a competitor charges", () => {
    /* Google bills Indian customers through Google Cloud India Pvt Ltd with an Indian GSTIN —
       ordinary GST, ordinary ITC. Reverse charge applies to an IMPORT of service. Which one a
       given buyer gets depends on the entity that invoices them, which we cannot know, so an
       automated claim about it may simply be false. */
    for (const text of [withGstin(), without()]) {
      const lower = text.toLowerCase();
      expect(lower).not.toContain("google");
      expect(lower).not.toContain("reverse charge");
      expect(lower).not.toContain("direct");
    }
  });

  it("NEVER puts a percentage on the buyer's card", () => {
    /* A forex markup is a fact about their bank — issuers charge roughly 1.75%–3.5%. The
       rupee-billing point is made as a fact about OUR invoice instead. */
    for (const text of [withGstin(), without()]) {
      expect(text).not.toContain("3.5%");
      expect(text).not.toMatch(/forex fee/i);
      expect(text).toContain("Billed in rupees");
    }
  });

  it("invents no value for anything we give away", () => {
    /* There is no migration SKU in the catalogue, so a "Rs 15,000 value FREE" line would be a
       hardcoded rupee figure with no source — AGENTS.md L106 — inflating a total with a price
       nobody has ever charged. */
    for (const text of [withGstin(), without()]) {
      expect(text).not.toContain("15,000");
      expect(text.toUpperCase()).not.toContain("FREE");
    }
  });

  it("mentions the discount only when one was applied", () => {
    const discounted = netCostLines(
      computeNetCost({ subtotal: 162_000, discountPct: 3, taxRate: 18, buyerGstin: GSTIN }),
      "ANUTECH",
    ).join("\n");
    expect(discounted).toContain("Volume discount applied");
    expect(withGstin()).not.toContain("Volume discount");
  });

  it("uses the seller name it was given, not a hardcoded one", () => {
    /* This deployment can serve a second reseller; their quote must not carry ANUTECH's name. */
    const other = netCostLines(computeNetCost({ ...REAL_DEAL, buyerGstin: GSTIN }), "Gamma Co");
    expect(other.join("\n")).toContain("Gamma Co");
    expect(other.join("\n")).not.toContain("ANUTECH");
  });
});

describe("authorisedNetCostFigures", () => {
  it("authorises every figure the lines can state", () => {
    const net = computeNetCost({ ...REAL_DEAL, buyerGstin: GSTIN });
    const figures = authorisedNetCostFigures(net);
    const text = netCostLines(net, "ANUTECH").join("\n");
    for (const f of [net.payable, net.gst, net.netCost]) {
      expect(figures).toContain(f);
      expect(text).toContain(f.toLocaleString("en-IN"));
    }
  });

  it("does not authorise a claimable amount when nothing is claimable", () => {
    /* Otherwise the guard would permit the agent to state an ITC figure for a buyer who has
       no GSTIN — the exact claim this module refuses to make. */
    const net = computeNetCost({ ...REAL_DEAL, buyerGstin: null });
    expect(net.itcClaimable).toBe(0);
    expect(authorisedNetCostFigures(net)).not.toContain(0);
  });
});
