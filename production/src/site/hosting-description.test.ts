/**
 * R-1459: hosting was described two ways — the home catalogue card and the Hosting menu said
 * "cPanel and LiteSpeed on NVMe, Mumbai and Bengaluru", the /hosting hero said "powered by
 * Google Cloud". Pardeep (16 Oct 2026): Google Cloud is the true one. All three places now read
 * HOSTING_DESCRIPTION from one data file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOSTING_DESCRIPTION } from "@/site/lib/data/hosting-copy";
import { CATALOGUE } from "@/site/lib/data/copy";

const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");
const PLACES = [
  "components/home/HomeV2.tsx", // home catalogue card (HomeCompany reuses CATALOGUE_V2)
  "components/chrome/Header.tsx", // Hosting mega-menu promo
  "components/hosting/HostingLanding.tsx", // /hosting hero
];

describe("one hosting description (R-1459)", () => {
  it("says Google Cloud", () => {
    expect(HOSTING_DESCRIPTION).toMatch(/Google Cloud/);
  });
  it("home card, menu and /hosting hero all read the shared constant", () => {
    for (const f of PLACES) expect(read(f), f).toContain("HOSTING_DESCRIPTION");
  });
  it("no place still claims Mumbai and Bengaluru hosting", () => {
    for (const f of [...PLACES, "lib/data/copy.ts"]) {
      expect(read(f), f).not.toMatch(/Mumbai and Bengaluru, LiteSpeed|NVMe, (in )?Mumbai and Bengaluru/);
    }
  });
  it("the /hosting hero no longer hard-codes its own sentence", () => {
    expect(read("components/hosting/HostingLanding.tsx")).not.toContain("Enterprise-grade web hosting powered by Google Cloud.");
  });
  it("the old catalogue data uses the same description", () => {
    expect(CATALOGUE.find((c) => c.href === "/hosting")?.body).toBe(HOSTING_DESCRIPTION);
  });
});
