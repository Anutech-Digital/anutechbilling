/**
 * R-1503 — /status shows what is true NOW, not hand-written uptime.
 *
 * Pawan (staging report b8cc1e4e): "System status is static it should reflect our current
 * system conditions. Otherwise it is useless". The page printed six hand-typed 90-day uptime
 * figures and 30 bars per service while nothing records uptime. These tests pin:
 *   1. no uptime percentage / bar history is written into the page or its data;
 *   2. each service's state comes from a live check — a failing or hung check shows
 *      Down, a slow one Degraded, a missing setting "Not configured";
 *   3. the rendered page carries a "Last checked" IST time and an overall banner.
 * The real probes (database, Razorpay, registrar, email) are mocked — no network here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ProbeResult } from "./probes";

type Probe = () => Promise<ProbeResult>;
const probes: Record<"database" | "payments" | "registrar" | "email", Probe> = {
  database: async () => ({ state: "ok" }),
  payments: async () => ({ state: "ok" }),
  registrar: async () => ({ state: "ok" }),
  email: async () => ({ state: "ok" }),
};

vi.mock("./probes", () => ({
  STATUS_PROBES: {
    database: () => probes.database(),
    payments: () => probes.payments(),
    registrar: () => probes.registrar(),
    email: () => probes.email(),
  },
}));

const { checkServices, resetStatusCache, getStatusSnapshot } = await import("./checks");

const DIR = join(__dirname);
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

beforeEach(() => {
  resetStatusCache();
  probes.database = async () => ({ state: "ok" });
  probes.payments = async () => ({ state: "ok" });
  probes.registrar = async () => ({ state: "ok" });
  probes.email = async () => ({ state: "ok" });
});

describe("R-1503: no invented uptime history", () => {
  test("the page has no hard-coded uptime percentages or 90-day bars", () => {
    const page = read("page.tsx");
    expect(page).not.toMatch(/\d{2}\.\d+%/);
    expect(page).not.toMatch(/STATUS_SERVICES|uptime|length:\s*30/i);
    expect(page).not.toMatch(/ninety days|90-day|90 days/i);
  });

  test("the site data file no longer carries the hand-written status list", () => {
    const misc = readFileSync(join(DIR, "..", "..", "..", "site", "lib", "data", "misc.ts"), "utf8");
    expect(misc).not.toMatch(/STATUS_SERVICES|uptime:\s*"/);
  });
});

describe("R-1503: each service is checked live", () => {
  test("all checks pass → every service Operational", async () => {
    const r = await checkServices({ timeoutMs: 200, slowMs: 100 });
    expect(r.services.map((s) => [s.key, s.state])).toEqual([
      ["app", "operational"],
      ["database", "operational"],
      ["payments", "operational"],
      ["registrar", "operational"],
      ["email", "operational"],
    ]);
    expect(r.overall).toBe("operational");
  });

  test("a failing check shows Down, and the banner says so", async () => {
    probes.database = async () => { throw new Error("connection refused"); };
    const r = await checkServices({ timeoutMs: 200, slowMs: 100 });
    const db = r.services.find((s) => s.key === "database")!;
    expect(db.state).toBe("down");
    expect(r.overall).toBe("down");
    // the raw error never reaches the visitor
    expect(JSON.stringify(r)).not.toContain("connection refused");
  });

  test("an error result shows Down", async () => {
    probes.email = async () => ({ state: "error" });
    const r = await checkServices({ timeoutMs: 200, slowMs: 100 });
    expect(r.services.find((s) => s.key === "email")!.state).toBe("down");
  });

  test("a check that never answers times out and shows Down — the page does not hang", async () => {
    probes.registrar = () => new Promise<ProbeResult>(() => {});
    const t0 = Date.now();
    const r = await checkServices({ timeoutMs: 150, slowMs: 100 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.services.find((s) => s.key === "registrar")!.state).toBe("down");
  });

  test("a slow but successful check shows Degraded", async () => {
    probes.payments = () => new Promise<ProbeResult>((res) => setTimeout(() => res({ state: "ok" }), 120));
    const r = await checkServices({ timeoutMs: 1000, slowMs: 50 });
    expect(r.services.find((s) => s.key === "payments")!.state).toBe("degraded");
    expect(r.overall).toBe("degraded");
  });

  test("a missing setting shows Not configured, and does not make the banner red", async () => {
    probes.email = async () => ({ state: "not-configured" });
    const r = await checkServices({ timeoutMs: 200, slowMs: 100 });
    expect(r.services.find((s) => s.key === "email")!.state).toBe("not-configured");
    expect(r.overall).toBe("operational");
  });

  test("the snapshot is cached for a minute so the page cannot hammer upstreams", async () => {
    const spy = vi.fn(async (): Promise<ProbeResult> => ({ state: "ok" }));
    probes.database = spy;
    await getStatusSnapshot();
    await getStatusSnapshot();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("R-1503: the rendered page", () => {
  test("shows Last checked in IST, the banner, and Down for a failed service", async () => {
    probes.database = async () => { throw new Error("boom"); };
    const { default: StatusPage } = await import("./page");
    const html = renderToStaticMarkup(await StatusPage());
    expect(html).toMatch(/Last checked/);
    expect(html).toMatch(/IST/);
    expect(html).toMatch(/Database/);
    expect(html).toMatch(/Down/);
    expect(html).not.toMatch(/\d{2}\.\d+%/);
  });

  test("keeps its metadata (title + description) so it stays indexable", async () => {
    const { metadata } = await import("./page");
    expect(metadata.title).toBe("System status");
    expect(typeof metadata.description).toBe("string");
    expect(String(metadata.description).length).toBeGreaterThan(20);
    expect(String(metadata.description)).not.toMatch(/ninety days|90/i);
  });
});
