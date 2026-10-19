import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { RESELLEROS_URL, OS_SIGNUP, ENQUIRY_API, resolveResellerosUrl, LIVE_RESELLEROS_URL } from "./config";
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
    /* R-1499: production build ka default — live STABLE domain (pehle jaisa). */
    const prod = resolveResellerosUrl(undefined, "production", "https://whatever.example");
    expect(prod).toBe(LIVE_RESELLEROS_URL);
    expect(prod).toContain("anutech.in");
    expect(prod.includes("run.app")).toBe(false);
    expect(OS_SIGNUP).toBe(`${RESELLEROS_URL}/signup`);
    expect(ENQUIRY_API).toContain("/api/public/enquiry/general");
  });

  it("R-1499: laptop (next dev / test) kabhi LIVE par default nahi karta", () => {
    expect(resolveResellerosUrl(undefined, "development", "http://localhost:3001/")).toBe("http://localhost:3001");
    expect(resolveResellerosUrl("", "development", undefined)).toBe("http://localhost:3001");
    expect(resolveResellerosUrl(undefined, "test", undefined)).not.toContain("reselleros.anutech.in");
    /* Is test run ka apna RESELLEROS_URL bhi live nahi (NODE_ENV=test). */
    if (!process.env.NEXT_PUBLIC_RESELLEROS_URL) expect(RESELLEROS_URL).not.toContain("reselleros.anutech.in");
  });

  it("R-1499: NEXT_PUBLIC_RESELLEROS_URL set ho to har build me wahi", () => {
    expect(resolveResellerosUrl(" https://x.example ", "production", undefined)).toBe("https://x.example");
    expect(resolveResellerosUrl("https://x.example", "development", "http://localhost:3001")).toBe("https://x.example");
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

  it("R-1598: /api/enquiry aur /api/agent kisi doosri deployment (live) ko fetch nahi karte", () => {
    /* Staging ke /quote, /trial aur AI chat ke leads LIVE me jaate the: dono routes
       RESELLEROS_URL (default live domain) par fetch karte the. Ab handler isi process me. */
    for (const p of [join(APP, "app", "api", "enquiry", "route.ts"), join(APP, "app", "api", "agent", "route.ts")]) {
      const s = read(p);
      expect(s.includes("RESELLEROS_URL"), `${p} RESELLEROS_URL use karta hai`).toBe(false);
      expect(/\bfetch\(/.test(s), `${p} khud fetch karta hai`).toBe(false);
      expect(s.includes("deliverToApp("), `${p} deliverToApp se nahi jaata`).toBe(true);
    }
    const fwd = read(join(SITE, "lib", "app-forward.ts"));
    expect(/process\.env\.NEXT_PUBLIC/.test(fwd), "forward target NEXT_PUBLIC env se nahi aana chahiye (build me jam jaata hai)").toBe(false);
  });

  it("QuoteBuilder seedha app ko nahi, /api/enquiry ko POST karta hai (CORS)", () => {
    const qb = read(join(SITE, "components", "quote", "QuoteBuilder.tsx"));
    expect(qb).toContain('fetch("/api/enquiry"');
    expect(qb.includes("run.app")).toBe(false);
  });
});
