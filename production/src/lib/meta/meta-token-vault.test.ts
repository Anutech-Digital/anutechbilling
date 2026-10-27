/**
 * R-1884 — the Meta Ads long-lived token is stored SEALED in ad_accounts.access_token,
 * same envelope as tenant_secrets / Google refresh tokens (lib/crypto/vault.ts, "rosv1:").
 *
 * Proves: seal/open round-trip; the connect callback stores ciphertext only (and refuses
 * before exchanging the code when there is no master key); the spend sync sends Meta the
 * REAL token for a sealed row; a legacy plaintext row keeps working AND is sealed on that
 * sync's write (never lost); a sealed row with the key missing fails that account locally.
 * All tokens here are fakes; nothing calls Meta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { isEncrypted, VaultNotConfiguredError } from "@/lib/crypto/vault";
import { sealMetaToken, openMetaToken, resealMetaTokenIfPlain } from "./meta-token-vault";

const PLAIN = "EAAfake-meta-long-lived-token-for-tests-only-0000";

const h = vi.hoisted(() => {
  type Op = { table: string; op: string; payload?: Record<string, unknown> | Record<string, unknown>[]; filters: [string, unknown][] };
  const state = {
    ops: [] as Op[],
    accounts: [] as Record<string, unknown>[],
    exchanged: 0,
    spendCalls: [] as string[],
  };
  class Q {
    private o: Op;
    constructor(table: string) { this.o = { table, op: "select", filters: [] }; }
    select() { return this; }
    insert(p: Record<string, unknown>) { this.o.op = "insert"; this.o.payload = p; return this; }
    update(p: Record<string, unknown>) { this.o.op = "update"; this.o.payload = p; return this; }
    upsert(p: Record<string, unknown>) { this.o.op = "upsert"; this.o.payload = p; state.ops.push(this.o); return Promise.resolve({ error: null }); }
    delete() { this.o.op = "delete"; return this; }
    eq(c: string, v: unknown) { this.o.filters.push([c, v]); return this; }
    gte(c: string, v: unknown) { this.o.filters.push([c, v]); return this; }
    async single() { state.ops.push(this.o); return { data: { id: "RUN1" }, error: null }; }
    async maybeSingle() { return { data: this.o.table === "users" ? { tenant_id: "T1" } : null, error: null }; }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      state.ops.push(this.o);
      let out: unknown = { data: null, error: null, count: 0 };
      if (this.o.table === "ad_accounts" && this.o.op === "select") out = { data: state.accounts, error: null };
      return Promise.resolve(out).then(res, rej);
    }
  }
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "U1" } } }) },
    from: (t: string) => new Q(t),
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({ createClient: () => h.client, createAdminClient: () => h.client }));
vi.mock("@/lib/meta/meta-ads-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("./meta-ads-api")>();
  return {
    ...real,
    metaAppCreds: () => ({ appId: "app", appSecret: "fake-app-secret" }),
    exchangeMetaCode: async () => { h.state.exchanged++; return { accessToken: PLAIN, expiresAt: null }; },
    listMetaAdAccounts: async () => [{ id: "act_1", accountId: "1", name: "Main", currency: "INR", status: 1 }],
    fetchMetaCampaignSpend: async (token: string) => { h.state.spendCalls.push(token); return []; },
  };
});

const KEY = crypto.randomBytes(32).toString("base64");
let originalKey: string | undefined;
beforeEach(() => {
  originalKey = process.env.SECRETS_MASTER_KEY;
  process.env.SECRETS_MASTER_KEY = KEY;
  h.state.ops = [];
  h.state.accounts = [];
  h.state.exchanged = 0;
  h.state.spendCalls = [];
});
afterEach(() => {
  if (originalKey === undefined) delete process.env.SECRETS_MASTER_KEY; else process.env.SECRETS_MASTER_KEY = originalKey;
  vi.restoreAllMocks();
});

const metaRow = (token: string | null) => ({
  id: "ACC1", tenant_id: "T1", platform: "meta-ads", account_id: "act_1", name: "Main", enabled: true,
  access_token: token, token_expires_at: null, connected_user_id: "U1", login_customer_id: null,
});
const accountUpdates = () => h.state.ops.filter((o) => o.table === "ad_accounts" && o.op === "update").map((o) => o.payload as Record<string, unknown>);

describe("meta token vault helpers", () => {
  it("round-trips; the sealed value never contains the token", () => {
    const sealed = sealMetaToken(PLAIN);
    expect(isEncrypted(sealed)).toBe(true);
    expect(sealed).not.toContain(PLAIN);
    expect(openMetaToken(sealed)).toBe(PLAIN);
    expect(sealMetaToken(sealed)).toBe(sealed); // no double wrap
  });

  it("legacy plaintext reads unchanged; resealIfPlain upgrades it only", () => {
    expect(openMetaToken(PLAIN)).toBe(PLAIN);
    expect(openMetaToken(null)).toBeNull();
    const patch = resealMetaTokenIfPlain(PLAIN);
    expect(isEncrypted(patch.access_token ?? "")).toBe(true);
    expect(openMetaToken(patch.access_token)).toBe(PLAIN);
    expect(resealMetaTokenIfPlain(sealMetaToken(PLAIN))).toEqual({});
    expect(resealMetaTokenIfPlain(null)).toEqual({});
  });

  it("no master key: sealing refuses (never plaintext), reseal is a no-op, legacy still reads", () => {
    delete process.env.SECRETS_MASTER_KEY;
    expect(() => sealMetaToken(PLAIN)).toThrow(VaultNotConfiguredError);
    expect(resealMetaTokenIfPlain(PLAIN)).toEqual({});
    expect(openMetaToken(PLAIN)).toBe(PLAIN);
  });
});

function callbackReq() {
  return new NextRequest("http://localhost:3000/api/integrations/meta-ads/callback?code=C1&state=S1", {
    headers: { cookie: "meta_ads_oauth_state=S1" },
  });
}

describe("Meta connect callback", () => {
  it("stores the token SEALED ('rosv1:'), never the plain token", async () => {
    const { GET } = await import("@/app/api/integrations/meta-ads/callback/route");
    const res = await GET(callbackReq());
    expect(res.headers.get("location")).toContain("meta=connected");
    const ups = h.state.ops.filter((o) => o.table === "ad_accounts" && o.op === "upsert");
    expect(ups).toHaveLength(1);
    const stored = String((ups[0].payload as Record<string, unknown>).access_token);
    expect(stored.startsWith("rosv1:")).toBe(true);
    expect(JSON.stringify(h.state.ops)).not.toContain(PLAIN);
    expect(openMetaToken(stored)).toBe(PLAIN);
    expect(res.headers.get("location")).not.toContain(PLAIN);
  });

  it("no master key: refuses BEFORE exchanging the code, stores nothing", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("@/app/api/integrations/meta-ads/callback/route");
    const res = await GET(callbackReq());
    expect(res.headers.get("location")).toContain("meta=notconfigured");
    expect(h.state.exchanged).toBe(0);
    expect(h.state.ops.filter((o) => o.op === "upsert")).toEqual([]);
  });
});

describe("spend sync opens the token server-side", () => {
  it("sealed row: Meta gets the REAL token; row is not rewritten", async () => {
    h.state.accounts = [metaRow(sealMetaToken(PLAIN))];
    const { syncTenantAds } = await import("@/lib/marketing/ad-sync");
    const r = await syncTenantAds(h.client as never, "T1", "manual");
    expect(r.errors).toEqual([]);
    expect(h.state.spendCalls).toEqual([PLAIN]);
    expect(accountUpdates().some((u) => "access_token" in u)).toBe(false);
  });

  it("legacy plaintext row: still syncs, and that sync seals it (token not lost)", async () => {
    h.state.accounts = [metaRow(PLAIN)];
    const { syncTenantAds } = await import("@/lib/marketing/ad-sync");
    const r = await syncTenantAds(h.client as never, "T1", "cron");
    expect(r.errors).toEqual([]);
    expect(h.state.spendCalls).toEqual([PLAIN]);
    const sealedWrites = accountUpdates().filter((u) => "access_token" in u);
    expect(sealedWrites).toHaveLength(1);
    const stored = String(sealedWrites[0].access_token);
    expect(stored.startsWith("rosv1:")).toBe(true);
    expect(openMetaToken(stored)).toBe(PLAIN);
  });

  it("legacy row on a server WITHOUT the key: syncs, row left as it was (no plaintext rewrite, no loss)", async () => {
    delete process.env.SECRETS_MASTER_KEY;
    h.state.accounts = [metaRow(PLAIN)];
    const { syncTenantAds } = await import("@/lib/marketing/ad-sync");
    const r = await syncTenantAds(h.client as never, "T1", "cron");
    expect(r.errors).toEqual([]);
    expect(h.state.spendCalls).toEqual([PLAIN]);
    expect(accountUpdates().some((u) => "access_token" in u)).toBe(false);
  });

  it("sealed row, key missing: that account fails locally with the key named, Meta never called", async () => {
    h.state.accounts = [metaRow(sealMetaToken(PLAIN))];
    delete process.env.SECRETS_MASTER_KEY;
    const { syncTenantAds } = await import("@/lib/marketing/ad-sync");
    const r = await syncTenantAds(h.client as never, "T1", "cron");
    expect(h.state.spendCalls).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/SECRETS_MASTER_KEY/);
    expect(JSON.stringify(h.state.ops)).not.toContain(PLAIN);
  });
});
