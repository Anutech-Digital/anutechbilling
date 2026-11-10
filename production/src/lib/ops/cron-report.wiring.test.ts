import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

/* ─────────────────────────────────────────────────────────────────────────────
   Helper likh dena aadha kaam hai. Asli bug ye tha ki cron BOLTE NAHI THE — aur wo aaj bhi
   dobara ho sakta hai, sirf ek naya cron jod kar. Ye file har cron route ko khud padhti hai
   aur poochhti hai: tu failure ginta hai? to bolta bhi hai?

   28 Aug 2026 ko ginti: 16 me se 8 cron failure gin rahe the aur chup the.
   ───────────────────────────────────────────────────────────────────────────── */

const CRON_DIR = join(process.cwd(), "src", "app", "api", "cron");

/** Kya ye route apni failure ginta hai — yaani uske paas kehne ko kuch hai. */
const COUNTS_FAILURE = /\b(failed|failures)\b|\berrors\s*[:.]|\berrors\.push\b/;

/** Kya wo awaaz nikaalta hai — helper se, ya apne hi console.error se. */
const SPEAKS = /reportCron\s*\(|console\.error\s*\(/;

const routes = readdirSync(CRON_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ name: d.name, path: join(CRON_DIR, d.name, "route.ts") }))
  .filter((r) => { try { readFileSync(r.path); return true; } catch { return false; } })
  .map((r) => ({ ...r, src: readSource(r.path) }));

describe("har cron jo failure ginta hai, wo bolta bhi hai", () => {
  it("cron mile hi — warna neeche ka loop zero baar chalega aur jhooth bol kar green hoga", () => {
    /* Khaali loop hamesha pass hota hai. Ginti pehle. */
    expect(routes.length).toBeGreaterThanOrEqual(16);
  });

  const counting = routes.filter((r) => COUNTS_FAILURE.test(r.src));

  it("ginne wale cron bhi mile", () => {
    expect(counting.length).toBeGreaterThanOrEqual(14);
  });

  for (const r of counting) {
    it(`${r.name} — failure ginta hai, to stderr par bolta bhi hai`, () => {
      expect(SPEAKS.test(r.src), `${r.name}/route.ts failure ginta hai par chup hai. ` +
        `Fix: return NextResponse.json(reportCron("${r.name}", result))`).toBe(true);
    });
  }
});

describe("reportCron sahi naam ke saath laga hai", () => {
  /* Copy-paste se doosre cron ka naam reh jana sabse aasan galti hai, aur us din digest
     galat cron ki taraf ungli karega — jo chup rehne se bhi bura hai. */
  for (const r of routes.filter((x) => x.src.includes("reportCron("))) {
    it(`${r.name} apna hi naam bolta hai`, () => {
      const names = [...r.src.matchAll(/reportCron\(\s*"([^"]+)"/g)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n).toBe(r.name);
    });
  }
});
