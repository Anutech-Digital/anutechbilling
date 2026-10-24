/**
 * R-738 follow-up: production CSP has no 'unsafe-eval' (only 'wasm-unsafe-eval'), so every
 * pdf.js getDocument call must pass isEvalSupported: false — otherwise pdf.js probes
 * `new Function` and the browser logs a CSP violation on every PDF opened.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "generated") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("pdf.js getDocument runs without eval (CSP has no unsafe-eval)", () => {
  const calls: { file: string; args: string }[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    const re = /getDocument\(\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) calls.push({ file, args: m[1] });
  }

  it("finds the pdf.js call sites", () => {
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it("every getDocument call passes isEvalSupported: false", () => {
    const missing = calls.filter((c) => !/isEvalSupported:\s*false/.test(c.args)).map((c) => c.file);
    expect(missing).toEqual([]);
  });
});
