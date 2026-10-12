// @vitest-environment jsdom
/**
 * The thanks page takes its contact from the site config (owner, 29 Sep 2026), not from
 * one person's hardcoded phone and a retired-brand email. While the site's WhatsApp number
 * is still the placeholder, a paying customer is shown the support email and NO WhatsApp or
 * call link — a dead button after payment is worse than an address.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cfg = vi.hoisted(() => ({ number: "919800000000", ready: false }));
vi.mock("@/site/lib/config", async (orig) => {
  const real = await orig<typeof import("@/site/lib/config")>();
  return {
    ...real,
    get WHATSAPP_NUMBER() { return cfg.number; },
    get WHATSAPP_READY() { return cfg.ready; },
  };
});

import { ThanksClient, type ThanksOrder } from "./thanks-client";
import { COMPANY, WHATSAPP_PLACEHOLDER, whatsappDisplay } from "@/site/lib/config";
import { denyTermsRe } from "@/test/deny-terms";

const order: ThanksOrder = {
  quoteId: "Q-ADPL-2026-27-0048", customerName: "Asha Co", tierName: "Business Starter",
  seats: 5, amount: 3186, paymentStatus: "received", paymentDate: "2026-09-29",
};

const hrefs = (c: HTMLElement) => [...c.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");

afterEach(() => { cleanup(); cfg.number = "919800000000"; cfg.ready = false; });

describe("thanks page contact", () => {
  it("placeholder number → no WhatsApp or call link, support email instead (order and not-found views)", () => {
    for (const o of [order, null]) {
      const { container } = render(<ThanksClient order={o} isSimulation={false} />);
      const links = hrefs(container);
      expect(links.some((h) => h.startsWith("https://wa.me/"))).toBe(false);
      expect(links.some((h) => h.startsWith("tel:"))).toBe(false);
      expect(links.some((h) => h.startsWith(`mailto:${COMPANY.supportEmail}`))).toBe(true);
      cleanup();
    }
  });

  it("a real number configured → WhatsApp and call use it", () => {
    cfg.number = "919812345678"; cfg.ready = true;
    const { container } = render(<ThanksClient order={order} isSimulation={false} />);
    const links = hrefs(container);
    expect(links.some((h) => h.startsWith("https://wa.me/919812345678?text="))).toBe(true);
    expect(links).toContain("tel:+919812345678");
    expect(container.textContent).toContain("+91 98123 45678");
  });

  it("no named person, no personal phone, no retired-brand address in the page's code", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const f of ["thanks-client.tsx", "page.tsx"]) {
      const src = strip(readFileSync(join(__dirname, f), "utf8"));
      expect(src, f).not.toMatch(/Pardeep/);
      expect(src, f).not.toMatch(denyTermsRe());
      expect(src, f).not.toMatch(/\b9\d{9,11}\b/);
    }
  });

  it("the placeholder check and the display format", () => {
    expect(WHATSAPP_PLACEHOLDER).toBe("919800000000");
    expect(whatsappDisplay("919812345678")).toBe("+91 98123 45678");
  });
});
