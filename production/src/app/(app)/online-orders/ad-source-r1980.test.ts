/**
 * R-1980 — Online Orders shows which ad brought each order (the lead's utm_source / utm_campaign,
 * campaign code → campaign name). Before this the list had no ad column and read only utm_source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEAD_ORDER_COLUMNS } from "./order-query";
import { adSourceText } from "@/lib/marketing/campaign-sales";

const page = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("R-1980 Online Orders — Ad source", () => {
  it("the order read carries the ad fields the Source cell needs", () => {
    for (const c of ["utm_source", "utm_medium", "utm_campaign", "referrer_url"]) {
      expect(LEAD_ORDER_COLUMNS.split(",").map((s) => s.trim())).toContain(c);
    }
  });

  it("the table has an Ad source column and the drawer an Ad source row, both from adSourceText", () => {
    expect(page).toMatch(/"Ad source"/);
    expect(page).toMatch(/label="Ad source"/);
    expect(page).toMatch(/adSourceText\(/);
    expect(page).toMatch(/useCampaignNames\(/);
  });

  it("a Facebook ad order reads 'Facebook / Instagram Ads' + the campaign's name", () => {
    expect(adSourceText(
      { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "scn-ws-oct", referrer_url: null },
      new Map([["scn-ws-oct", "SCN Workspace Oct"]]),
    )).toEqual({ channel: "meta-ads", campaign: "SCN Workspace Oct" });
  });
});
