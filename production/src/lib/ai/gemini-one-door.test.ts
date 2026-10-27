import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

/* R-1817 (24 Oct 2026): these two repo-source scans moved here from gemini.test.ts so the push
   guard (scripts/ops/push-guard-suites.mjs) runs only them. gemini.test.ts waits on real retry /
   breaker timers (~35 s alone) and was the longest suite on every push; it still runs in CI. */

/* ══ Hot path apna khud ka fetch na kare ════════════════════════════════════ */
describe("inbound-email ka extract geminiJson se guzre", () => {
  it("apna fetch nahi karta — breaker aur timeout usi se milte hain", () => {
    /* 23 Aug ko yahi jagah 7 second me 8 baar 429 kha gayi thi, kyunki iske paas breaker
       hi nahi tha. Aur timeout na hone ka matlab tha: Gemini atke to ye request atke, aur
       forwarder POST ke baad thread label kar deta hai — yaani enquiry gayi. */
    const src = readFileSync(
      join(process.cwd(), "src", "lib", "inbound", "ingest.ts"), "utf8");
    expect(src).toContain("geminiJson<Partial<ExtractedLead>>");
    expect(src).not.toContain("generativelanguage.googleapis.com");
  });
});

/* ══ 28 Aug 2026 — Gemini ka ek hi darwaza ═══════════════════════════════════
   Us din tak AATH jagah apna `fetch` karke Gemini bulati thi. Har ek geminiJson ki
   lagbhag hu-ba-hu copy thi — wahi request shape, wahi ```json fence ka safai — bas uski
   suraksha ke bina: **na timeout, na circuit breaker, na retry**.

   Keemat log me naapi gayi: 23 Aug ko `[inbound-email] Gemini failed: 429` SAAT SECOND ME
   AATH BAAR. Free-tier ka quota 5-per-minute tha; geminiJson ka breaker 3 lagatar failure
   ke baad ruk jata hai, par us jagah breaker hi nahi tha.

   Aur timeout ka na hona isse bura tha: read-bill aur ai/extract-statement ke paas KOI
   timeout nahi tha, aur wo dono paise ka data padhte hain (vendor bill, bank statement).

   Meri apni ginti bhi pehle GALAT thi — maine `Gemini failed:` message se grep kiya tha,
   URL se nahi, aur teen jagah chhoot gayi thi. Isliye ye test message par nahi, **URL par**
   baitha hai.
   ══════════════════════════════════════════════════════════════════════════════ */
describe("Gemini ka ek hi darwaza", () => {
  const SRC = join(process.cwd(), "src");

  /* Prisma's generated client (gitignored, ~35 MB, made by `prisma generate`) is not our code. */
  const GENERATED = join(SRC, "server", "db", "generated");

  /** Har .ts/.tsx file, test files chhod kar. */
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (p !== GENERATED) walk(p, out); }
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  /**
   * Ek chhoot, aur uski wajah us file me likhi hai: key-test route ko apna fetch chahiye,
   * kyunki breaker module-scoped hai — doosre feature ke teen failure ke baad ye page
   * "aapki key kaam nahi karti" keh deta, jabki key theek hai.
   */
  const ALLOWED = [
    join("src", "lib", "ai", "gemini.ts"),
    join("src", "app", "api", "integrations", "gemini", "test", "route.ts"),
  ];

  it("gemini.ts aur key-test ke ALAWA koi seedha Gemini API nahi bulata", () => {
    const offenders = walk(SRC)
      .filter((p) => readFileSync(p, "utf8").includes("generativelanguage.googleapis.com"))
      .filter((p) => !ALLOWED.some((a) => p.endsWith(a)));
    expect(offenders.map((p) => p.slice(p.indexOf("src")))).toEqual([]);
  });

  it("chhoot wali dono file asli me maujood hain", () => {
    /* Warna ek rename is test ko chup-chaap khokhla kar deta: allow-list kisi cheez se
       mel nahi khati, aur offenders hamesha khaali. */
    for (const a of ALLOWED) {
      expect(existsSync(join(process.cwd(), a)), a).toBe(true);
    }
  });
});
