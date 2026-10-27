/**
 * R-2003 (27 Oct 2026): the website privacy policy (/privacy-policy) tells buyers about the
 * Meta Pixel + Conversions API added in R-1979 — wording approved by Pardeep (R-1979.privacyDraft).
 */
import { describe, expect, it } from "vitest";
import { LEGAL } from "@/site/lib/data/misc";

/* R-2010 (27 Oct 2026, G-DPDP): the R-2003 text, corrected — withdrawal through Cookie settings
   (not "clearing cookies": the choice lives in browser storage and on our server), named after the
   banner's purpose, and Meta also gets the IP address and user agent. */
const APPROVED_META =
  "If you accept Advertising measurement (Meta) in our cookie banner, our website loads the Meta Pixel (Meta Platforms). It tells Meta which pages you viewed and whether you started checkout or completed a purchase, so we can measure and improve our Facebook and Instagram ads. When you buy, our server also tells Meta about that purchase through Meta's Conversions API: the order value before GST, the plan you bought, and your email address and mobile number in hashed (unreadable) form, so the same purchase is counted only once. Both the Pixel and our server also give Meta your IP address and your browser's user agent (browser and device type), which Meta uses to match and count the event. We never send your name, postal address, GSTIN or payment details to Meta. If you choose Only necessary, nothing is sent to Meta. Meta handles this data under its own privacy policy (facebook.com/privacy/policy). You can withdraw consent at any time from Cookie settings at the bottom of every page (it takes effect at once), or by writing to support@anutech.in.";

describe("R-2003: privacy policy names Meta advertising measurement", () => {
  const privacy = LEGAL.privacy;

  it("has the 'Advertising measurement (Meta)' section with the approved text", () => {
    const block = privacy.blocks.find((b) => b.h === "Advertising measurement (Meta)");
    expect(block).toBeDefined();
    expect(block!.p).toBe(APPROVED_META);
    expect(block!.p).toContain("hashed");
    expect(block!.p).toContain("support@anutech.in");
  });

  it("'Sharing' names Meta, only with Advertising measurement consent", () => {
    const sharing = privacy.blocks.find((b) => b.h === "Sharing")?.p ?? "";
    expect(sharing).toContain(
      "and, only if you accept Advertising measurement (Meta), with Meta to measure our advertising (see Advertising measurement).",
    );
  });

  it("last-updated date moved to 27 October 2026", () => {
    expect(privacy.updated).toBe("Last updated 27 October 2026");
  });
});
