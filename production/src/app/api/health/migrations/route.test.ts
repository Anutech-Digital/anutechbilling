import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

/* R-1721 (21 Oct 2026): the staging DB step stopped after the backup, the train trusted
   "--db-done", and new code ran ~1 hour without 4 migrations. Now the app itself says whether
   every migration it was built with is on its DB. The DB is mocked here — what is pinned:
   fail-closed without the token, only {sha, ok, missing}, and which keys come back missing. */

const peeks = vi.hoisted(() => ({ read: vi.fn<() => Promise<boolean[]>>() }));
vi.mock("@/server/db/migration-peek", () => ({ readMigrationPeeks: peeks.read }));
vi.mock("@/server/migrations-health/peeks.generated", () => ({
  MIGRATION_PEEKS: [
    { key: "alpha", peek: "to_regclass('public.alpha') is not null" },
    { key: "beta", peek: "exists(select 1 from pg_proc where proname='beta')" },
    { key: "gamma", peek: "true" },
  ],
}));

import { GET } from "./route";

const ORIGINAL = { ...process.env };
const TOKEN = "t".repeat(43);
const req = (auth?: string) => new Request("http://x/api/health/migrations", auth ? { headers: { authorization: auth } } : undefined);

beforeEach(() => {
  peeks.read.mockReset();
  process.env.MIGRATIONS_HEALTH_TOKEN = TOKEN;
  process.env.BUILD_SHA = "ab12cd3";
});
afterEach(() => { process.env = { ...ORIGINAL }; });

describe("/api/health/migrations", () => {
  it("refuses when MIGRATIONS_HEALTH_TOKEN is not set — and never touches the DB", async () => {
    delete process.env.MIGRATIONS_HEALTH_TOKEN;
    const res = await GET(req(`Bearer ${TOKEN}`));
    expect(res.status).toBe(503);
    expect(Object.keys(await res.json())).toEqual(["error"]);
    expect(peeks.read).not.toHaveBeenCalled();
  });

  it("refuses with no token, a wrong token, or a token without Bearer's value", async () => {
    for (const auth of [undefined, "Bearer nope", "Bearer ", `Bearer ${TOKEN}x`]) {
      const res = await GET(req(auth));
      expect(res.status).toBe(401);
      expect(Object.keys(await res.json())).toEqual(["error"]);
    }
    expect(peeks.read).not.toHaveBeenCalled();
  });

  it("all peeks true → ok, nothing missing, only sha/ok/missing", async () => {
    peeks.read.mockResolvedValue([true, true, true]);
    const res = await GET(req(`Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(await res.json()).toEqual({ sha: "ab12cd3", ok: true, missing: [] });
  });

  it("names exactly the keys whose peek is false (or not a boolean true)", async () => {
    peeks.read.mockResolvedValue([true, false, null as unknown as boolean]);
    const json = await (await GET(req(`Bearer ${TOKEN}`))).json();
    expect(json).toEqual({ sha: "ab12cd3", ok: false, missing: ["beta", "gamma"] });
  });

  it("a DB that cannot answer → 503 with the same three fields, no error text", async () => {
    peeks.read.mockRejectedValue(new Error("password authentication failed for user app_service at 10.0.0.3"));
    const res = await GET(req(`Bearer ${TOKEN}`));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json).toEqual({ sha: "ab12cd3", ok: false, missing: [] });
    expect(JSON.stringify(json)).not.toMatch(/password|app_service|10\.0/);
  });

  it("no SQL or peek text ever reaches the response", async () => {
    peeks.read.mockResolvedValue([false, false, false]);
    const dump = JSON.stringify(await (await GET(req(`Bearer ${TOKEN}`))).json());
    expect(dump).not.toMatch(/select|pg_proc|to_regclass/i);
  });
});
