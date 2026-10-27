/**
 * R-1978 (26 Oct 2026, G-ADS): utm_content (which ad) and utm_term (keyword) are captured like
 * the other utm params — cleaned, capped — and kept in the landing URL; other query params never are.
 */
import { describe, it, expect } from "vitest";
import { captureUtm, EMPTY_UTM } from "./utm";

describe("R-1978 utm_content + utm_term", () => {
  it("a Meta ad URL → content + term captured; landing URL keeps utm only (no email)", () => {
    const c = captureUtm({ url: "https://example.in/buy/workspace?utm_source=facebook&utm_content=ad1&utm_term=g%20suite&email=a@b.in&fbclid=X" });
    expect(c.utm_content).toBe("ad1");
    expect(c.utm_term).toBe("g suite");
    expect(c.fbclid).toBe("X");
    expect(c.landing_page_url).toBe("https://example.in/buy/workspace?utm_source=facebook&utm_content=ad1&utm_term=g+suite");
  });
  it("nothing tagged → null, and EMPTY_UTM has both keys", () => {
    const c = captureUtm({ url: "https://example.in/buy/workspace" });
    expect(c.utm_content).toBeNull();
    expect(c.utm_term).toBeNull();
    expect(EMPTY_UTM).toMatchObject({ utm_content: null, utm_term: null });
  });
  it("values are capped at 120 characters", () => {
    const c = captureUtm({ url: `https://example.in/?utm_content=${"a".repeat(300)}` });
    expect(c.utm_content).toHaveLength(120);
  });
});
