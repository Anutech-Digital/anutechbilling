/**
 * R-2112 / GP-02b — the vault PIN route under parallel guessing.
 *
 * The owner's real path for the attack: somebody at the owner's unlocked laptop opens two
 * tabs (or a script) and fires wrong PINs at /api/vault/personal/pin all at once. Before
 * GP-02b each request read failed_attempts, checked the PIN, then wrote failed+1 — so five
 * parallel wrong guesses all read 0 and all wrote 1, the lock never closed, and every guess
 * was checked. The fake DB below yields between calls exactly like a real round trip does,
 * and its RPCs behave like the SQL functions (one atomic UPDATE each) — that is the
 * difference under test.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { hashPin, newSalt } from "@/lib/vault/personal/pin";
import { MAX_ATTEMPTS, LOCKOUT_MINUTES } from "@/lib/vault/personal/pin-rules";

const USER = "11111111-2222-3333-4444-555555555555";
const TENANT = "99999999-2222-3333-4444-555555555555";
const GOOD = "2580";

interface PinRow {
  user_id: string;
  tenant_id: string;
  pin_hash: string;
  pin_salt: string;
  failed_attempts: number;
  locked_until: string | null;
}

let row: PinRow | null = null;
/** The signed-in user's role (GP-07a: owner and personal may use the vault lock). */
let role = "owner";
const tick = () => new Promise((r) => setTimeout(r, 1));

/** Table access — a read or write lands one round trip later, like PostgREST. */
function table(name: string) {
  if (name === "users") {
    return {
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { tenant_id: TENANT, role } }) }) }),
    };
  }
  if (name !== "personal_vault_pin") throw new Error(`unexpected table ${name}`);
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: async () => {
          const snap = row ? { ...row } : null;
          await tick();
          return { data: snap };
        },
      }),
    }),
    update: (patch: Partial<PinRow>) => ({
      eq: async () => {
        await tick();
        if (row) row = { ...row, ...patch };
        return { error: null };
      },
    }),
    upsert: async (r: PinRow) => {
      await tick();
      row = { ...r };
      return { error: null };
    },
    delete: () => ({
      eq: async () => {
        await tick();
        row = null;
        return { error: null };
      },
    }),
  };
}

/** The SQL functions of 20261030042132_gp02b_vault_pin_hardening.sql — each one atomic. */
async function rpc(fn: string, args: Record<string, unknown>) {
  await tick();
  const now = Date.now();
  if (fn === "vault_pin_begin_attempt") {
    if (!row) return { data: [{ status: "none", pin_hash: null, pin_salt: null, failed_attempts: 0, locked_until: null }], error: null };
    if (row.locked_until && new Date(row.locked_until).getTime() > now) {
      return { data: [{ status: "locked", pin_hash: null, pin_salt: null, failed_attempts: row.failed_attempts, locked_until: row.locked_until }], error: null };
    }
    const failed = row.failed_attempts + 1;
    row = {
      ...row,
      failed_attempts: failed,
      locked_until: failed >= MAX_ATTEMPTS ? new Date(now + LOCKOUT_MINUTES * 60_000).toISOString() : null,
    };
    return { data: [{ status: "ok", ...row }], error: null };
  }
  if (fn === "vault_pin_clear_attempts") {
    if (row) row = { ...row, failed_attempts: 0, locked_until: null };
    return { data: null, error: null };
  }
  if (fn === "vault_pin_save") {
    if (row && !args.p_replace) return { data: false, error: null };
    row = {
      user_id: args.p_user_id as string,
      tenant_id: args.p_tenant_id as string,
      pin_hash: args.p_hash as string,
      pin_salt: args.p_salt as string,
      failed_attempts: 0,
      locked_until: null,
    };
    return { data: true, error: null };
  }
  if (fn === "vault_pin_remove") {
    row = null;
    return { data: null, error: null };
  }
  throw new Error(`unexpected rpc ${fn}`);
}

const userClient = {
  auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
  from: table,
  rpc: async () => ({ data: null, error: { message: "browser role may not call the PIN functions", code: "42501" } }),
};
const adminClient = { from: table, rpc };

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => userClient,
  createAdminClient: () => adminClient,
  createAdminClientFor: () => adminClient,
}));

import { GET as routeGET, POST } from "./route";

/** The handlers always answer; the non-null keeps the assertions readable. */
async function GET(): Promise<Response> {
  return (await routeGET())!;
}

async function post(body: Record<string, unknown>): Promise<Response> {
  const res = await POST(
    new Request("http://localhost/api/vault/personal/pin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
  );
  return res!;
}

function setRow(failed = 0, lockedUntil: string | null = null) {
  const salt = newSalt();
  row = { user_id: USER, tenant_id: TENANT, pin_hash: hashPin(GOOD, salt), pin_salt: salt, failed_attempts: failed, locked_until: lockedUntil };
}

beforeEach(() => { role = "owner"; setRow(); });

describe("GP-07a (R-2115): who may use the vault lock", () => {
  it("a personal login may — it is that person's own money", async () => {
    role = "personal";
    expect((await GET()).status).toBe(200);
    expect((await post({ action: "verify", pin: GOOD })).status).toBe(200);
  });

  it.each(["manager", "sales", "billing", "accountant"])("%s is refused (403)", async (r) => {
    role = r;
    expect((await GET()).status).toBe(403);
    expect((await post({ action: "verify", pin: GOOD })).status).toBe(403);
  });
});

describe("GP-02b: wrong PINs in parallel cannot slip past the lock", () => {
  it("5 parallel wrong PIN posts leave failed_attempts=5 and the PIN locked", async () => {
    const res = await Promise.all(Array.from({ length: 5 }, () => post({ action: "verify", pin: "1357" })));
    expect(res.every((r) => r.status === 401 || r.status === 429)).toBe(true);
    expect(row?.failed_attempts).toBe(MAX_ATTEMPTS);
    expect(row?.locked_until).not.toBeNull();
    expect(new Date(row!.locked_until!).getTime()).toBeGreaterThan(Date.now());

    const status = await (await GET()).json();
    expect(status).toMatchObject({ configured: true, locked: true, attemptsLeft: 0 });
  });

  it("12 parallel wrong posts: only 5 guesses are ever checked, the rest are refused as locked", async () => {
    const res = await Promise.all(Array.from({ length: 12 }, () => post({ action: "verify", pin: "1357" })));
    const bodies = await Promise.all(res.map((r) => r.json()));
    const checked = bodies.filter((b) => typeof b.attemptsLeft === "number");
    expect(checked).toHaveLength(MAX_ATTEMPTS);
    expect(res.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(12 - MAX_ATTEMPTS);
    expect(row?.failed_attempts).toBe(MAX_ATTEMPTS);
  });

  it("while locked, even the correct PIN is refused and nothing is counted", async () => {
    setRow(5, new Date(Date.now() + 10 * 60_000).toISOString());
    const r = await post({ action: "verify", pin: GOOD });
    expect(r.status).toBe(429);
    expect(row?.failed_attempts).toBe(5);
  });

  it("a correct PIN after wrong ones unlocks and wipes the counter", async () => {
    await post({ action: "verify", pin: "1357" });
    await post({ action: "verify", pin: "1357" });
    expect(row?.failed_attempts).toBe(2);
    const r = await post({ action: "verify", pin: GOOD });
    expect(r.status).toBe(200);
    expect(row).toMatchObject({ failed_attempts: 0, locked_until: null });
  });

  it("a wrong guess says how many attempts are left", async () => {
    const r = await post({ action: "verify", pin: "1357" });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ attemptsLeft: MAX_ATTEMPTS - 1, locked: false });
  });

  it("changing the PIN with a wrong current PIN counts as an attempt; parallel tries lock it", async () => {
    await Promise.all(Array.from({ length: 5 }, () => post({ action: "set", pin: "8642", currentPin: "1357" })));
    expect(row?.failed_attempts).toBe(MAX_ATTEMPTS);
    expect(row?.locked_until).not.toBeNull();
    expect(hashPin(GOOD, row!.pin_salt)).toBe(row!.pin_hash); // PIN not replaced
  });

  it("change with the right current PIN replaces it and clears the counter", async () => {
    setRow(3);
    const r = await post({ action: "set", pin: "8642", currentPin: GOOD });
    expect(r.status).toBe(200);
    expect(hashPin("8642", row!.pin_salt)).toBe(row!.pin_hash);
    expect(row?.failed_attempts).toBe(0);
  });

  it("first-time set saves a PIN; remove with a wrong current PIN keeps it", async () => {
    row = null;
    expect((await post({ action: "set", pin: "8642" })).status).toBe(200);
    expect(row).not.toBeNull();
    expect((await post({ action: "remove", currentPin: "1357" })).status).toBe(401);
    expect(row).not.toBeNull();
    expect((await post({ action: "remove", currentPin: "8642" })).status).toBe(200);
    expect(row).toBeNull();
  });

  it("verify with no PIN set says so", async () => {
    row = null;
    const r = await post({ action: "verify", pin: GOOD });
    expect(r.status).toBe(400);
  });

  it("GET answers 500 (not 'no PIN') when the status read fails, so the gate stays locked", async () => {
    const spy = vi.spyOn(userClient, "from").mockImplementation(((name: string) =>
      name === "personal_vault_pin"
        ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }) }) }
        : table(name)) as never);
    const r = await GET();
    spy.mockRestore();
    expect(r.status).toBe(500);
    expect(await r.json()).not.toHaveProperty("configured");
  });

  it("the SQL function's 5 attempts / 15 minutes match pin-rules.ts", () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, "../../../../../../supabase/migrations/20261030042132_gp02b_vault_pin_hardening.sql"),
      "utf8",
    );
    expect(sql).toMatch(new RegExp(`v_max\\s+constant int := ${MAX_ATTEMPTS};`));
    expect(sql).toMatch(new RegExp(`v_lock constant interval := interval '${LOCKOUT_MINUTES} minutes';`));
  });

  it("the route never writes personal_vault_pin through the browser session", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "route.ts"), "utf8");
    expect(src).not.toMatch(/\.from\(\s*["']personal_vault_pin["']\s*\)\s*\.(update|upsert|insert|delete)\(/);
  });
});
