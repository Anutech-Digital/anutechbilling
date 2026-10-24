/**
 * The site's enquiry route tells the form the truth (30 Sep 2026): a refused or unreachable
 * app handler is `ok: false` with a message, and `ackSent` says whether the customer's copy was
 * really emailed — the trial form and quote builder say "check your inbox" only then.
 *
 * R-1598 (18 Oct 2026): the request is handled IN THIS DEPLOYMENT — the public route's own
 * handler, called in-process — never fetched from the live domain by default. The handlers are
 * mocked here; `fetch` is stubbed only to prove it is NOT used.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const general = vi.fn();
const workspace = vi.fn();
vi.mock("@/app/api/public/enquiry/general/route", () => ({ POST: (r: NextRequest) => general(r) }));
vi.mock("@/app/api/public/enquiry/workspace/route", () => ({ POST: (r: NextRequest) => workspace(r) }));

import { POST } from "./route";
import { resetRateLimiter } from "@/lib/security/rate-limit";

const fetchMock = vi.fn();
beforeEach(() => {
  resetRateLimiter();
  general.mockReset(); workspace.mockReset(); fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("RESELLEROS_FORWARD_URL", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const body = { fullName: "Asha Co", companyName: "Asha Co", email: "asha@example.invalid", phone: "9876543210", requirement: "x" };
const STAGING = "https://resellersos-staging-test.example.invalid";
const req = (b: Record<string, unknown>, origin = "https://site.example.invalid", headers: Record<string, string> = {}) =>
  new NextRequest(`${origin}/api/enquiry`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(b) });
const upstream = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
/** Both handlers answer the same. */
const answer = (status: number, json: unknown) => {
  general.mockImplementation(async () => upstream(status, json));
  workspace.mockImplementation(async () => upstream(status, json));
};
/** Every request a handler received, with its parsed body. */
const received = async () => {
  const out: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  for (const [r] of [...general.mock.calls, ...workspace.mock.calls] as [NextRequest][]) {
    out.push({ url: r.url, headers: r.headers, body: (await r.clone().json()) as Record<string, unknown> });
  }
  return out;
};

describe("/api/enquiry — honest answers for the site forms", () => {
  it("passes on that the customer's copy WAS emailed (general path)", async () => {
    answer(200, { success: true, leadId: "L-1", ackSent: true });
    const res = await POST(req(body));
    expect(await res.json()).toMatchObject({ ok: true, ackSent: true });
  });

  it("and that it was NOT (general path)", async () => {
    answer(200, { success: true, leadId: "L-1", ackSent: false });
    expect(await (await POST(req(body))).json()).toMatchObject({ ok: true, ackSent: false });
  });

  it("the Workspace path passes it on too", async () => {
    answer(200, { success: true, draftQuoteId: "Q-1", autoSent: false, ackSent: true });
    const res = await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    expect(await res.json()).toMatchObject({ ok: true, ackSent: true });
    expect(workspace).toHaveBeenCalledTimes(1);
  });

  it("an app refusal is ok:false with a message — never a quiet success", async () => {
    answer(500, { error: "boom" });
    const res = await POST(req(body));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/could not record your request.*nothing was saved/i) });
  });

  it("a trial request tells the app it is a trial, on both paths (no owner alert there)", async () => {
    answer(200, { success: true, ackSent: true });
    await POST(req({ ...body, trial: true }));
    await POST(req({ ...body, trial: true, edition: "GW Business Starter", seats: 5 }));
    const got = await received();
    expect(got).toHaveLength(2);
    for (const r of got) expect(r.body).toMatchObject({ trial: true });
  });

  it("an ordinary enquiry is not marked a trial, so the owner is still alerted", async () => {
    answer(200, { success: true, ackSent: true });
    await POST(req(body));
    await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    for (const r of await received()) expect(r.body).not.toHaveProperty("trial");
  });

  it("a handler that throws is ok:false too", async () => {
    general.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(req(body));
    expect(await res.json()).toMatchObject({ ok: false });
  });
});

/* R-228: the site showed a reference made from a localStorage counter, so every new visitor's
   first quote was AQ-YYYYMM-001. The route now hands back the app's own number — the draft
   quote's number on the Workspace path, else the lead id — which sales can find in the app. */
describe("/api/enquiry — the reference number is the app's, not the browser's", () => {
  it("general path: the lead id", async () => {
    answer(200, { success: true, leadId: "L-MG3X9K", ackSent: true });
    expect(await (await POST(req(body))).json()).toMatchObject({ ok: true, leadId: "L-MG3X9K", reference: "L-MG3X9K" });
  });

  it("Workspace path: the draft quote's number", async () => {
    answer(200, { success: true, leadId: "L-MG3X9K", draftQuoteId: "QT-2026-0042", autoSent: false, ackSent: true });
    const res = await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    expect(await res.json()).toMatchObject({ ok: true, quoteId: "QT-2026-0042", reference: "QT-2026-0042" });
  });

  it("Workspace path with no draft quote: falls back to the lead id", async () => {
    answer(200, { success: true, leadId: "L-MG3X9K", draftQuoteId: null, ackSent: true });
    const res = await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    expect(await res.json()).toMatchObject({ ok: true, quoteId: null, reference: "L-MG3X9K" });
  });

  it("no id from the app: reference is null — never invented", async () => {
    answer(200, { success: true, ackSent: true });
    expect(await (await POST(req(body))).json()).toMatchObject({ ok: true, reference: null });
  });
});

/* R-1598: staging's /quote and /trial leads were landing in the LIVE app, and with no
   gclid/utm, because this route fetched the live domain with a payload it built itself. */
describe("/api/enquiry — R-1598: stays on this deployment, keeps the ad source", () => {
  it("a staging request is handled on staging — never sent to the live domain", async () => {
    answer(200, { success: true, leadId: "L-1", ackSent: true });
    await POST(req(body, STAGING));
    await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }, STAGING));
    expect(fetchMock).not.toHaveBeenCalled();
    const got = await received();
    expect(got).toHaveLength(2);
    for (const r of got) expect(new URL(r.url).origin).toBe(STAGING);
  });

  it("the live host is handled in-process too (no internet round trip to itself)", async () => {
    answer(200, { success: true, leadId: "L-1", ackSent: true });
    await POST(req(body, "https://reselleros.anutech.in"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(general).toHaveBeenCalledTimes(1);
  });

  it("pageUrl (with gclid/utm), pageReferrer, the Referer and the visitor's IP reach the app", async () => {
    answer(200, { success: true, leadId: "L-1", ackSent: true });
    const pageUrl = "https://anutech.in/quote?utm_source=google&utm_campaign=gw&gclid=abc123";
    const hdrs = { referer: "https://anutech.in/quote", "x-forwarded-for": "203.0.113.9", "x-turnstile-token": "tok" };
    await POST(req({ ...body, pageUrl, pageReferrer: "https://www.google.com/" }, STAGING, hdrs));
    await POST(req({ ...body, pageUrl, pageReferrer: "https://www.google.com/", edition: "GW Business Starter", seats: 5 }, STAGING, hdrs));
    const got = await received();
    expect(got).toHaveLength(2);
    for (const r of got) {
      expect(r.body).toMatchObject({ pageUrl, pageReferrer: "https://www.google.com/" });
      expect(r.headers.get("referer")).toBe("https://anutech.in/quote");
      expect(r.headers.get("x-forwarded-for")).toBe("203.0.113.9");
      expect(r.headers.get("x-turnstile-token")).toBe("tok");
    }
  });

  it("a misconfigured staging env pointing at live is REFUSED — handled on staging, logged", async () => {
    vi.stubEnv("RESELLEROS_FORWARD_URL", "https://reselleros.anutech.in");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    answer(200, { success: true, leadId: "L-1", ackSent: true });
    const res = await POST(req(body, STAGING));
    expect(await res.json()).toMatchObject({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(general).toHaveBeenCalledTimes(1);
    expect(err.mock.calls.flat().join(" ")).toMatch(/FORWARD REFUSED/);
    err.mockRestore();
  });

  it("an explicit non-production target IS forwarded, with pageUrl intact", async () => {
    vi.stubEnv("RESELLEROS_FORWARD_URL", "https://app.other.example.invalid");
    fetchMock.mockResolvedValue(upstream(200, { success: true, leadId: "L-9", ackSent: false }));
    await POST(req({ ...body, pageUrl: "https://x.example.invalid/quote?gclid=z" }, STAGING));
    expect(general).not.toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://app.other.example.invalid/api/public/enquiry/general");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ pageUrl: "https://x.example.invalid/quote?gclid=z" });
  });
});

describe("/api/enquiry — R-1549: every visitor has their own limit, never one shared bucket", () => {
  const from = (ip: string, b: Record<string, unknown> = body) =>
    req(b, "https://site.example.invalid", { "x-forwarded-for": ip });
  const asOther = (i: number) => ({ ...body, email: `visitor${i}@example.invalid` });

  it("one IP sending too many is stopped with a message that says what to do — another IP is not", async () => {
    answer(200, { success: true, leadId: "L-1", ackSent: true });
    for (let i = 0; i < 10; i++) expect((await POST(from("203.0.113.7", asOther(i)))).status).toBe(200);
    const blocked = await POST(from("203.0.113.7", asOther(99)));
    expect(blocked.status).toBe(429);
    const json = await blocked.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/nothing was saved/i);
    expect(json.error).toMatch(/wait about \d+ minute/i);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    // A different visitor is untouched by the first one's count.
    expect((await POST(from("198.51.100.4", asOther(100)))).status).toBe(200);
    expect(general).toHaveBeenCalledTimes(11);
  });

  it("the same email from many IPs is limited per email too", async () => {
    answer(200, { success: true, leadId: "L-1", ackSent: true });
    for (let i = 0; i < 5; i++) expect((await POST(from(`192.0.2.${i + 1}`))).status).toBe(200);
    expect((await POST(from("192.0.2.50"))).status).toBe(429);
    expect((await POST(from("192.0.2.51", { ...body, email: "someone-else@example.invalid" }))).status).toBe(200);
  });

  it("a failed bot check says nothing was saved and how to retry", async () => {
    answer(403, { error: "We could not verify this request." });
    const res = await POST(from("203.0.113.9"));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/nothing was saved.*reload the page/i);
  });
});
