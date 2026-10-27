/**
 * R-2010 (27 Oct 2026, G-DPDP): the privacy policy matches what the code does — consent is
 * withdrawn from "Cookie settings" (not by clearing cookies: the choice lives in the browser's
 * storage AND on our server), and Meta also receives the IP address and browser (user agent).
 */
import { describe, expect, it } from "vitest";
import { LEGAL } from "@/site/lib/data/misc";

const block = (h: string) => LEGAL.privacy.blocks.find((b) => b.h === h)?.p ?? "";

describe("R-2010 privacy policy wording", () => {
  it("withdrawal is through 'Cookie settings', never 'clearing cookies'", () => {
    const meta = block("Advertising measurement (Meta)");
    expect(meta).toContain("Cookie settings");
    expect(meta).not.toMatch(/clearing this site's cookies/);
    expect(block("Consent and choice")).toContain("Cookie settings");
    expect(block("Consent and choice")).not.toMatch(/withdraw consent at any time by writing to us\.$/);
  });

  it("says where the choice is kept: in your browser and on our server", () => {
    const c = block("Consent and choice");
    expect(c).toContain("in your browser");
    expect(c).toContain("on our server");
  });

  it("tells the buyer that the IP address and browser (user agent) go to Meta", () => {
    const meta = block("Advertising measurement (Meta)");
    expect(meta).toContain("IP address");
    expect(meta).toContain("user agent");
  });

  it("uses the banner's names for the two purposes", () => {
    const c = block("Consent and choice");
    expect(c).toContain("Necessary");
    expect(c).toContain("Advertising measurement (Meta)");
  });
});
