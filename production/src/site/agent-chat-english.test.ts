/**
 * R-235 (7 Oct 2026, Pardeep: "R-235 haan"): the public website is English, so the AI chat
 * speaks English by default — greeting, error text, chips, input placeholder. The agent
 * mirrors the visitor: Hindi / Hinglish in → Hindi / Hinglish out, otherwise English.
 * The Ads landing forms follow the same default for their status/error lines.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { systemPrompt, honestNoDeliveryReply, prefersHinglish, promisesDelivery } from "@/lib/ai/public-sales-chat";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** Words that only appear in Hindi/Hinglish copy — none may sit in a default string. */
const HINDI_WORDS = /\b(namaste|abhi|hoon|nahi|logo|daam|bataiye|kitne|chahiye|jawab|mile|ban gayi|humari|hamari|sampark|karegi|lijiye|paya|chal raha|gayi)\b/i;

/** Every user-visible string literal in a TSX source, comments stripped. */
function visibleStrings(src: string): string[] {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of noComments.matchAll(/"([^"\n]{6,})"|`([^`\n]{6,})`/g)) out.push(m[1] ?? m[2]);
  for (const m of noComments.matchAll(/>\s*([^<>{}\n]*[A-Za-z]{3,}[^<>{}\n]*)\s*</g)) out.push(m[1]);
  return out;
}

describe("R-235 — website AI chat defaults to English", () => {
  const chat = read("src/site/components/agent/AgentChat.tsx");

  it("greeting, error, chips and placeholder carry no Hindi words", () => {
    const hits = visibleStrings(chat).filter((s) => HINDI_WORDS.test(s));
    expect(hits).toEqual([]);
  });

  it("the greeting still opens discovery with a seat-count question", () => {
    expect(chat).toMatch(/how many people need business email\?/i);
  });

  it("the lead-captured chips read in English", () => {
    expect(chat).toContain("DETAILS RECEIVED");
    expect(chat).not.toMatch(/DETAILS MILE/);
  });

  it("the Ads landing form status/error lines are English", () => {
    const lp = read("src/site/components/lp/WorkspaceAdLanding.tsx");
    expect(lp).not.toContain("spam check chal raha hai");
    expect(lp).not.toContain("Request nahi gayi");
  });
});

describe("R-235 — the agent mirrors the visitor's language", () => {
  const p = systemPrompt("F");

  it("system prompt: English by default, Hindi/Hinglish only when the visitor writes it", () => {
    expect(p).toContain("Reply in English by default");
    expect(p).toMatch(/Hindi .*Hinglish.*reply in that same language/i);
    expect(p).not.toContain("Hinglish is common");
  });

  it("prefersHinglish: Devanagari and Roman Hindi yes, plain English no", () => {
    expect(prefersHinglish("मुझे 20 ईमेल चाहिए")).toBe(true);
    expect(prefersHinglish("20 logo ke liye Workspace ka daam kya hai?")).toBe(true);
    expect(prefersHinglish("mujhe business email chahiye")).toBe(true);
    expect(prefersHinglish("How much is Workspace for 20 users?")).toBe(false);
    expect(prefersHinglish("Hi, I need email for my team")).toBe(false);
    expect(prefersHinglish("")).toBe(false);
  });

  it("the honest no-delivery reply mirrors too, and never promises delivery", () => {
    const en = honestNoDeliveryReply("Has the quotation been sent?");
    const hi = honestNoDeliveryReply("quotation bheji kya?");
    expect(HINDI_WORDS.test(en)).toBe(false);
    expect(en).toMatch(/name, email and phone/i);
    expect(hi).toMatch(/naam, email aur phone/i);
    expect(honestNoDeliveryReply()).toBe(en);
    expect(promisesDelivery(en)).toBe(false);
    expect(promisesDelivery(hi)).toBe(false);
  });
});
