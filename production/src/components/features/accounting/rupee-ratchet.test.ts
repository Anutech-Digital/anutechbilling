/**
 * R-274 ratchet: accounting money goes through rupee() / rupeeFromPaise() / <Money>.
 *
 * WHY: a hand-built `₹{n.toLocaleString(...)}` or `₹${n}` picks its own decimals and puts a
 * minus sign wherever toLocaleString puts it — the audit found mixed decimals and two local
 * formatters in these folders. rupee() is the one place that decides lakh grouping, sign and
 * decimals.
 *
 * The count may only go DOWN. Allowed (not money amounts, or not ours to change):
 *  - FX / per-unit RATES echoed back ("@ ₹{rate}/USD", "× ₹{perSeatYear}") — rupee() would
 *    round 83.25 to ₹83 and hide the rate the owner typed.
 *  - the vendor-bill FX note: that string is STORED in notes, so its format must not move.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const FOLDERS = [
  "src/components/features/accounting",
  "src/app/(app)/accounting/payroll",
  "src/app/(app)/accounting/esi-register",
  "src/app/(app)/accounting/google-bill-check",
  "src/components/features/reconcile",
];

/** Lines matching any of these are allowed to keep a literal ₹ before an expression. */
const ALLOW: RegExp[] = [
  /@ ₹\$?\{rate\}/,            // FX rate shown as typed (bills, expenses)
  /× ₹\{perSeatYear \|\| 0\}/, // per-seat rate echoed from the input box
  /Foreign bill: .*= ₹\$\{inr\(values\.total\)/, // persisted FX note — stored value
];

/** Hand-built rupee: JSX `₹{` or template `₹${`. */
const HAND_BUILT = /₹\$?\{/g;

/** Ratchet — lower it when you convert more, never raise it. */
const MAX = 0;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function offenders(): string[] {
  const hits: string[] = [];
  for (const folder of FOLDERS) {
    for (const f of files(join(ROOT, folder))) {
      readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (!HAND_BUILT.test(line)) return;
        HAND_BUILT.lastIndex = 0;
        if (ALLOW.some((a) => a.test(line))) return;
        hits.push(`${relative(ROOT, f)}:${i + 1}`);
      });
      HAND_BUILT.lastIndex = 0;
    }
  }
  return hits;
}

describe("R-274 accounting rupee ratchet", () => {
  it(`has at most ${MAX} hand-built ₹{…} outside the allowlist`, () => {
    const hits = offenders();
    expect(hits.length, `Use rupee()/rupeeFromPaise()/<Money> instead:\n${hits.join("\n")}`).toBeLessThanOrEqual(MAX);
  });

  it("catches a hand-built rupee (the matcher is not dead)", () => {
    expect(HAND_BUILT.test("<b>₹{profit}</b>")).toBe(true);
    HAND_BUILT.lastIndex = 0;
    expect(HAND_BUILT.test("`₹${n.toLocaleString()}`")).toBe(true);
    HAND_BUILT.lastIndex = 0;
    expect(HAND_BUILT.test("{rupee(profit)}")).toBe(false);
    HAND_BUILT.lastIndex = 0;
  });

  it("every allowlist entry still matches a real line (no stale exemptions)", () => {
    const all = FOLDERS.flatMap((d) => files(join(ROOT, d))).map((f) => readFileSync(f, "utf8")).join("\n");
    for (const a of ALLOW) expect(a.test(all), String(a)).toBe(true);
  });
});
