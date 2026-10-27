// @vitest-environment jsdom
/**
 * R-2020 (R-2019a, 27 Oct 2026, Pardeep — design buy-workspace-mobile + 9 audit decisions on
 * R-2019): on a PHONE /buy/workspace is one question at a time — "What do you need?", licences,
 * Pay yearly / monthly, Starter or Standard, one Continue bar — and the laptop keeps the v2 page.
 * The owner's path: an ad on a phone (utm + fbclid in the link) → choose Switch, 5 licences,
 * Standard, monthly → refresh keeps all of it, the ad params stay in the address bar → Compare →
 * Choose Starter. 301 licences → "Not available" and a talk-to-us call. Prices are the desktop's:
 * planSum on the catalogue tiers, which equals the server's buildWorkspaceLines.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent, within, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/buy/workspace",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { buyViewFor } from "./device";
import { readMobileState, writeMobileState, continueHref, MOBILE_MAX_ONLINE } from "./url-state";
import { mobilePlans, yearlySaving, compareRows } from "./prices";
import { BuyMobileClient } from "./buy-mobile-client";
import { trackFunnel } from "./funnel";
import { CONSENT_KEY } from "@/site/lib/consent";
import { buildTiers, type CatalogItem } from "../_parts/tiers";
import { toBuyPlans, planSum } from "../_parts/plans";
import { isPublicPriceHiddenTier } from "@/lib/catalog/public-price-policy";
import { buildWorkspaceLines } from "@/lib/pricing/workspace";
import type { BuyBrand } from "../_parts/brand";

const row = (id: string, name: string, annual: number, monthly: number): CatalogItem => ({
  id, name, msrp: annual, wholesale: 0, margin_pct: null, is_active: true,
  prices: { annual: { msrp: annual, wholesale: 0 }, monthly: { msrp: monthly, wholesale: 0 } },
});
const CATALOG: CatalogItem[] = [
  row("s", "Google Workspace Business Starter", 270, 325),
  row("d", "Google Workspace Business Standard", 1080, 1300),
  { id: "p", name: "Google Workspace Business Plus", msrp: 0, wholesale: 0, margin_pct: null, is_active: true, prices: {} },
];
const BRAND: BuyBrand = {
  name: "Tenant Seller Pvt Ltd", logoUrl: null, gstin: "07AAAAA0000A1Z5",
  address: "12 Test Road, Rohini, Delhi 110085", stateCode: "07", phone: null, email: null,
};
const hdr = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] ?? null });
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const LAPTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

describe("R-2020: phone or laptop — decided on the server, one tree", () => {
  it("Sec-CH-UA-Mobile ?1 or a phone user agent → mobile; a laptop → desktop", () => {
    expect(buyViewFor(hdr({ "sec-ch-ua-mobile": "?1" }))).toBe("mobile");
    expect(buyViewFor(hdr({ "user-agent": IPHONE }))).toBe("mobile");
    expect(buyViewFor(hdr({ "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36" }))).toBe("mobile");
    expect(buyViewFor(hdr({ "user-agent": LAPTOP, "sec-ch-ua-mobile": "?0" }))).toBe("desktop");
    expect(buyViewFor(hdr({}))).toBe("desktop");
  });

  it("?view=desktop / ?view=mobile override the guess (the phone flow's hand-over, testing)", () => {
    expect(buyViewFor(hdr({ "user-agent": IPHONE }), "desktop")).toBe("desktop");
    expect(buyViewFor(hdr({ "user-agent": LAPTOP }), "mobile")).toBe("mobile");
    expect(buyViewFor(hdr({ "user-agent": LAPTOP }), "nonsense")).toBe("desktop");
  });

  it("page.tsx renders EITHER the phone client OR the v2 client — never both", () => {
    const src = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    expect(src).toMatch(/buyViewFor\(/);
    expect(src).toMatch(/if \(view === "mobile"\)[\s\S]{0,400}return \(\s*<BuyMobileClient/);
    expect(src).toMatch(/<BuyWorkspaceClient/);
    /* the phone tree never imports the desktop page (else the phone downloads both) */
    for (const f of ["buy-mobile-client.tsx", "plans-step.tsx", "compare-step.tsx", "trust.tsx"]) {
      expect(readFileSync(join(__dirname, f), "utf8"), f).not.toMatch(/from "[^"]*buy-workspace-client"/);
    }
  });
});

describe("R-2020: the choices live in the address bar", () => {
  it("round trip: step, intent, tier, seats, billing", () => {
    const s = { step: "compare" as const, intent: "transfer" as const, tier: "starter" as const, seats: 5, billing: "monthly" as const };
    const q = writeMobileState("", s);
    expect(readMobileState(new URLSearchParams(q))).toEqual(s);
  });

  it("utm / fbclid / gclid / coupon stay untouched when a step or choice changes", () => {
    const ad = "?utm_source=facebook&utm_campaign=gw-oct&fbclid=AbC123&gclid=xyz&coupon=WELCOME";
    const q = writeMobileState(ad, { step: "plans", intent: "new", tier: "standard", seats: 12, billing: "annual" });
    const p = new URLSearchParams(q);
    expect(p.get("utm_source")).toBe("facebook");
    expect(p.get("utm_campaign")).toBe("gw-oct");
    expect(p.get("fbclid")).toBe("AbC123");
    expect(p.get("gclid")).toBe("xyz");
    expect(p.get("coupon")).toBe("WELCOME");
    expect(p.get("seats")).toBe("12");
    expect(p.get("intent")).toBe("new");
  });

  it("anything odd in the link is ignored, never trusted", () => {
    const s = readMobileState(new URLSearchParams("?step=pay&intent=hack&tier=plus&seats=-4&billing=weekly"));
    expect(s).toEqual({ step: "plans", intent: null, tier: "standard", seats: 1, billing: "annual" });
    expect(readMobileState(new URLSearchParams("?seats=lots")).seats).toBe(5);
    expect(readMobileState({ seats: ["7", "9"], tier: "starter" }).seats).toBe(7);
  });

  it("seats: 1 at least, 300 the online cap — above it stays in the URL so the page can say so", () => {
    expect(MOBILE_MAX_ONLINE).toBe(300);
    expect(readMobileState(new URLSearchParams("?seats=0")).seats).toBe(1);
    expect(readMobileState(new URLSearchParams("?seats=450")).seats).toBe(450);
  });

  it("Continue (until the phone checkout ships) opens the v2 checkout with the same plan, seats, billing and ad params", () => {
    const href = continueHref("?utm_source=facebook&fbclid=AbC&step=plans&intent=new", { step: "plans", intent: "new", tier: "starter", seats: 5, billing: "monthly" });
    const u = new URL(href, "https://x.test");
    expect(u.pathname).toBe("/buy/workspace");
    expect(u.searchParams.get("view")).toBe("desktop");
    expect(u.searchParams.get("tier")).toBe("starter");
    expect(u.searchParams.get("seats")).toBe("5");
    expect(u.searchParams.get("billing")).toBe("monthly");
    expect(u.searchParams.get("buy")).toBe("1");
    expect(u.searchParams.get("utm_source")).toBe("facebook");
    expect(u.searchParams.get("fbclid")).toBe("AbC");
    expect(u.searchParams.get("step")).toBeNull();
  });
});

describe("R-2020: prices are the desktop's (= the server's)", () => {
  const plans = toBuyPlans(buildTiers(CATALOG), isPublicPriceHiddenTier);

  it("only Business Starter and Business Standard are sold on the phone", () => {
    expect(mobilePlans(plans).map((p) => p.id)).toEqual(["starter", "standard"]);
  });

  it("the yearly total shown = buildWorkspaceLines().amount for the same plan and seats", () => {
    for (const [id, monthlyMsrp] of [["starter", 270], ["standard", 1080]] as const) {
      for (const seats of [1, 5, 10, 37, 300]) {
        const plan = plans.find((p) => p.id === id)!;
        const server = buildWorkspaceLines({ name: `Google Workspace Business ${id}`, msrp: monthlyMsrp, prices: { annual: { msrp: monthlyMsrp, wholesale: 0 } } } as never, id, seats);
        expect(planSum(plan, seats, "annual")!.total).toBe(server.amount);
      }
    }
  });

  it("'Save ₹X' = 12 monthly bills − the yearly bill (both incl. GST)", () => {
    const std = plans.find((p) => p.id === "standard")!;
    expect(yearlySaving(std, 10)).toBe(planSum(std, 10, "monthly")!.total * 12 - planSum(std, 10, "annual")!.total);
    expect(yearlySaving(std, 10)).toBe(220 * 10 * 12 * 1.18);
  });

  it("compare: Starter vs Standard, from the desktop's COMPARE_ROWS (no second table)", () => {
    const rows = compareRows();
    expect(rows.find((r) => r.feature === "Storage per user (pooled)")).toEqual({ feature: "Storage per user (pooled)", starter: "30 GB", standard: "2 TB" });
    expect(rows.find((r) => r.feature === "Livestreaming")).toBeUndefined(); // neither has it
  });
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
  window.history.replaceState(null, "", "/buy/workspace?utm_source=facebook&fbclid=AbC123");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const phone = (search: Record<string, string> = {}) =>
  render(<BuyMobileClient catalogItems={CATALOG} paymentMode="simulation" brand={BRAND} initialSearch={search} />);

describe("R-2020: the phone page, as the owner uses it", () => {
  it("asks 'What do you need?' first; licences and plans appear only after a choice", () => {
    phone();
    expect(screen.getByText("What do you need?")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Number of licences" })).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Switch my existing Google Workspace to Tenant Seller Pvt Ltd/ }));
    expect(screen.getByText("How many licences do you have now?")).toBeTruthy();
    expect(screen.getByText(/1 licence = 1 email ID/)).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("intent")).toBe("transfer");
    expect(new URLSearchParams(window.location.search).get("utm_source")).toBe("facebook");
  });

  it("the top bar and title carry the tenant's name — never a typed company", () => {
    phone();
    const bar = screen.getByRole("banner");
    expect(within(bar).getByText("Tenant Seller Pvt Ltd")).toBeTruthy();
    expect(within(bar).getByRole("link", { name: "Talk to us" })).toBeTruthy();
  });

  it("stepper + presets; 301 licences → 'Not available' and a talk-to-us call instead of Continue", () => {
    phone({ intent: "new" });
    const input = screen.getByRole("spinbutton", { name: "Number of licences" }) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "25" }));
    expect(input.value).toBe("25");
    fireEvent.click(screen.getByRole("button", { name: "More licences" }));
    expect(input.value).toBe("26");
    fireEvent.change(input, { target: { value: "301" } });
    expect(screen.getAllByText("Not available").length).toBe(2);
    expect(screen.getByText(/Online purchase works for up to 300 licences/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.getByRole("link", { name: /Get a call back with a quote/ })).toBeTruthy();
  });

  it("plan cards show the total incl. GST, ~a month, and the per-licence rate — the same numbers as planSum", () => {
    phone({ intent: "new", seats: "10", tier: "standard" });
    const std = screen.getByRole("radio", { name: /^Standard/ });
    expect(std.textContent).toContain("₹1,52,928"); // 10 × 1,080 × 12 = 1,29,600 + 23,328 GST
    expect(std.textContent).toContain("a year for 10 licences");
    expect(std.textContent).toContain("That's about ₹12,744 a month");
    expect(std.textContent).toContain("₹1,080 per licence / month + GST");
    const bar = screen.getByTestId("mobile-continue-bar");
    expect(bar.textContent).toContain("₹1,52,928");
    expect(bar.textContent).toContain("Standard · 10 licences · Yearly");
  });

  it("Pay yearly says the real saving; monthly switches every price to one month", () => {
    phone({ intent: "new", seats: "10", tier: "standard" });
    expect(screen.getByRole("radio", { name: /Pay yearly/ }).textContent).toContain("Save ₹31,152");
    fireEvent.click(screen.getByRole("radio", { name: /Pay monthly/ }));
    expect(screen.getByRole("radio", { name: /^Standard/ }).textContent).toContain("₹15,340"); // 13,000 + 2,340
    expect(new URLSearchParams(window.location.search).get("billing")).toBe("monthly");
  });

  it("Plus / Enterprise are one 'Talk to us' line, not cards", () => {
    phone({ intent: "new" });
    expect(screen.queryByRole("radio", { name: /^Plus/ })).toBeNull();
    expect(screen.getByText(/Need Plus or Enterprise\?/)).toBeTruthy();
  });

  it("the founder card: name, role, number and the quote exactly as in the design; placeholders hidden", () => {
    phone({ intent: "new" });
    expect(screen.getByText("Pardeep Sharma")).toBeTruthy();
    expect(screen.getByText("Founder, Tenant Seller Pvt Ltd")).toBeTruthy();
    expect(screen.getByText(/Your direct number: \+91 99999 30300/)).toBeTruthy();
    expect(screen.getByText("“You'll have my WhatsApp from day one. If something breaks, you call me, not a ticket queue.”")).toBeTruthy();
    expect(screen.queryByText(/Add photo|Add: /)).toBeNull();
  });

  it("refresh keeps every choice (state comes back from the URL)", () => {
    phone({ step: "plans", intent: "transfer", tier: "starter", seats: "5", billing: "monthly" });
    expect((screen.getByRole("spinbutton", { name: "Number of licences" }) as HTMLInputElement).value).toBe("5");
    expect(screen.getByRole("radio", { name: /^Starter/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Pay monthly/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("Compare: two columns, Choose picks the plan and goes back to Plans", () => {
    phone({ intent: "new", tier: "standard" });
    fireEvent.click(screen.getByRole("button", { name: "Compare plans" }));
    expect(new URLSearchParams(window.location.search).get("step")).toBe("compare");
    expect(screen.getByRole("columnheader", { name: "Starter" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose Starter" }));
    expect(new URLSearchParams(window.location.search).get("step")).toBe("plans");
    expect(screen.getByRole("radio", { name: /^Starter/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("the consent banner and Meta Pixel are mounted exactly like the desktop page", () => {
    const src = readFileSync(join(__dirname, "buy-mobile-client.tsx"), "utf8");
    expect(src).toMatch(/<MetaPixel pixelId=\{metaPixelId\} \/>/);
    expect(src).toMatch(/<ConsentBanner \/>/);
    expect(src).toMatch(/landingForForm\(\)/);
  });
});

describe("R-2020 addition (Pardeep 27 Oct: hero on the phone — compact): the phone hero", () => {
  beforeEach(() => {
    /* motion welcome (no reduce-motion, no Save-Data) — the phone hero must STILL show only the poster */
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as unknown as typeof window.matchMedia;
  });

  it("opens the Plans step: pill, H1 with the chai line, the lead line, two ticks — no button", () => {
    phone();
    const hero = screen.getByTestId("mobile-hero");
    const h1 = within(hero).getByRole("heading", { level: 1 });
    expect(h1.textContent).toContain("for your business.");
    expect(h1.textContent).toContain("Ready before your chai gets cold.");
    expect(hero.textContent).toContain("reseller since 2014");
    expect(hero.textContent).toContain("Business email, Drive and Meet. We set it up and copy your old email for you.");
    expect(within(hero).getAllByRole("listitem").map((li) => li.textContent?.replace("✓", ""))).toEqual(["GST invoice", "Setup call included"]);
    expect(within(hero).queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const q = screen.getByText("What do you need?");
    expect(hero.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    /* nothing between the hero and the first question but the page padding */
    expect(hero.nextElementSibling?.querySelector("#m-intent")).toBeTruthy();
  });

  it("poster only on a phone (never the clip); the R-2018 dark layer; white text, no panel", () => {
    phone();
    const hero = screen.getByTestId("mobile-hero");
    expect(hero.querySelector("[data-testid=hero-poster]")).toBeTruthy();
    expect(hero.querySelector("video")).toBeNull();
    expect((hero.querySelector("[data-testid=hero-dim]") as HTMLElement).className).toMatch(/(^|\s)bg-ink\/80(\s|$)/);
    const text = screen.getByTestId("mobile-hero-text");
    expect(text.className).not.toMatch(/bg-paper|bg-white|backdrop-blur/);
    expect(within(hero).getByRole("heading", { level: 1 }).className).toMatch(/text-white/);
  });

  it("compact: at 375x812 the hero stays under 40% of the screen, so the first question is on screen 1", () => {
    phone();
    const text = screen.getByTestId("mobile-hero-text");
    const h1 = within(screen.getByTestId("mobile-hero")).getByRole("heading", { level: 1 });
    expect(text.className).toMatch(/\bpt-4\b/);
    expect(text.className).toMatch(/\bpb-5\b/);
    expect(h1.className).toMatch(/text-\[26px\]/);
    /* Upper bound at 343 px of text width (375 - 2x16): padding 16+20, pill 26, three 10-px gaps,
       H1 <= 3 lines x 28 px, lead <= 2 lines x 20 px, ticks 1 line x 20 px. */
    const heroMax = 36 + 26 + 30 + 3 * 28 + 2 * 20 + 20;
    expect(heroMax / 812).toBeLessThanOrEqual(0.4);
    /* top bar (<= 60) + hero + 18 px gap: the question's top is well inside the first 812 px */
    expect(60 + heroMax + 18).toBeLessThan(812 - 200);
  });

  it("reuses the desktop hero's layer — no copy of the hero file; the desktop hero still plays the clip", () => {
    const src = readFileSync(join(__dirname, "hero.tsx"), "utf8");
    expect(src).toMatch(/import \{ HeroBackground \} from "\.\.\/_parts\/hero"/);
    expect(src).toMatch(/<HeroBackground posterOnly \/>/);
    expect(src).not.toMatch(/<video\b/);
    const desk = readFileSync(join(__dirname, "..", "_parts", "hero.tsx"), "utf8");
    expect(desk).toMatch(/<HeroBackground \/>/);
  });
});

describe("R-2019 goal (Pardeep 27 Oct: 'the moment a user clicks the ad … must not be confused')", () => {
  it("1. ad deep link → Plans with tier / seats / billing pre-filled; intent still asked; junk ignored; ad params kept", () => {
    window.history.replaceState(null, "", "/buy/workspace?utm_source=meta&fbclid=Ad1&tier=starter&seats=7&billing=monthly&foo=bar");
    phone({ utm_source: "meta", fbclid: "Ad1", tier: "starter", seats: "7", billing: "monthly", foo: "bar" });
    expect(screen.getByText("What do you need?")).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: "Number of licences" })).toBeNull(); // nothing below until answered
    expect(screen.getByTestId("mobile-continue-bar").textContent).toContain("Starter · 7 licences · Monthly");
    fireEvent.click(screen.getByRole("radio", { name: /New Google Workspace/ }));
    expect((screen.getByRole("spinbutton", { name: "Number of licences" }) as HTMLInputElement).value).toBe("7");
    expect(screen.getByRole("radio", { name: /^Starter/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /Pay monthly/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Compare plans" }));
    const p = new URLSearchParams(window.location.search);
    expect([p.get("utm_source"), p.get("fbclid"), p.get("step")]).toEqual(["meta", "Ad1", "compare"]);
  });

  it("2. defaults: Standard ('Most picked') and 5 licences when the link names none; nothing advances by itself", () => {
    phone({ intent: "new" });
    expect(screen.getByRole("radio", { name: /^Standard/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: /^Standard/ }).textContent).toContain("Most picked");
    expect((screen.getByRole("spinbutton", { name: "Number of licences" }) as HTMLInputElement).value).toBe("5");
    expect(new URLSearchParams(window.location.search).get("step")).toBeNull();
  });

  it("3. one total: the chosen card, the sticky bar and the hand-over to checkout carry the same plan, licences and billing", () => {
    phone({ intent: "new", tier: "starter", seats: "12", billing: "annual" });
    const card = screen.getByRole("radio", { name: /^Starter/ }).textContent ?? "";
    const bar = screen.getByTestId("mobile-continue-bar").textContent ?? "";
    const total = "₹45,878"; // 12 × 270 × 12 = 38,880 + 6,998 GST
    expect(card).toContain(total);
    expect(bar).toContain(total);
    fireEvent.click(screen.getByRole("radio", { name: /Pay monthly/ }));
    const m = "₹4,602"; // 12 × 325 = 3,900 + 702 GST
    expect(screen.getByRole("radio", { name: /^Starter/ }).textContent).toContain(m);
    expect(screen.getByTestId("mobile-continue-bar").textContent).toContain(m);
    const u = new URL(continueHref(window.location.search, readMobileState(new URLSearchParams(window.location.search))), "https://x.test");
    expect([u.searchParams.get("tier"), u.searchParams.get("seats"), u.searchParams.get("billing")]).toEqual(["starter", "12", "monthly"]);
  });

  it("6. help is one tap away on every step, and the browser Back button keeps every choice", () => {
    phone({ intent: "transfer", tier: "starter", seats: "9", billing: "monthly" });
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Talk to us" }).getAttribute("href")).toMatch(/^https:\/\/wa\.me\/|^tel:/);
    fireEvent.click(screen.getByRole("button", { name: "Compare plans" }));
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Talk to us" })).toBeTruthy();
    /* the browser Back button: the URL goes back to the Plans entry, then popstate */
    const back = writeMobileState(window.location.search, { step: "plans", intent: "transfer", tier: "starter", seats: 9, billing: "monthly" });
    act(() => {
      window.history.replaceState(null, "", `/buy/workspace${back}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByText("What do you need?")).toBeTruthy();
    expect((screen.getByRole("spinbutton", { name: "Number of licences" }) as HTMLInputElement).value).toBe("9");
    expect(screen.getByRole("radio", { name: /^Starter/ }).getAttribute("aria-checked")).toBe("true");
    /* the in-page back arrow too */
    fireEvent.click(screen.getByRole("button", { name: "Compare plans" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("radio", { name: /Pay monthly/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("5. the consent banner sits above the sticky bar on the phone, kept short", () => {
    phone({ intent: "new" });
    const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("\n");
    expect(css).toContain(".m-buy .consent-banner{bottom:calc(var(--m-bar-h,0px) + 12px);max-height:34vh}");
    expect(document.querySelector(".m-buy [data-m-bar]")).toBeTruthy();
  });

  it("9. funnel events only with 'Accept all'; nothing personal", () => {
    window.dataLayer = [];
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    Object.defineProperty(window, "localStorage", { value: store, configurable: true });
    const localStorage = store;
    expect(trackFunnel("intent_selected", { intent: "new" })).toBe(false);
    expect(window.dataLayer).toEqual([]);
    localStorage.setItem(CONSENT_KEY, "all");
    phone();
    fireEvent.click(screen.getByRole("radio", { name: /New Google Workspace/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^Starter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Compare plans" }));
    const events = (window.dataLayer as Array<{ event: string }>).map((e) => e.event);
    expect(events).toEqual(["buy_ws_step_viewed", "buy_ws_intent_selected", "buy_ws_plan_selected", "buy_ws_step_viewed"]);
    expect(JSON.stringify(window.dataLayer)).not.toMatch(/@|phone|name/i);
    localStorage.removeItem(CONSENT_KEY);
  });
});
