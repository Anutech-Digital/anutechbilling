/**
 * R-232 (6 Oct 2026): the Buy-now dialog demanded a company name while /checkout keeps it
 * optional — a sole proprietor could not pay. Blank is now allowed and the buyer's own name
 * goes on the order (the server still requires a name). The online checkout and the rate card
 * are also in the sitemap now.
 */
import { describe, it, expect } from "vitest";
import { buyNowSchema, buyerCompany } from "./buy-now-schema";
import sitemap from "@/app/sitemap";

const base = {
  fullName: "Asha Rao", email: "asha@acme.in", phone: "9000000000",
  seats: 5, domain: "acme.in", tierId: "business-starter", stateCode: "27", agreeTerms: true,
};

describe("R-232 Buy now: company optional", () => {
  it("blank or missing company passes", () => {
    expect(buyNowSchema.safeParse({ ...base, companyName: "" }).success).toBe(true);
    expect(buyNowSchema.safeParse({ ...base, companyName: "   " }).success).toBe(true);
    expect(buyNowSchema.safeParse(base).success).toBe(true);
  });

  it("a one-letter company is still refused (the server needs 2+)", () => {
    const r = buyNowSchema.safeParse({ ...base, companyName: "A" });
    expect(r.success).toBe(false);
  });

  it("blank → the buyer name goes on the order; filled → the company", () => {
    expect(buyerCompany({ fullName: " Asha Rao ", companyName: "" })).toBe("Asha Rao");
    expect(buyerCompany({ fullName: "Asha Rao", companyName: undefined })).toBe("Asha Rao");
    expect(buyerCompany({ fullName: "Asha Rao", companyName: " Acme Pvt Ltd " })).toBe("Acme Pvt Ltd");
  });
});

describe("R-232 sitemap", () => {
  it("lists the online Workspace checkout, the rate card and contact", () => {
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    for (const p of ["/buy/workspace", "/rates", "/contact", "/google-workspace/pricing"]) {
      expect(paths).toContain(p);
    }
    expect(new Set(paths).size).toBe(paths.length);
  });
});
