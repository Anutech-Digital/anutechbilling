// @vitest-environment jsdom
/**
 * R-1752 (22 Oct 2026, Pardeep: the public website is English too) — the Google Workspace ads
 * landing page has ONE dictionary, in English. R-396 (7 Oct) had a Hinglish one behind a header
 * toggle and `?lang=hi`; both are removed. Pinned: no Hinglish word anywhere in the copy, no
 * toggle on the page, an old ad URL with `?lang=hi` (or a saved Hinglish choice) still opens
 * the English page, no ₹ typed into a sentence, and Business Plus shows no price.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import * as lpCopy from "./lp-copy";
import { LP_TEXT, type LpDict } from "./lp-copy";

vi.mock("@/site/lib/live-catalog", () => ({
  fetchLiveWorkspace: async () => null,
  mergeEditions: () => [{ name: "GW Business Starter", annual: 270 }],
}));

import { WorkspaceAdLanding } from "./WorkspaceAdLanding";
import { LpPlanPage, LpCategoryPage } from "@/site/lib/lp-plan-page";
import { LP_PLANS } from "@/site/lib/lp-plans";

/** Every leaf of a dictionary, functions called with fixed sample arguments, keyed by path. */
const SAMPLE = { o: { plan: "Business Starter", usersLimit: "UL", offer: true, offerPrice: "P1" } };
function leaves(v: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (typeof v === "string") out.set(path, v);
  else if (typeof v === "function") {
    const args = path.endsWith("faq.items") ? [SAMPLE.o] : Array.from({ length: (v as (...a: unknown[]) => unknown).length }, (_, i) => 7 + i);
    leaves((v as (...a: unknown[]) => unknown)(...args), `${path}()`, out);
  } else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);
  else if (typeof v === "boolean" || typeof v === "number") out.set(path, String(v));
  return out;
}
const EN = leaves(LP_TEXT);

/** Words that only appear in Hinglish copy. Whole words, case-insensitive. */
const HINGLISH_WORDS = [
  "aap", "aapka", "aapki", "aapke", "aapko", "hai", "hain", "hum", "hamari", "hamara", "mein", "nahi", "kya", "kyun",
  "kaise", "kitne", "kaunsa", "liye", "aur", "bhi", "koi", "kuch", "sab", "saal", "saalana", "mahina", "shukriya",
  "dijiye", "chahiye", "karein", "lein", "karte", "karti", "kar", "ke", "ki", "ka", "ko", "se", "par", "ek", "jald",
  "abhi", "ya", "tay", "baat", "sahi", "pehle", "pehla", "doosre", "kharidna", "kharidein", "mujhe", "main", "hoon",
  "banaye", "daam", "zaroorat", "milega", "milta", "saath", "kaam", "naya", "purana", "bhejein", "dekhein", "chunein",
  "kadam", "wale", "sawal", "jaane", "badhaiye", "khaas", "bhasha", "taiyaar", "band",
];

describe("R-1752 — one dictionary, English only", () => {
  it("there is one dictionary and no language switch is exported", () => {
    expect(EN.size).toBeGreaterThan(150);
    expect(Object.keys(lpCopy).sort()).toEqual(["LP_TEXT"]);
    expect(LP_TEXT.htmlLang).toBe("en-IN");
  });

  it("no ₹ amount is typed into the copy — prices only come in as formatted arguments", () => {
    const typed = [...EN].filter(([, v]) => /₹/.test(v));
    expect(typed).toEqual([]);
  });

  it("the dictionary has no Hinglish words", () => {
    const re = new RegExp(`\\b(${HINGLISH_WORDS.join("|")})\\b`, "i");
    const hits = [...EN].filter(([k, v]) => k !== "htmlLang" && re.test(v)).map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
    // …and the word list really catches Hinglish copy, so the check above means something.
    expect(re.test("Aapka plan kya hai? Abhi trial shuru karein.")).toBe(true);
  });

  it("type-level: a dictionary missing a key does not compile", () => {
    // @ts-expect-error — `htmlLang` (and the rest) missing: LpDict is enforced
    const broken: LpDict = { plans: {} };
    expect(broken).toBeTruthy();
  });
});

/** jsdom here has no Web Storage: a small in-memory one, replaced per test. */
class MemStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}
function useStorage(local: unknown, session: unknown = new MemStorage()) {
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => session });
}

describe("R-1752 — the page is English for every visitor", () => {
  beforeEach(() => {
    useStorage(new MemStorage());
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    window.history.replaceState(null, "", "/lp/google-workspace-business-starter-1");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders the English hero and buttons, with no English | Hinglish toggle", () => {
    const { container } = render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    expect(screen.getAllByText(LP_TEXT.plans.starter.hero.h2).length).toBe(1);
    expect(screen.getAllByRole("button", { name: /Start 14-Day Free Trial/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Hinglish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "English" })).toBeNull();
    expect(container.querySelector(".gw")?.getAttribute("lang")).toBe("en-IN");
    expect(container.textContent).not.toMatch(/Hinglish/);
  });

  it("an old ad URL with ?lang=hi, or a saved Hinglish choice, still opens the English page", async () => {
    window.history.replaceState(null, "", "/lp/google-workspace-business-starter-1?lang=hi&gclid=abc");
    window.localStorage.setItem("anutech.lp.lang.v1", "hinglish");
    render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getAllByText(LP_TEXT.plans.starter.hero.h2).length).toBe(1);
    expect(screen.getByText(LP_TEXT.faq.h3)).toBeTruthy();
  });

  it("blocked storage does not break the page", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    useStorage(blocked, blocked);
    render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    expect(screen.getAllByText(LP_TEXT.plans.starter.hero.h2).length).toBe(1);
  });

  it("the WhatsApp prefill is English", () => {
    render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    const wa = screen.queryAllByRole("link").map((a) => a.getAttribute("href") ?? "").find((h) => h.includes("wa.me"));
    if (wa) expect(decodeURIComponent(wa)).toContain(LP_TEXT.wa.want("Business Starter"));   // only when a real WhatsApp number is configured
    expect(LP_TEXT.wa.want("Business Starter")).toMatch(/^[\x20-\x7E—–₹…]+$/);
  });

  it("Business Plus shows no price", () => {
    const { container } = render(<WorkspaceAdLanding annualPerSeatMo={null} plan={LP_PLANS.plus} />);
    expect(container.textContent).not.toMatch(/₹\s?[1-9]/);
  });

  it("server side: the plan and category pages ignore ?lang= (no lang prop any more)", async () => {
    const hi = await LpPlanPage({ planKey: "starter", searchParams: Promise.resolve({ lang: "hi" }) });
    expect((hi as React.ReactElement<Record<string, unknown>>).props.lang).toBeUndefined();
    const cat = await LpCategoryPage({ searchParams: Promise.resolve({ lang: "hinglish" }) });
    expect((cat as React.ReactElement<Record<string, unknown>>).props.lang).toBeUndefined();
  });
});
