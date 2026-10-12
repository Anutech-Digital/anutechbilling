/**
 * /buy/workspace takes its contact from the site config (owner, 29 Sep 2026), like the thanks
 * page. It used to carry Pardeep's personal number in three WhatsApp / call buttons. While the
 * site's number is still the placeholder, every WhatsApp and call link is gated on
 * WHATSAPP_READY, so the page shows no dead button; the founder card offers the support email.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { denyTermsRe } from "@/test/deny-terms";

const raw = readFileSync(join(__dirname, "buy-workspace-client.tsx"), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("buy page contact", () => {
  it("guard: the comment strip left the component in place", () => {
    expect(code).toContain("function FounderHero");
  });

  it("reads the site config, not a personal number", () => {
    expect(code).toMatch(/from "@\/site\/lib\/config"/);
    expect(code).not.toMatch(/PARDEEP_PHONE/);
    expect(code).not.toMatch(/\b9\d{9,11}\b/);
    expect(code).not.toMatch(denyTermsRe());
  });

  it("every WhatsApp and call link sits behind WHATSAPP_READY", () => {
    const links = code.match(/href=\{(whatsappLink\([^)]*\)|`tel:[^`]*`)\}/g) ?? [];
    expect(links.length).toBe(4); // founder WhatsApp + call, quote CTA, sticky chip
    // One gate per group that renders them: founder card, quote CTA, sticky chip.
    expect(code.match(/WHATSAPP_READY \?|\{WHATSAPP_READY &&/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the founder card falls back to the support email", () => {
    expect(code).toMatch(/mailto:\$\{COMPANY\.supportEmail\}/);
  });

  it("the prefilled message no longer addresses one person", () => {
    expect(code).not.toMatch(/Hi Pardeep/);
  });
});
