// @vitest-environment jsdom
/**
 * R-396 (7 Oct 2026, Pardeep: "both options hone chahiye") — the Google Workspace ads landing
 * page speaks English by default and Hinglish on `?lang=hi` or the header toggle. Pinned:
 * both dictionaries have the same keys (also a compile error), the facts and numbers match
 * line for line, the English one has no Hinglish words, no ₹ is typed into a sentence, and
 * the page picks the language from the server prop, the URL, the toggle and localStorage.
 */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { LP_TEXT, parseLpLang, LP_LANG_STORE, type LpDict } from "./lp-copy";

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
const EN = leaves(LP_TEXT.en);
const HI = leaves(LP_TEXT.hinglish);

/** Words that only appear in Hinglish copy. Whole words, case-insensitive. */
const HINGLISH_WORDS = [
  "aap", "aapka", "aapki", "aapke", "aapko", "hai", "hain", "hum", "hamari", "hamara", "mein", "nahi", "kya", "kyun",
  "kaise", "kitne", "kaunsa", "liye", "aur", "bhi", "koi", "kuch", "sab", "saal", "saalana", "mahina", "shukriya",
  "dijiye", "chahiye", "karein", "lein", "karte", "karti", "kar", "ke", "ki", "ka", "ko", "se", "par", "ek", "jald",
  "abhi", "ya", "tay", "baat", "sahi", "pehle", "pehla", "doosre", "kharidna", "kharidein", "mujhe", "main", "hoon",
  "banaye", "daam", "zaroorat", "milega", "milta", "saath", "kaam", "naya", "purana", "bhejein", "dekhein", "chunein",
  "kadam", "wale", "sawal", "jaane", "badhaiye", "khaas", "bhasha", "taiyaar", "band",
];

describe("R-396 — one typed dictionary, two languages", () => {
  it("English and Hinglish have exactly the same keys (deep, incl. function results)", () => {
    expect([...HI.keys()].sort()).toEqual([...EN.keys()].sort());
    expect(EN.size).toBeGreaterThan(150);
  });

  it("facts stay identical: every line carries the same numbers in both languages", () => {
    const nums = (s: string) => (s.match(/\d[\d,]*/g) ?? []).map((x) => x.replace(/,/g, "")).sort();
    const diffs = [...EN].filter(([k, v]) => JSON.stringify(nums(v)) !== JSON.stringify(nums(HI.get(k) ?? "")));
    expect(diffs.map(([k]) => k)).toEqual([]);
  });

  it("no ₹ amount is typed into the copy — prices only come in as formatted arguments", () => {
    const typed = [...EN, ...HI].filter(([, v]) => /₹/.test(v));
    expect(typed).toEqual([]);
  });

  it("the English dictionary has no Hinglish words", () => {
    const re = new RegExp(`\\b(${HINGLISH_WORDS.join("|")})\\b`, "i");
    const hits = [...EN].filter(([k, v]) => k !== "htmlLang" && re.test(v)).map(([k, v]) => `${k}: ${v}`);
    expect(hits).toEqual([]);
    // …and the word list really catches the Hinglish copy, so the check above means something.
    expect([...HI].filter(([, v]) => re.test(v)).length).toBeGreaterThan(50);
  });

  it("?lang= parsing: hi / hinglish → Hinglish, en / english → English, anything else → null", () => {
    expect(parseLpLang("hi")).toBe("hinglish");
    expect(parseLpLang("Hinglish")).toBe("hinglish");
    expect(parseLpLang(["hi", "en"])).toBe("hinglish");
    expect(parseLpLang("en")).toBe("en");
    expect(parseLpLang("english")).toBe("en");
    expect(parseLpLang("fr")).toBeNull();
    expect(parseLpLang(undefined)).toBeNull();
    expect(parseLpLang("")).toBeNull();
  });

  it("type-level: a dictionary missing a key does not compile", () => {
    // @ts-expect-error — `htmlLang` (and the rest) missing: LpDict is enforced on both languages
    const broken: LpDict = { langToggleLabel: "x" };
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

describe("R-396 — the page picks the language", () => {
  beforeEach(() => {
    useStorage(new MemStorage());
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
    window.history.replaceState(null, "", "/lp/google-workspace-business-starter-1");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("defaults to English", () => {
    render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    expect(screen.getAllByText(LP_TEXT.en.plans.starter.hero.h2).length).toBe(1);
    expect(screen.getAllByRole("button", { name: /Start 14-Day Free Trial/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText(LP_TEXT.hinglish.plans.starter.hero.h2)).toBeNull();
  });

  it("lang=hinglish from the server renders Hinglish on the first paint", () => {
    const { container } = render(<WorkspaceAdLanding annualPerSeatMo={270} lang="hinglish" />);
    expect(screen.getByText(LP_TEXT.hinglish.plans.starter.hero.h2)).toBeTruthy();
    expect(screen.getByText(LP_TEXT.hinglish.faq.h3)).toBeTruthy();
    expect(container.querySelector(".gw")?.getAttribute("lang")).toBe("hi-Latn");
  });

  it("?lang=hi in the address switches to Hinglish even without the server prop", async () => {
    window.history.replaceState(null, "", "/lp/google-workspace-business-starter-1?lang=hi&gclid=abc");
    render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    await waitFor(() => expect(screen.getByText(LP_TEXT.hinglish.plans.starter.hero.h2)).toBeTruthy());
  });

  it("the toggle switches both ways, remembers the choice and keeps ?lang= in step", async () => {
    window.history.replaceState(null, "", "/lp/google-workspace-business-starter-1?lang=en");
    render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    fireEvent.click(screen.getByRole("button", { name: "Hinglish" }));
    expect(screen.getByText(LP_TEXT.hinglish.plans.starter.hero.h2)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hinglish" }).getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(LP_LANG_STORE)).toBe("hinglish");
    expect(new URL(window.location.href).searchParams.get("lang")).toBe("hi");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByText(LP_TEXT.en.plans.starter.hero.h2)).toBeTruthy();
    expect(window.localStorage.getItem(LP_LANG_STORE)).toBe("en");
    expect(new URL(window.location.href).searchParams.get("lang")).toBe("en");
  });

  it("a saved choice comes back on the next visit (no ?lang=)", async () => {
    window.localStorage.setItem(LP_LANG_STORE, "hinglish");
    render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    await waitFor(() => expect(screen.getByText(LP_TEXT.hinglish.plans.starter.hero.h2)).toBeTruthy());
  });

  it("blocked storage does not break the page or the toggle", () => {
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    useStorage(blocked, blocked);
    render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    fireEvent.click(screen.getByRole("button", { name: "Hinglish" }));
    expect(screen.getByText(LP_TEXT.hinglish.plans.starter.hero.h2)).toBeTruthy();
  });

  it("the WhatsApp prefill follows the language", () => {
    const { unmount } = render(<WorkspaceAdLanding annualPerSeatMo={270} />);
    const en = screen.queryAllByRole("link").map((a) => a.getAttribute("href") ?? "").find((h) => h.includes("wa.me"));
    unmount();
    render(<WorkspaceAdLanding annualPerSeatMo={270} lang="hinglish" />);
    const hi = screen.queryAllByRole("link").map((a) => a.getAttribute("href") ?? "").find((h) => h.includes("wa.me"));
    if (en && hi) {   // only when a real WhatsApp number is configured
      expect(decodeURIComponent(en)).toContain(LP_TEXT.en.wa.want("Business Starter"));
      expect(decodeURIComponent(hi)).toContain(LP_TEXT.hinglish.wa.want("Business Starter"));
    }
  });

  it("Business Plus shows no price in either language", () => {
    for (const lang of ["en", "hinglish"] as const) {
      const { container, unmount } = render(<WorkspaceAdLanding annualPerSeatMo={null} plan={LP_PLANS.plus} lang={lang} />);
      expect(container.textContent).not.toMatch(/₹\s?[1-9]/);
      unmount();
    }
  });

  it("server side: the plan and category pages pass ?lang=hi through as Hinglish, else English", async () => {
    const hi = await LpPlanPage({ planKey: "starter", searchParams: Promise.resolve({ lang: "hi" }) });
    expect((hi as React.ReactElement<{ lang: string }>).props.lang).toBe("hinglish");
    const none = await LpPlanPage({ planKey: "starter", searchParams: Promise.resolve({}) });
    expect((none as React.ReactElement<{ lang: string }>).props.lang).toBe("en");
    const cat = await LpCategoryPage({ searchParams: Promise.resolve({ lang: "hinglish" }) });
    expect((cat as React.ReactElement<{ lang: string }>).props.lang).toBe("hinglish");
  });
});
