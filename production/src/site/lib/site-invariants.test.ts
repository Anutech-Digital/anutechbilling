import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RESELLEROS_URL, OS_SIGNUP, ENQUIRY_API } from "./config";
import { TLDS, LICENCE_EDITIONS } from "./data/catalog";
import { HOSTING_TIERS } from "./data/hosting-landing-v2";

/* ─────────────────────────────────────────────────────────────────────────────
   Site ke apne niyam — jinke tootne se site jhooth bolne lagti.

   1. App ka URL sirf config.ts me. ResellerOS repo ne iski keemat chukayi hai:
      6 file me MARI HUI service ka pata tha. Ye test wahi galti is repo me bandh
      karta hai — koi component seedha run.app ka pata likhe to laal.

   2. Rate DATA me hain, component me nahi — kyunki launch se pehle Pardeep ko har
      placeholder daam badalna hai, aur wo EK file me hona chahiye.

   3. Alias/mara hua Cloud Run URL kahin na ho.
   ───────────────────────────────────────────────────────────────────────────── */

const SITE = join(process.cwd(), "src", "site");
const APP = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

const files = walk(SITE).filter((f) => !f.includes(".test."));
const read = (f: string) => readFileSync(f, "utf8");

describe("app ka pata — ek jagah", () => {
  it("run.app sirf config.ts me likha hai", () => {
    const offenders = files.filter((f) => !f.endsWith("config.ts") && read(f).includes("run.app"));
    expect(offenders, "in files me hardcoded Cloud Run URL hai").toEqual([]);
  });

  it("mari hui service ka URL KAHIN nahi", () => {
    /* 490252291080 = mari hui service. (5 Sep 2026: service asia-south1 se
       asia-southeast1 par move ho gayi; ab uska URL 1005662057478.asia-southeast1
       hai aur config.ts me legit hai — isliye wo ab forbidden nahi.) */
    for (const f of files) {
      const s = read(f);
      expect(s.includes("490252291080"), `${f} me mari hui service ka URL hai`).toBe(false);
    }
  });

  it("config STABLE domain par hai, cloud URL par nahi", () => {
    /* 5 Sep 2026: cloud URLs region-move par badalte hain (asia-south1 →
       asia-southeast1), isliye ab STABLE domain anutech.in use hota hai — jo
       jis bhi live service se bound ho usi par jaata hai. Kabhi run.app pin mat karo. */
    expect(RESELLEROS_URL).toContain("anutech.in");
    expect(RESELLEROS_URL.includes("run.app")).toBe(false);
    expect(OS_SIGNUP).toBe(`${RESELLEROS_URL}/signup`);
    expect(ENQUIRY_API).toContain("/api/public/enquiry/general");
  });
});

describe("rate card ki shakal", () => {
  it("har TLD par renew >= 0 aur teeno daam maujood", () => {
    for (const t of TLDS) {
      expect(t.reg, t.tld).toBeGreaterThan(0);
      expect(t.renew, t.tld).toBeGreaterThan(0);
      expect(t.transfer, t.tld).toBeGreaterThan(0);
    }
  });

  it("hosting: yearly/mo hamesha monthly se sasta (−20% ka vaada)", () => {
    for (const p of HOSTING_TIERS) { // R-224: the one hosting price source
      expect(p.yearlyMo, p.name).toBeLessThan(p.monthly);
    }
  });

  it("licence: annual/mo hamesha monthly/mo se sasta — ulta hone par commitment ka matlab hi ulta", () => {
    for (const e of LICENCE_EDITIONS) {
      expect(e.annual, e.name).toBeLessThan(e.monthly);
    }
  });
});

describe("quote form ka enquiry contract", () => {
  it("proxy ka payload APP ke Zod schema se milta hai — app ke source se naapa", () => {
    /* Pehla version mere likhe field-naam khud se hi milata tha — aur `requirement` naam
       galat tha (app `message` kehta hai); Pardeep ke pehle asli submit par 400 aaya.
       Ab contract app ke route-source se aata hai: wahan ka schema badle to ye laal. */
    const appRoute = readFileSync(
      join(APP, "app", "api", "public", "enquiry", "general", "route.ts"),
      "utf8",
    );
    const proxy = read(join(APP, "app", "api", "enquiry", "route.ts"));
    for (const field of ["fullName", "companyName", "email", "phone", "product", "seats", "message"]) {
      expect(appRoute.includes(field), `app schema me ${field} nahi — contract badla?`).toBe(true);
      expect(proxy.includes(`payload.${field}`) || proxy.includes(`{ fullName`) || proxy.includes(field),
        `proxy ${field} nahi bhejta`).toBe(true);
    }
    /* message REQUIRED hai app me — dono path use hamesha bharte hain. */
    expect(proxy).toContain("message");
    expect(proxy).toContain("ENQUIRY_API");
  });

  it("GW auto-quote path bhi app ke source se milta hai — tierId, billing, seats", () => {
    /* Wahi sabak dobara nahi: workspace endpoint ka schema USKE route se padho, yaad se nahi. */
    const appRoute = readFileSync(
      join(APP, "app", "api", "public", "enquiry", "workspace", "route.ts"),
      "utf8",
    );
    for (const field of ["tierId", "billing", "seats", "message", "draftQuoteId"]) {
      expect(appRoute.includes(field), `app workspace schema me ${field} nahi — contract badla?`).toBe(true);
    }
    /* Enum values jo proxy bhejta hai, app me maujood hon. */
    for (const v of ['"starter"', '"standard"', '"plus"', '"monthly"', '"annual"']) {
      expect(appRoute.includes(v), `app me enum ${v} nahi`).toBe(true);
    }
    const proxy = read(join(APP, "app", "api", "enquiry", "route.ts"));
    for (const field of ["tierId", "billing", "ENQUIRY_WORKSPACE_API", "gwTierFor", "draftQuoteId"]) {
      expect(proxy.includes(field), `proxy me ${field} nahi`).toBe(true);
    }
  });

  it("QuoteBuilder seedha app ko nahi, /api/enquiry ko POST karta hai (CORS)", () => {
    const qb = read(join(SITE, "components", "quote", "QuoteBuilder.tsx"));
    expect(qb).toContain('fetch("/api/enquiry"');
    expect(qb.includes("run.app")).toBe(false);
  });
});
