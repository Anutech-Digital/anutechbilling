import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publicWorkspaceCatalog, suiteRows } from "./public-workspace";

/* ─────────────────────────────────────────────────────────────────────────────
   PUBLIC endpoint se WHOLESALE bahar na jaye — yahi is file ka ek kaam hai.

   Company website (website/) ab daam yahin se padhti hai. `wholesale` aur `margin_pct`
   vyapar ki khareed aur margin hain; public me jate hi har grahak ke paas mol-bhav ka
   floor aur har competitor ke paas cost structure pahunch jata. Isliye jaanch OUTPUT ke
   bytes par hai — har key, har level par — kisi select-list ke bharose par nahi.
   ───────────────────────────────────────────────────────────────────────────── */

/** Asli shakal ka row — jaisa items table 31 Aug 2026 ko deta hai, wholesale SAMET. */
const LIVE_ROW = {
  name: "Google Workspace Business Starter",
  msrp: 270,
  prices: {
    annual: { msrp: 270, wholesale: 250 },
    monthly: { msrp: 325, wholesale: 300 },
    usd: { msrp: 6, wholesale: 5 },
  },
};

function allKeysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeysDeep(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeysDeep(x, out);
    }
  }
  return out;
}

describe("wholesale kabhi bahar nahi jata", () => {
  it("output me na 'wholesale' key hai, na uske AANKDE", () => {
    const out = publicWorkspaceCatalog([LIVE_ROW]);
    const keys = allKeysDeep(out);
    expect(keys).not.toContain("wholesale");
    expect(keys).not.toContain("margin_pct");
    /* Key ka naam badal kar value nikal jana bhi utna hi leak hai — 250 aur 300 wholesale
       ke aankde hain aur output me kahin nahi hone chahiye. 270/325 customer daam hain. */
    const values = JSON.stringify(out);
    expect(values).not.toContain("250");
    expect(values).not.toContain("300");
  });

  it("route ka select bhi wholesale nahi maangta", () => {
    /* Do parat: function strip karta hai, aur route use maangta hi nahi. Ye source-pin
       hai — koi select ko 'select(\"*\")' kar de to laal. */
    const src = readFileSync(
      join(process.cwd(), "src", "app", "api", "public", "catalog", "workspace", "route.ts"),
      "utf8",
    );
    const selects = src.match(/\.select\("([^"]*)"\)/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) {
      expect(s.includes("wholesale"), s).toBe(false);
      expect(s.includes("margin"), s).toBe(false);
      expect(s.includes("*"), s).toBe(false);
    }
  });
});

describe("shakal — website jo padhti hai", () => {
  it("asli row se dono tier ke customer daam", () => {
    expect(publicWorkspaceCatalog([LIVE_ROW])).toEqual([
      { name: "Google Workspace Business Starter", annualPerSeatMo: 270, monthlyPerSeatMo: 325 },
    ]);
  });

  it("monthly tier na ho to null — aankda gadha nahi jata", () => {
    const out = publicWorkspaceCatalog([{ name: "GW X", msrp: 500, prices: { annual: { msrp: 500 } } }]);
    expect(out[0].monthlyPerSeatMo).toBeNull();
  });

  it("bina naam ya bina daam ki row chhod di jati hai", () => {
    expect(publicWorkspaceCatalog([
      { name: "  ", msrp: 100, prices: null },
      { name: "GW Y", msrp: 0, prices: null },
      { name: "GW Z", msrp: null, prices: null },
    ])).toEqual([]);
  });
});

describe("R-076 — M365 aur Zoho bhi isi endpoint se", () => {
  it("vendor tag output me jata hai (google/microsoft/zoho), aur kuch nahi", () => {
    const out = publicWorkspaceCatalog([
      { name: "Microsoft 365 Business Basic", msrp: 151, prices: { monthly: { msrp: 181, wholesale: 140 } }, vendor: "microsoft" },
      { name: "Zoho Workplace Standard", msrp: 93, prices: null, vendor: "zoho" },
      { name: "Something", msrp: 10, prices: null, vendor: "acme" },
    ]);
    expect(out[0]).toEqual({ name: "Microsoft 365 Business Basic", annualPerSeatMo: 151, monthlyPerSeatMo: 181, vendor: "microsoft" });
    expect(out[1].vendor).toBe("zoho");
    expect(out[2].vendor).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("140");
  });

  it("suiteRows sirf suite products rakhta hai — add-on ya doosra item nahi", () => {
    const rows = [
      { name: "Google Workspace Business Starter", vendor: "google" },
      { name: "Gemini add-on", vendor: "google" },
      { name: "Microsoft 365 Business Basic", vendor: "microsoft" },
      { name: "Exchange Online Plan 1", vendor: "microsoft" },
      { name: "Zoho Workplace Standard", vendor: "zoho" },
      { name: "Microsoft 365 Business Basic", vendor: "other" },
      { name: null, vendor: "zoho" },
    ];
    expect(suiteRows(rows).map((r) => r.name)).toEqual([
      "Google Workspace Business Starter", "Microsoft 365 Business Basic", "Zoho Workplace Standard",
    ]);
  });
});
