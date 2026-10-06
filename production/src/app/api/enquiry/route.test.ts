/**
 * The site's enquiry proxy tells the form the truth (30 Sep 2026): a refused or unreachable
 * upstream is `ok: false` with a message, and `ackSent` says whether the customer's copy was
 * really emailed — the trial form and quote builder say "check your inbox" only then.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const fetchMock = vi.fn();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

const body = { fullName: "Asha Co", companyName: "Asha Co", email: "asha@example.invalid", phone: "9876543210", requirement: "x" };
const req = (b: Record<string, unknown>) =>
  new NextRequest("https://site.example.invalid/api/enquiry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const upstream = (status: number, json: unknown) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });

describe("/api/enquiry — honest answers for the site forms", () => {
  it("passes on that the customer's copy WAS emailed (general path)", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, leadId: "L-1", ackSent: true }));
    const res = await POST(req(body));
    expect(await res.json()).toMatchObject({ ok: true, ackSent: true });
  });

  it("and that it was NOT (general path)", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, leadId: "L-1", ackSent: false }));
    expect(await (await POST(req(body))).json()).toMatchObject({ ok: true, ackSent: false });
  });

  it("the Workspace path passes it on too", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, draftQuoteId: "Q-1", autoSent: false, ackSent: true }));
    const res = await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    expect(await res.json()).toMatchObject({ ok: true, ackSent: true });
  });

  it("an upstream refusal is ok:false with a message — never a quiet success", async () => {
    fetchMock.mockResolvedValue(upstream(500, { error: "boom" }));
    const res = await POST(req(body));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringMatching(/could not record your request.*nothing was saved/i) });
  });

  it("a trial request tells the app it is a trial, on both paths (no owner alert there)", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, ackSent: true }));
    await POST(req({ ...body, trial: true }));
    await POST(req({ ...body, trial: true, edition: "GW Business Starter", seats: 5 }));
    for (const call of fetchMock.mock.calls) expect(JSON.parse(call[1].body)).toMatchObject({ trial: true });
  });

  it("an ordinary enquiry is not marked a trial, so the owner is still alerted", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, ackSent: true }));
    await POST(req(body));
    await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    for (const call of fetchMock.mock.calls) expect(JSON.parse(call[1].body)).not.toHaveProperty("trial");
  });

  it("an unreachable upstream is ok:false too", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await POST(req(body));
    expect(await res.json()).toMatchObject({ ok: false });
  });
});

/* R-228: the site showed a reference made from a localStorage counter, so every new visitor's
   first quote was AQ-YYYYMM-001. The proxy now hands back the app's own number — the draft
   quote's number on the Workspace path, else the lead id — which sales can find in the app. */
describe("/api/enquiry — the reference number is the app's, not the browser's", () => {
  it("general path: the lead id", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, leadId: "L-MG3X9K", ackSent: true }));
    expect(await (await POST(req(body))).json()).toMatchObject({ ok: true, leadId: "L-MG3X9K", reference: "L-MG3X9K" });
  });

  it("Workspace path: the draft quote's number", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, leadId: "L-MG3X9K", draftQuoteId: "QT-2026-0042", autoSent: false, ackSent: true }));
    const res = await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    expect(await res.json()).toMatchObject({ ok: true, quoteId: "QT-2026-0042", reference: "QT-2026-0042" });
  });

  it("Workspace path with no draft quote: falls back to the lead id", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, leadId: "L-MG3X9K", draftQuoteId: null, ackSent: true }));
    const res = await POST(req({ ...body, edition: "GW Business Starter", seats: 5 }));
    expect(await res.json()).toMatchObject({ ok: true, quoteId: null, reference: "L-MG3X9K" });
  });

  it("no id from the app: reference is null — never invented", async () => {
    fetchMock.mockResolvedValue(upstream(200, { success: true, ackSent: true }));
    expect(await (await POST(req(body))).json()).toMatchObject({ ok: true, reference: null });
  });
});
