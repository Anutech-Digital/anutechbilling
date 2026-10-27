/* R-1826 — the pure parts of scripts/ops/night-ist-check.mjs: the verdict, the night window,
   and the two refusals (live host, wrong tenant) that keep it from writing anywhere real. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
// @ts-expect-error — js-yaml ships no types (installed via eslint, already in the lockfile)
import yaml from "js-yaml";
// @ts-expect-error — plain .mjs ops script, no types
import { E2E_TENANT_ID, istDateOf, utcDateOf, inNightWindow, judge, refuseBase, refuseTenant, nightQuoteId, nightMarker, restFromRequest } from "../../scripts/ops/night-ist-check-lib.mjs";

const NIGHT = Date.parse("2026-10-20T19:00:00Z"); // 00:30 IST 21 Oct

describe("night IST check (R-1826)", () => {
  it("00:30 IST is the IST day, and the UTC day is yesterday", () => {
    expect(istDateOf(NIGHT)).toBe("2026-10-21");
    expect(utcDateOf(NIGHT)).toBe("2026-10-20");
    expect(inNightWindow(NIGHT)).toBe(true);
    expect(inNightWindow(Date.parse("2026-10-21T00:30:00Z"))).toBe(false); // 06:00 IST
  });

  it("verdict: the IST day passes, the UTC day fails", () => {
    expect(judge("2026-10-21", NIGHT, NIGHT + 2000)).toMatchObject({ ok: true, night: true });
    expect(judge("2026-10-20", NIGHT, NIGHT + 2000)).toMatchObject({ ok: false, got: "2026-10-20", expected: "2026-10-21" });
    expect(judge(null, NIGHT, NIGHT).ok).toBe(false);
  });

  it("a run that straddles IST midnight accepts either IST day", () => {
    const b = Date.parse("2026-10-20T18:29:59Z"), a = Date.parse("2026-10-20T18:30:01Z");
    expect(judge("2026-10-20", b, a).ok).toBe(true);
    expect(judge("2026-10-21", b, a).ok).toBe(true);
    expect(judge("2026-10-19", b, a).ok).toBe(false);
  });

  it("writes only on localhost or a staging host — never live", () => {
    expect(refuseBase("http://localhost:3001")).toBeNull();
    expect(refuseBase("http://127.0.0.1:3001")).toBeNull();
    expect(refuseBase("https://resellersos-staging-njvk4nxhdq-as.a.run.app")).toBeNull();
    expect(refuseBase("https://reselleros.anutech.in")).toMatch(/refused/);
    expect(refuseBase("https://resellersos-njvk4nxhdq-as.a.run.app")).toMatch(/refused/);
    expect(refuseBase("https://notstaging.example.com")).toMatch(/refused/);
    expect(refuseBase("ftp://localhost")).toMatch(/http/);
  });

  it("writes only in E2E Test Co", () => {
    expect(refuseTenant(E2E_TENANT_ID)).toBeNull();
    expect(refuseTenant("7c1f0000-0000-4000-8000-000000000001")).toMatch(/not E2E Test Co/);
    expect(refuseTenant(null)).toMatch(/could not read/);
  });

  it("the draft is marked and never takes a real quote number", () => {
    expect(nightQuoteId(NIGHT)).toBe("NIGHT-IST-20261020190000");
    expect(nightMarker(NIGHT)).toBe("NIGHT-IST-CHECK 2026-10-21 (2026-10-20T19:00:00.000Z)");
  });

  it("takes the data API address and token from the app's own request", () => {
    expect(restFromRequest("http://localhost:3001/api/sb/rest/v1/quotes?select=*", { authorization: "Bearer x", apikey: "k", cookie: "c" }))
      .toEqual({ base: "http://localhost:3001/api/sb/rest/v1/", headers: { authorization: "Bearer x", apikey: "k" } });
    expect(restFromRequest("http://localhost:3001/api/version", {})).toBeNull();
  });

  it("the workflow runs at 01:00 IST against staging with the SMOKE secrets", () => {
    const text = fs.readFileSync("../.github/workflows/night-ist-check.yml", "utf8");
    const wf = yaml.load(text) as { on: { schedule: { cron: string }[] }; jobs: Record<string, { steps: { run?: string }[] }> };
    expect(wf.on.schedule[0].cron).toBe("30 19 * * *");
    expect(text).toMatch(/secrets\.SMOKE_EMAIL/);
    expect(text).toMatch(/secrets\.SMOKE_PASSWORD/);
    const runs = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? "")).join("\n");
    expect(runs).toMatch(/night-ist-check\.mjs "\$STAGING_URL"/);
    expect(refuseBase("https://resellersos-staging-njvk4nxhdq-as.a.run.app")).toBeNull(); // the default it uses
  });

  it("the script refuses before writing: tenant guard, then insert, and no invoice/payment", () => {
    const src = fs.readFileSync("scripts/ops/night-ist-check.mjs", "utf8");
    expect(src.indexOf("refuseTenant(")).toBeGreaterThan(0);
    expect(src.indexOf("refuseTenant(")).toBeLessThan(src.indexOf(`"POST", "quotes`));
    expect(src).not.toMatch(/"(?:POST|PATCH)", "(?:invoices|payments|rpc\/)/);
    expect(src).not.toMatch(/console\.log\([^)]*password/i);
  });
});
