/**
 * R-2011 (DPDP): the form's notice + marketing opt-in → one consent_events row; the latest row
 * per lead decides who may get offers; unknown is never "yes".
 */
import { describe, it, expect, vi } from "vitest";
import { DATA_NOTICE_VERSION, formConsent, readFormConsent } from "./data-notice";
import { formConsentRow, marketingConsentEmails, marketingConsentLeadIds, recordFormConsent } from "./marketing-consent.server";

type Rows = Record<string, unknown[]>;
function fakeAdmin(rows: Rows, opts: { insertError?: string; readError?: string } = {}) {
  const inserts: Array<{ table: string; row: unknown }> = [];
  const filters: Array<{ table: string; col: string; vals: unknown }> = [];
  const admin = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) q[m] = () => q;
      q.in = (col: string, vals: unknown) => { filters.push({ table, col, vals }); return q; };
      q.insert = async (row: unknown) => { inserts.push({ table, row }); return { error: opts.insertError ? { message: opts.insertError } : null }; };
      q.then = (ok: (v: unknown) => unknown) =>
        Promise.resolve(opts.readError ? { data: null, error: { message: opts.readError } } : { data: rows[table] ?? [], error: null }).then(ok);
      return q;
    },
  };
  return { admin: admin as never, inserts, filters };
}
const headers = new Headers({ "user-agent": "UA-test", "x-forwarded-for": "203.0.113.9" });

describe("form consent payload (client → server)", () => {
  it("unticked box sends marketing:false with the notice version", () => {
    expect(formConsent("enquiry", false)).toEqual({ consent: { form: "enquiry", noticeVersion: DATA_NOTICE_VERSION, marketing: false } });
    expect(formConsent("trial", true).consent.marketing).toBe(true);
  });

  it("the server reads it leniently: unknown form / missing / malformed → null (nothing recorded)", () => {
    expect(readFormConsent({ consent: { form: "enquiry", noticeVersion: "2026-11-01", marketing: true } }))
      .toEqual({ form: "enquiry", noticeVersion: "2026-11-01", marketing: true });
    expect(readFormConsent({ consent: { form: "enquiry", noticeVersion: "2026-11-01", marketing: "yes" } })?.marketing).toBe(false);
    expect(readFormConsent({ consent: { form: "hacker", noticeVersion: "v", marketing: true } })).toBeNull();
    expect(readFormConsent({ fullName: "x" })).toBeNull();
    expect(readFormConsent(null)).toBeNull();
    expect(readFormConsent({ consent: { form: "enquiry", noticeVersion: "x".repeat(41), marketing: true } })).toBeNull();
  });
});

describe("recordFormConsent", () => {
  it("ticked → one 'granted' marketing row for the lead, source form, the form key, the page path, IP only hashed", async () => {
    const { admin, inserts } = fakeAdmin({});
    vi.stubEnv("SECRETS_MASTER_KEY", "test-only-key");
    const ok = await recordFormConsent(admin, {
      tenantId: "T1", leadId: "L-1", consent: { form: "trial", noticeVersion: "2026-11-01", marketing: true },
      headers, page: "https://anutech.in/trial?gclid=abc",
    });
    vi.unstubAllEnvs();
    expect(ok).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe("consent_events");
    expect(inserts[0].row).toMatchObject({
      tenant_id: "T1", lead_id: "L-1", purpose: "marketing", choice: "granted", notice_version: "2026-11-01",
      source: "form", form: "trial", page: "/trial", user_agent: "UA-test",
    });
    expect(String((inserts[0].row as { ip_hash: string }).ip_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(inserts[0].row)).not.toContain("203.0.113.9");
  });

  it("unticked → a 'denied' row (the notice was shown, no offers asked for)", async () => {
    const { admin, inserts } = fakeAdmin({});
    await recordFormConsent(admin, { tenantId: "T1", leadId: "L-2", consent: { form: "enquiry", noticeVersion: "2026-11-01", marketing: false }, headers });
    expect(inserts[0].row).toMatchObject({ choice: "denied", form: "enquiry", purpose: "marketing" });
  });

  it("no consent field (an old page) → nothing recorded; a DB error never throws", async () => {
    const a = fakeAdmin({});
    expect(await recordFormConsent(a.admin, { tenantId: "T1", leadId: "L-3", consent: null, headers })).toBe(false);
    expect(a.inserts).toHaveLength(0);
    const b = fakeAdmin({}, { insertError: "boom" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordFormConsent(b.admin, { tenantId: "T1", leadId: "L-3", consent: { form: "enquiry", noticeVersion: "v", marketing: true }, headers })).resolves.toBe(false);
    err.mockRestore();
  });

  it("row shape is pinned", () => {
    expect(formConsentRow({ tenantId: "T", leadId: "L", consent: { form: "callback", noticeVersion: "v", marketing: false }, ip: null, userAgent: null }))
      .toEqual({ tenant_id: "T", lead_id: "L", quote_id: null, anon_id: null, purpose: "marketing", choice: "denied", notice_version: "v", source: "form", form: "callback", page: null, ip_hash: null, user_agent: null });
  });
});

describe("marketingConsentLeadIds — who may get offers", () => {
  it("latest row per lead wins; no row = no consent", async () => {
    const { admin } = fakeAdmin({
      consent_events: [ // newest first, as the query orders it
        { lead_id: "L-B", choice: "denied", created_at: "2026-11-02" },
        { lead_id: "L-A", choice: "granted", created_at: "2026-11-01" },
        { lead_id: "L-B", choice: "granted", created_at: "2026-11-01" },
      ],
    });
    expect([...await marketingConsentLeadIds(admin, "T1", ["L-A", "L-B", "L-OLD"])]).toEqual(["L-A"]);
  });

  it("a failed read throws — never 'send to everyone'", async () => {
    const { admin } = fakeAdmin({}, { readError: "down" });
    await expect(marketingConsentLeadIds(admin, "T1", ["L-A"])).rejects.toThrow(/marketing consent/);
  });

  it("reads in chunks of 200 lead ids", async () => {
    const { admin, filters } = fakeAdmin({ consent_events: [] });
    await marketingConsentLeadIds(admin, "T1", Array.from({ length: 450 }, (_, i) => `L-${i}`));
    expect(filters.filter((f) => f.table === "consent_events").map((f) => (f.vals as unknown[]).length)).toEqual([200, 200, 50]);
  });

  it("emails: matched to this tenant's leads (any case), then to their consent", async () => {
    const { admin } = fakeAdmin({
      leads: [{ id: "L-A", contact_email: "Ravi@Example.invalid" }, { id: "L-B", contact_email: "old@example.invalid" }],
      consent_events: [{ lead_id: "L-A", choice: "granted", created_at: "2026-11-01" }],
    });
    expect([...await marketingConsentEmails(admin, "T1", ["ravi@example.invalid", "old@example.invalid", "stranger@example.invalid"])])
      .toEqual(["ravi@example.invalid"]);
  });
});
