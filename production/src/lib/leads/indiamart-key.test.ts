/**
 * S34 — the IndiaMART key screen's rules: how much of the key may be shown, what the status
 * card says, and that the two actionable failures are recognised from the CRON'S OWN words
 * (produced here by running the real runner against a fake DB), not from a copy of them.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { crmKeySchema, keyLast4, istDateTime, pullSummary, saveKeyFailure, PULL_SCHEDULE_TEXT, KEY_SOURCE_TEXT, PLAINTEXT_KEY_NOTE } from "./indiamart-key";

vi.mock("@/lib/supabase/server", () => ({ createAdminClient: () => { throw new Error("no DB in unit tests"); } }));
import { runIndiamartPull } from "./indiamart.server";

const KEY = "SYNTHETIC-KEY-0123456789-wxyz";

describe("keyLast4 — never more than four characters, and only of a real-length key", () => {
  it("returns the last four of a key of 16+ characters", () => {
    expect(keyLast4(KEY)).toBe("wxyz");
    expect(keyLast4(`  ${KEY}  `)).toBe("wxyz");
  });
  it("shows nothing for a value too short for four characters to be a small part of it", () => {
    expect(keyLast4("abc123")).toBeNull();
    expect(keyLast4("0123456789abcde")).toBeNull(); // 15
  });
  it("shows nothing when there is no key", () => {
    expect(keyLast4(null)).toBeNull();
    expect(keyLast4(undefined)).toBeNull();
    expect(keyLast4("   ")).toBeNull();
  });
});

describe("crmKeySchema — the one rule the page and the API both apply", () => {
  it("trims and accepts a plausible key", () => {
    expect(crmKeySchema.parse({ crm_key: `  ${KEY}\n` })).toEqual({ crm_key: KEY });
  });
  it("refuses a short or oversized paste with a next step", () => {
    const short = crmKeySchema.safeParse({ crm_key: "abc" });
    expect(short.success).toBe(false);
    expect(short.error!.issues[0].message).toMatch(/copy the full key from Lead Manager/);
    const long = crmKeySchema.safeParse({ crm_key: "x".repeat(201) });
    expect(long.success).toBe(false);
    expect(long.error!.issues[0].message).toMatch(/paste only the CRM key/);
  });
});

describe("istDateTime — IST whatever the machine's zone", () => {
  it("formats the afternoon and the midnight hour", () => {
    expect(istDateTime("2026-09-29T08:45:00Z")).toBe("29 Sep 2026, 2:15 pm");
    expect(istDateTime("2026-09-28T18:35:00Z")).toBe("29 Sep 2026, 12:05 am");
    expect(istDateTime("2026-09-29T06:30:00Z")).toBe("29 Sep 2026, 12:00 pm");
  });
  it("does not print Invalid Date", () => {
    expect(istDateTime("not a date")).toBe("—");
  });
});

describe("pullSummary", () => {
  const base = { configured: true, last_run_at: "2026-09-29T08:45:00Z", last_ok: true, last_error: null, last_imported: 0 };

  it("no key: says leads are NOT coming, and what to do", () => {
    const s = pullSummary({ ...base, configured: false });
    expect(s.tone).toBe("neutral");
    expect(s.title).toMatch(/Not connected/);
    expect(s.detail).toContain(PULL_SCHEDULE_TEXT);
  });

  it("no key but an old run on record: still 'not saved' — a removed key must not read as working", () => {
    expect(pullSummary({ ...base, configured: false, last_ok: true }).tone).toBe("neutral");
  });

  it("key saved, never pulled: says the first pull is pending and how far back it reaches", () => {
    const s = pullSummary({ ...base, last_run_at: null, last_ok: null });
    expect(s.title).toMatch(/Waiting for first pull/);
    expect(s.detail).toMatch(/24 hours/);
  });

  it("working: names the time and the count, singular and plural", () => {
    expect(pullSummary(base)).toMatchObject({ tone: "success", title: "Active — last pull 29 Sep 2026, 2:15 pm" });
    expect(pullSummary(base).detail).toMatch(/No new enquiries/);
    expect(pullSummary({ ...base, last_imported: 1 }).detail).toBe("1 new lead.");
    expect(pullSummary({ ...base, last_imported: 3 }).detail).toBe("3 new leads.");
  });

  it("an unknown failure shows the recorded reason and still gives a next step", () => {
    const s = pullSummary({ ...base, last_ok: false, last_error: "IndiaMART error: server busy" });
    expect(s.tone).toBe("danger");
    expect(s.detail).toMatch(/^IndiaMART error: server busy/);
    expect(s.detail).toMatch(/save the key again/);
  });

  /* The two failures the owner can act on, from the text the real cron writes. */
  function fakeDb() {
    const upserts: Record<string, unknown>[] = [];
    const from = () => {
      const b = {
        select: () => b,
        not: () => Promise.resolve({ data: [{ tenant_id: "t1", indiamart_crm_key: KEY }], error: null }),
        eq: () => b,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        upsert: (row: Record<string, unknown>) => { upserts.push(row); return Promise.resolve({ error: null }); },
      };
      return b;
    };
    return { admin: { from, rpc: vi.fn() } as never, upserts };
  }
  const reply = (body: unknown) => vi.fn(async () => ({ status: 200, json: async () => body }) as unknown as Response);
  const now = new Date("2026-09-29T08:45:00Z");

  it("recognises the cron's rate-limit record as 'wait', not as a broken key", async () => {
    const db = fakeDb();
    await runIndiamartPull({ admin: db.admin, now, fetchImpl: reply({ CODE: 429, MESSAGE: "hit this API once in every 5 minutes" }) });
    const st = db.upserts.at(-1)!;
    const s = pullSummary({ configured: true, last_run_at: st.last_run_at as string, last_ok: st.last_ok as boolean, last_error: st.last_error as string, last_imported: 0 });
    expect(s.tone).toBe("warning");
    expect(s.detail).toMatch(/No action needed/);
  });

  it("recognises the cron's rejected-key record and sends the owner to get a new key", async () => {
    const db = fakeDb();
    await runIndiamartPull({ admin: db.admin, now, fetchImpl: reply({ CODE: 401, MESSAGE: "Invalid Key" }) });
    const st = db.upserts.at(-1)!;
    expect(String(st.last_error)).toContain("/marketing/indiamart");
    const s = pullSummary({ configured: true, last_run_at: st.last_run_at as string, last_ok: st.last_ok as boolean, last_error: st.last_error as string, last_imported: 0 });
    expect(s.tone).toBe("danger");
    expect(s.title).toMatch(/Key rejected/);
    expect(s.detail).toContain(KEY_SOURCE_TEXT);
    // …and the record the screen shows never carries the key itself.
    expect(JSON.stringify(db.upserts)).not.toContain(KEY);
  });
});

/* R-399: since R-051 the vault refuses to save without SECRETS_MASTER_KEY (503 + next step),
   so "saved, not encrypted" can never be the result of a save — the screen must say the
   key was NOT saved, and show the vault's own next step. */
describe("saving the key: sealed or refused, never 'saved, not encrypted' (R-399)", () => {
  it("a 503 is the vault refusing: shows its message, says NOT saved, never 'paste it again'", async () => {
    const { VAULT_NOT_CONFIGURED_MESSAGE } = await import("@/lib/crypto/vault");
    const f = saveKeyFailure(503, VAULT_NOT_CONFIGURED_MESSAGE);
    expect(f.vaultMissing).toBe(true);
    expect(f.title).toMatch(/not saved/i);
    expect(f.description).toBe(VAULT_NOT_CONFIGURED_MESSAGE);
    expect(f.description).not.toMatch(/paste it again/i);
  });

  it("any other failure keeps the retry advice", () => {
    const f = saveKeyFailure(500, "Server error");
    expect(f.vaultMissing).toBe(false);
    expect(f.description).toMatch(/paste it again/i);
  });

  it("an old plaintext key is explained as saved before encryption, not as a missing server key", () => {
    expect(PLAINTEXT_KEY_NOTE).toMatch(/before encryption/);
    expect(PLAINTEXT_KEY_NOTE).not.toMatch(/SECRETS_MASTER_KEY is not set/);
  });

  it("the screen and its hooks no longer carry the impossible 'saved, not encrypted' branch", () => {
    const root = join(__dirname, "..", "..");
    const queries = readFileSync(join(__dirname, "indiamart-key-queries.ts"), "utf8");
    const page = readFileSync(join(root, "app", "(app)", "marketing", "indiamart", "page.tsx"), "utf8");
    expect(queries).not.toMatch(/saved, not encrypted/i);
    expect(queries).not.toMatch(/toast\.warning/);
    expect(queries).toMatch(/saveKeyFailure\(/);
    expect(page).not.toMatch(/SECRETS_MASTER_KEY is not set on the server, so the key is stored/);
    expect(page).toMatch(/PLAINTEXT_KEY_NOTE/);
    expect(page).toMatch(/vaultMissing\?\.vaultMissing/);
  });
});
