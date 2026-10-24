/** R-1104: Run now can reach every job's own cron route — no job is missing, none is wrong. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATION_JOBS } from "./jobs";

const SRC = readFileSync(join(process.cwd(), "src", "lib", "automation", "cron-handlers.server.ts"), "utf8");
const lines = new Map([...SRC.matchAll(/^\s*"([a-z0-9-]+)":\s*\(\) => import\("@\/app\/api\/cron\/([a-z0-9-]+)\/route"\)/gm)].map((m) => [m[1], m[2]]));

describe("CRON_ROUTES", () => {
  it("has one line per job, each importing that job's own route", () => {
    expect([...lines.keys()].sort()).toEqual(Object.keys(AUTOMATION_JOBS).sort());
    for (const [job, route] of lines) expect(route, job).toBe(job);
  });
});
