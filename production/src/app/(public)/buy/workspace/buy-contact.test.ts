/**
 * /buy/workspace takes its contact from the tenant row and the site config (owner, 29 Sep 2026),
 * like the thanks page — never a personal number typed into the page. R-1970 (design v2): the
 * founder card is gone; the call / WhatsApp links live in the header, the talk-to-us band and
 * the order help, all built by _parts/brand.ts buyContact(): no live number → no call link, the
 * site WhatsApp number still the placeholder → no WhatsApp link (the GST-quote form instead).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { denyTermsRe } from "@/test/deny-terms";

const DIR = __dirname;
const files = ["buy-workspace-client.tsx", ...readdirSync(join(DIR, "_parts")).filter((n) => /\.tsx?$/.test(n)).map((n) => `_parts/${n}`)];
const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = files.map((f) => strip(readFileSync(join(DIR, f), "utf8"))).join("\n");

afterEach(() => { vi.resetModules(); vi.doUnmock("@/site/lib/config"); });

describe("buy page contact", () => {
  it("reads the tenant / site config, not a personal number", () => {
    expect(code).toMatch(/from "@\/site\/lib\/config"/);
    expect(code).not.toMatch(/PARDEEP_PHONE/);
    expect(code).not.toMatch(/\b9\d{9,11}\b/);
    expect(code).not.toMatch(denyTermsRe());
  });

  it("every wa.me / tel: link is built by buyContact()/whatsappHref (no hand-typed link)", () => {
    const tel = code.match(/href=\{?["'`]tel:/g) ?? [];
    expect(tel).toEqual([]);
    expect(code.match(/https:\/\/wa\.me\//g)?.length).toBe(2); // brand.ts whatsappHref + the dialogs' whatsappLink
  });

  it("buyContact: tenant phone first; else the site number only while it is live", async () => {
    const { buyContact } = await import("./_parts/brand");
    const base = { name: "X", logoUrl: null, gstin: null, address: null, stateCode: null, email: null };
    expect(buyContact({ ...base, phone: "98111 22233" }).tel?.href).toBe("tel:+919811122233");
    vi.doMock("@/site/lib/config", async (orig) => ({ ...(await orig<object>()), WHATSAPP_NUMBER: "919800000000", WHATSAPP_READY: false }));
    vi.resetModules();
    const fresh = await import("./_parts/brand");
    expect(fresh.buyContact({ ...base, phone: null })).toEqual({ tel: null, whatsapp: null });
  });

  it("the prefilled message never addresses one person", () => {
    expect(code).not.toMatch(/Hi Pardeep/);
    expect(code).not.toMatch(/Pardeep and team/);
  });
});
