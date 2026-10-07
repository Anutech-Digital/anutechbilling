/**
 * R-229 — one set of service promises on the public website (7 Oct 2026).
 *
 * The site promised "call within 30 minutes (9am–7pm)", "WhatsApp within 4 hours",
 * "Live in 24 hours" and "same day" on different pages, against support hours of
 * 10:00–19:00. Pardeep's manager fixed realistic values; they live in SLA (config.ts)
 * and every page reads them from there. This test fails if an old promise comes back
 * anywhere in the public site's source.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SLA, COMPANY, AFTER_YOU_PAY } from "./config";

const ROOT = path.resolve(__dirname, "../../..");
const DIRS = ["src/site", "src/app/(public)", "src/app/(marketing)"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Comments may explain what was removed; only shipped text counts. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

const OLD_PROMISES: Array<[string, RegExp]> = [
  ["call within 30 minutes", /\b30 minutes\b/i],
  ["9am–7pm hours", /\b9\s?am\b/i],
  ["Live in 24 hours", /live in 24 hours/i],
  ["under 24 hours", /under 24 hours/i],
  ["Within 24 hours: …", /within 24 hours\s*[:—–-]/i],
  ["within 4 hours (not working hours)", /within 4 hours/i],
  ["same day", /\bsame day\b/i],
  ["24x7 / 24/7", /\b24\s*[x×/]\s*7\b/i],
];

describe("R-229 public site promises", () => {
  it("no old or contradicting time promise is left in the public site", () => {
    const hits: string[] = [];
    for (const d of DIRS) {
      for (const f of sourceFiles(path.join(ROOT, d))) {
        const text = withoutComments(fs.readFileSync(f, "utf8"));
        for (const [name, re] of OLD_PROMISES) {
          if (re.test(text)) hits.push(`${path.relative(ROOT, f)}: ${name}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("SLA carries exactly the manager's decided values", () => {
    expect(SLA.hours).toBe("Mon–Sat, 10:00–19:00 IST");
    expect(SLA.firstReply).toBe("within 4 working hours");
    expect(SLA.workspaceLive).toBe("within 1 working day of payment and DNS verification");
    expect(SLA.hostingLive).toBe("within 4 working hours of payment");
    expect(SLA.domainRegistered).toBe("within 2 working hours of payment");
    expect(SLA.sslLive).toBe("within 1 working day of the domain pointing to us");
    expect(COMPANY.hours).toBe(SLA.hours);
  });

  it("'After you pay' is three lines built from SLA, with no 24x7 or guarantee", () => {
    expect(AFTER_YOU_PAY).toHaveLength(3);
    const all = AFTER_YOU_PAY.join(" ");
    for (const v of [SLA.firstReply, SLA.hostingLive, SLA.domainRegistered, SLA.workspaceLive, SLA.sslLive]) {
      expect(all).toContain(v);
    }
    expect(all).not.toMatch(/24\s*[x×/]\s*7|guarantee/i);
  });
});
