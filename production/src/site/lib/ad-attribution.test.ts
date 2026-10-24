import { describe, it, expect, vi, afterEach } from "vitest";
import { pickAdParams, withAdParams, rememberLanding, landingForForm } from "./ad-attribution";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("ad attribution on the landing page (R-139)", () => {
  it("keeps only ad keys", () => {
    expect(pickAdParams("?gclid=abc&utm_source=google&x=1&ref=me").toString()).toBe("gclid=abc&utm_source=google");
    expect(pickAdParams("").toString()).toBe("");
  });

  it("carries the ad params onto the Buy link without dropping its own", () => {
    const ad = pickAdParams("?gclid=abc&utm_campaign=gw-starter");
    expect(withAdParams("/buy/workspace?tier=starter&seats=5&buy=1", ad))
      .toBe("/buy/workspace?tier=starter&seats=5&buy=1&gclid=abc&utm_campaign=gw-starter");
    expect(withAdParams("/trial", new URLSearchParams())).toBe("/trial");
  });

  it("first ad landing of the visit wins; a later plain page reports it", () => {
    const s = memory();
    const first = "https://anutech.in/lp/google-workspace?gclid=FIRST";
    expect(rememberLanding(first, s)).toBe(first);
    expect(rememberLanding("https://anutech.in/lp/google-workspace", s)).toBe(first);
    expect(rememberLanding("https://anutech.in/lp/google-workspace?gclid=SECOND", s)).toBe(first);
  });

  it("a visit with no ad params stores nothing; storage failures never throw", () => {
    const s = memory();
    expect(rememberLanding("https://anutech.in/lp/google-workspace", s)).toBe("https://anutech.in/lp/google-workspace");
    expect(s.getItem("anutech.lp.landing.v1")).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(rememberLanding("https://x.in/?gclid=1", broken)).toBe("https://x.in/?gclid=1");
    expect(rememberLanding("https://x.in/?gclid=1", null)).toBe("https://x.in/?gclid=1");
  });
});

describe("landingForForm — what /quote and /trial send (R-1598)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("on the server it sends nothing", () => {
    expect(landingForForm()).toEqual({});
  });

  it("sends the landing URL with gclid/utm intact, and the referrer", () => {
    vi.stubGlobal("window", { location: { href: "https://anutech.in/quote?utm_source=google&gclid=abc" }, sessionStorage: memory() });
    vi.stubGlobal("document", { referrer: "https://www.google.com/" });
    expect(landingForForm()).toEqual({ pageUrl: "https://anutech.in/quote?utm_source=google&gclid=abc", pageReferrer: "https://www.google.com/" });
  });

  it("the first ad landing of the visit wins over the page the form is on", () => {
    const store = memory();
    vi.stubGlobal("document", { referrer: "" });
    vi.stubGlobal("window", { location: { href: "https://anutech.in/lp/gw?gclid=first" }, sessionStorage: store });
    landingForForm();
    vi.stubGlobal("window", { location: { href: "https://anutech.in/quote" }, sessionStorage: store });
    expect(landingForForm()).toEqual({ pageUrl: "https://anutech.in/lp/gw?gclid=first" });
  });
});
