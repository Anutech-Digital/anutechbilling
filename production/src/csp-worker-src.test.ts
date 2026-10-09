/**
 * R-525 (9 Oct 2026) — the CSP must allow blob: WORKERS, and only workers.
 *
 * In the production build, quote "Download PDF" spun forever. The console said
 * "Creating a worker from 'blob:…' violates … script-src". next.config.mjs had no
 * worker-src, so the browser fell back to script-src, which (rightly) has no blob:.
 * The PDF renderer's worker was refused and the render promise never settled.
 *
 * The fix is `worker-src 'self' blob:` — NOT blob: on script-src, which would let any
 * blob URL run as a page script. This file pins both halves.
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — next.config.mjs is plain JS with no type declarations.
import nextConfig from "../next.config.mjs";

type ConfigWithHeaders = {
  headers: () => Promise<Array<{ headers: Array<{ key: string; value: string }> }>>;
};

async function directives(): Promise<Map<string, string[]>> {
  const groups = await (nextConfig as ConfigWithHeaders).headers();
  const csp = groups.flatMap((g) => g.headers).find((h) => h.key === "Content-Security-Policy");
  if (!csp) throw new Error("no Content-Security-Policy header emitted");
  const map = new Map<string, string[]>();
  for (const d of csp.value.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...sources] = d.split(/\s+/);
    map.set(name, sources);
  }
  return map;
}

describe("CSP worker-src (R-525)", () => {
  it("has a worker-src that allows 'self' and blob:", async () => {
    const d = await directives();
    const worker = d.get("worker-src");
    expect(worker, "worker-src missing — script-src would apply and block blob: workers").toBeDefined();
    expect(worker).toContain("blob:");
    expect(worker).toContain("'self'");
  });

  it("script-src stays free of blob: (workers only, not page scripts)", async () => {
    const d = await directives();
    const script = d.get("script-src");
    expect(script).toBeDefined();
    expect(script).not.toContain("blob:");
  });
});
