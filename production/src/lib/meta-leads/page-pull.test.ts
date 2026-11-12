import { describe, expect, it } from "vitest";
import { pullPageLeads } from "./page-pull";

const G = "https://graph.facebook.com/v21.0";

function fakeMeta(routes: Record<string, { status?: number; body?: unknown }>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer PAGE_TOKEN");
    const key = Object.keys(routes).find((k) => u.startsWith(k));
    const r = key ? routes[key] : { status: 404 };
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("R-2521 pull Facebook lead-form leads from the connected Page", () => {
  const since = new Date("2026-11-01T00:00:00Z");

  it("reads every form and its leads; token in the header, never in the URL", async () => {
    const meta = fakeMeta({
      [`${G}/111/leadgen_forms`]: { body: { data: [{ id: "900" }, { id: "901" }] } },
      [`${G}/900/leads`]: { body: { data: [{ id: "5001", field_data: [{ name: "full_name", values: ["Ravi"] }] }], paging: { next: `${G}/900/leads?after=x` } } },
      [`${G}/901/leads`]: { body: { data: [{ id: "5002", form_id: "901", field_data: [] }] } },
    });
    const r = await pullPageLeads({ pageId: "111", pageToken: "PAGE_TOKEN", since, fetchImpl: meta.impl });
    expect(r.error).toBeNull();
    expect(r.forms).toBe(2);
    // page 2 of form 900 (same prefix) returns the same lead again in the fake — still parsed, dedupe is the importer's job
    expect(r.leads.map((l) => l.id)).toContain("5002");
    expect(r.leads.find((l) => l.id === "5001")?.form_id).toBe("900");
    expect(meta.calls.every((u) => !u.includes("PAGE_TOKEN"))).toBe(true);
    expect(meta.calls.some((u) => u.includes("time_created") && u.includes(String(since.getTime() / 1000)))).toBe(true);
  });

  it("a Page token without lead permission says reconnect, never 'zero leads'", async () => {
    const meta = fakeMeta({ [`${G}/111/leadgen_forms`]: { status: 403 } });
    const r = await pullPageLeads({ pageId: "111", pageToken: "PAGE_TOKEN", since, fetchImpl: meta.impl });
    expect(r.needsReconnect).toBe(true);
    expect(r.error).toMatch(/Connect the Page again/);
  });

  it("does not follow a next link to another host", async () => {
    const meta = fakeMeta({
      [`${G}/111/leadgen_forms`]: { body: { data: [{ id: "900" }], paging: { next: "https://evil.example/steal" } } },
      [`${G}/900/leads`]: { body: { data: [] } },
    });
    await pullPageLeads({ pageId: "111", pageToken: "PAGE_TOKEN", since, fetchImpl: meta.impl });
    expect(meta.calls.some((u) => u.includes("evil.example"))).toBe(false);
  });

  it("refuses a Page id that is not a number", async () => {
    const r = await pullPageLeads({ pageId: "../me", pageToken: "PAGE_TOKEN", since, fetchImpl: fakeMeta({}).impl });
    expect(r.error).toMatch(/not valid/);
  });
});
