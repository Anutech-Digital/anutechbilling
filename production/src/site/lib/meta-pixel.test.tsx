// @vitest-environment jsdom
/**
 * R-1979: the browser Meta Pixel — no id → no script; no "Accept all" → no script; with both →
 * Meta's script once, init + PageView; trackMeta carries the eventID for dedup.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MetaPixel, trackMeta, metaConsent, fbpCookie, CONSENT_KEY } from "./meta-pixel";

/* jsdom here has no usable localStorage (Node 26) — a small in-memory one. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } } as Storage;
}

const scripts = () => [...document.querySelectorAll('script[src*="connect.facebook.net"]')];

beforeEach(() => { delete window.fbq; delete window._fbq; Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true }); document.head.innerHTML = ""; });
afterEach(() => cleanup());

describe("R-1979 MetaPixel", () => {
  it("no pixel id → no script, no fbq", () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<MetaPixel pixelId={null} />);
    expect(scripts()).toHaveLength(0);
    expect(window.fbq).toBeUndefined();
  });

  it("pixel id but no consent (or 'essential') → nothing loads", () => {
    render(<MetaPixel pixelId="1234567890123456" />);
    window.localStorage.setItem(CONSENT_KEY, "essential");
    render(<MetaPixel pixelId="1234567890123456" />);
    expect(scripts()).toHaveLength(0);
    expect(metaConsent()).toBe(false);
  });

  it("pixel id + Accept all → Meta's script once, init then PageView queued", () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<><MetaPixel pixelId="1234567890123456" /><MetaPixel pixelId="1234567890123456" /></>);
    expect(scripts()).toHaveLength(1);
    expect(window.fbq?.queue?.slice(0, 2)).toEqual([["init", "1234567890123456"], ["track", "PageView", {}, undefined]]);
  });

  it("a malformed id is never loaded", () => {
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<MetaPixel pixelId={"1'); alert(1); //"} />);
    expect(scripts()).toHaveLength(0);
  });

  it("trackMeta: Purchase with value, currency and the eventID; a no-op without the pixel", () => {
    trackMeta("Purchase", { value: 3240 }, "purchase-Q1"); // not loaded → nothing, no throw
    window.localStorage.setItem(CONSENT_KEY, "all");
    render(<MetaPixel pixelId="1234567890123456" />);
    trackMeta("Purchase", { value: 3240, currency: "INR" }, "purchase-Q1");
    expect(window.fbq?.queue?.at(-1)).toEqual(["track", "Purchase", { value: 3240, currency: "INR" }, { eventID: "purchase-Q1" }]);
  });

  it("fbpCookie reads _fbp", () => {
    document.cookie = "_fbp=fb.1.123.456";
    expect(fbpCookie()).toBe("fb.1.123.456");
  });
});
