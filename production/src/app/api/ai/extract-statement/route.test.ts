/**
 * R-1690 — POST /api/ai/extract-statement, with Gemini mocked (never the real API).
 *
 * Staging, 19 Oct 2026: every one-month statement PDF failed with "Google's AI is busy or
 * slow right now" — and the logs said the opposite: both models TIMED OUT at 60 s, because
 * one call cannot write out a whole month of rows in time. So: the browser now asks for a
 * few pages per call (`pages`), and a timeout says "statement bada hai", not "busy".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readStatementInChunks, chunkResultFrom, type StatementRowLike } from "@/lib/banking/statement-chunks";

const ai = vi.hoisted(() => ({ json: vi.fn() }));

vi.mock("@/lib/supabase/server", () => {
  const users = { data: { tenant_id: "11111111-1111-4111-8111-111111111111", role: "owner" }, error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) chain[m] = () => chain;
  chain.maybeSingle = async () => users;
  return {
    createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) },
      from: () => chain,
    }),
  };
});

vi.mock("@/lib/ai/gemini", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai/gemini")>()),
  resolveGeminiConfig: async () => ({ apiKey: "test-key", model: "gemini-flash-latest" }),
  geminiJson: ai.json,
}));

import { POST } from "./route";

type GeminiArgs = { user: string; model: string; attachment?: { mimeType: string }; onFailure?: (r: string) => void };
const PDF = "JVBERi0xLjQK" + "A".repeat(40);

async function call(body: Record<string, unknown>) {
  const res = await POST(new NextRequest("http://localhost/api/ai/extract-statement", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: res.status, json: await res.json() };
}

/** Which pages the route asked the model for, read back from the prompt it sent. */
function askedPages(prompt: string): [number, number] | null {
  const m = /Read ONLY pages (\d+) to (\d+)/.exec(prompt);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const aiRow = (day: number) => ({
  date: `${String(day).padStart(2, "0")}/09/2026`,
  description: `NEFT/row-${day}`,
  debit: day % 2 ? 500 + day : 0,
  credit: day % 2 ? 0 : 900 + day,
  balance: 50_000 + day,
});

beforeEach(() => { ai.json.mockReset(); });

describe("chunked PDF — 12 pages read a few at a time", () => {
  it("each call asks for its own pages; merged rows come out in page order with border duplicates removed", async () => {
    ai.json.mockImplementation(async (a: GeminiArgs) => {
      const p = askedPages(a.user);
      if (!p) throw new Error("expected a page-range prompt");
      const rows = [];
      if (p[0] > 1) rows.push(aiRow(p[0] - 1));          // the model repeats the row before its range
      for (let d = p[0]; d <= p[1]; d++) rows.push(aiRow(d));
      return { rows };
    });

    const out = await readStatementInChunks({
      pageCount: 12, chunkPages: 2, concurrency: 3,
      readChunk: async (pages) => {
        const r = await call({ fileBase64: PDF, mimeType: "application/pdf", pages: { ...pages, total: 12 } });
        return chunkResultFrom<StatementRowLike>(r.status === 200, r.json);
      },
    });

    expect(ai.json).toHaveBeenCalledTimes(6);
    const prompts = ai.json.mock.calls.map((c) => askedPages((c[0] as GeminiArgs).user));
    expect(prompts).toEqual(expect.arrayContaining([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12]]));
    expect(ai.json.mock.calls.every((c) => /This PDF has 12 pages/.test((c[0] as GeminiArgs).user))).toBe(true);
    expect(out.rows.map((r) => r.txn_date)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    expect(out.borderDuplicates).toBe(5);
    expect(out.warnings).toEqual([]);
  });

  it("a chunk that times out on both models: the others' rows come back, the warning names its pages", async () => {
    ai.json.mockImplementation(async (a: GeminiArgs) => {
      const p = askedPages(a.user)!;
      if (p[0] === 7) {
        a.onFailure?.("Gemini timed out after 60 seconds, even after a retry. Please try again in a little while.");
        return null;
      }
      return { rows: [aiRow(p[0]), aiRow(p[1])] };
    });
    const out = await readStatementInChunks({
      pageCount: 12, chunkPages: 2, concurrency: 3,
      readChunk: async (pages) => {
        const r = await call({ fileBase64: PDF, mimeType: "application/pdf", pages: { ...pages, total: 12 } });
        return chunkResultFrom<StatementRowLike>(r.status === 200, r.json);
      },
    });
    expect(out.rows).toHaveLength(10);
    expect(out.failed.map((f) => [f.from, f.to])).toEqual([[7, 8]]);
    expect(out.warnings[0]).toMatch(/Page 7–8/);
    expect(out.warnings[0]).not.toMatch(/busy/i);
    // The slow chunk was tried on the lighter model too before giving up.
    const models = ai.json.mock.calls.filter((c) => askedPages((c[0] as GeminiArgs).user)?.[0] === 7).map((c) => (c[0] as GeminiArgs).model);
    expect(models).toEqual(["gemini-flash-latest", "gemini-flash-lite-latest"]);
  });

  it("a chunk's dates are NOT fixed on the server — the browser fixes them over the whole statement", async () => {
    ai.json.mockResolvedValue({ rows: [{ date: "2026-21-08", description: "x", debit: 5, credit: 0, balance: null }] });
    const r = await call({ fileBase64: PDF, mimeType: "application/pdf", pages: { from: 3, to: 4, total: 12 } });
    expect(r.status).toBe(200);
    expect(r.json.rows[0].txn_date).toBe("2026-21-08");
    expect(r.json.chunk).toEqual({ from: 3, to: 4, total: 12 });
  });

  it("refuses a page range that makes no sense", async () => {
    const r = await call({ fileBase64: PDF, mimeType: "application/pdf", pages: { from: 5, to: 3, total: 12 } });
    expect(r.status).toBe(400);
    expect(ai.json).not.toHaveBeenCalled();
  });
});

describe("R-1693 — every line, and the model's own count of them", () => {
  it("the prompt asks for EVERY line (no summarising / skipping) and a rowCount per page", async () => {
    ai.json.mockResolvedValue({ rows: [aiRow(3)] });
    await call({ fileBase64: PDF, mimeType: "application/pdf", pages: { from: 3, to: 4, total: 12 } });
    const prompt = (ai.json.mock.calls[0][0] as GeminiArgs).user;
    expect(prompt).toMatch(/EVERY transaction line/);
    expect(prompt).toMatch(/never summarise|do not summarise/i);
    expect(prompt).toMatch(/rowCount/);
  });

  it("returns the model's page counts (summed over the asked pages) and how many rows it wrote", async () => {
    ai.json.mockResolvedValue({
      pages: [{ page: 3, rowCount: 2 }, { page: 4, rowCount: 1 }, { page: 9, rowCount: 7 }],   // page 9 is outside the range
      rows: [aiRow(3), aiRow(4)],
    });
    const r = await call({ fileBase64: PDF, mimeType: "application/pdf", pages: { from: 3, to: 4, total: 12 } });
    expect(r.json.rowCount).toBe(3);
    expect(r.json.rowsReturned).toBe(2);
    const back = chunkResultFrom<StatementRowLike>(true, r.json);
    expect(back).toMatchObject({ ok: true, rowCount: 3, returned: 2 });
  });

  it("no page counts from the model → rowCount null (no check claimed)", async () => {
    ai.json.mockResolvedValue({ rows: [aiRow(3)] });
    const r = await call({ fileBase64: PDF, mimeType: "application/pdf", pages: { from: 3, to: 4, total: 12 } });
    expect(r.json.rowCount).toBeNull();
  });

  it("a failure carries its kind so the browser can stop re-reading when Gemini is paused", async () => {
    ai.json.mockImplementation(async (a: GeminiArgs) => {
      a.onFailure?.("Gemini failed repeatedly just now, so calls are paused for a minute. It retries on its own.");
      return null;
    });
    const r = await call({ fileBase64: PDF, mimeType: "application/pdf", pages: { from: 3, to: 3, total: 12 } });
    expect(chunkResultFrom<StatementRowLike>(false, r.json)).toMatchObject({ ok: false, kind: "paused" });
  });
});

describe("honest failure messages", () => {
  it("a timeout says the statement is big and offers CSV / Excel — never 'busy'", async () => {
    ai.json.mockImplementation(async (a: GeminiArgs) => {
      a.onFailure?.("Gemini timed out after 60 seconds, even after a retry. Please try again in a little while.");
      return null;
    });
    const r = await call({ fileBase64: PDF, mimeType: "application/pdf" });
    expect(r.status).toBe(504);
    expect(r.json.kind).toBe("timeout");
    expect(r.json.error).toMatch(/statement is too big/);
    expect(r.json.error).toMatch(/CSV\/Excel/);
    expect(r.json.error).not.toMatch(/busy/i);
  });

  it("a 503 / overload is 'busy'", async () => {
    ai.json.mockImplementation(async (a: GeminiArgs) => {
      a.onFailure?.("Gemini is temporarily unavailable — The model is overloaded. Please try again later. Nothing is misconfigured; it clears on its own.");
      return null;
    });
    const r = await call({ fileBase64: PDF, mimeType: "application/pdf" });
    expect(r.status).toBe(503);
    expect(r.json.kind).toBe("busy");
    expect(r.json.error).toMatch(/busy/i);
    expect(ai.json).toHaveBeenCalledTimes(2);    // the lighter model was asked once
  });

  it("a 400 still says the file could not be opened, and does not try another model", async () => {
    ai.json.mockImplementation(async (a: GeminiArgs) => {
      a.onFailure?.("Gemini rejected the request — Request contains an invalid argument.. Usually the API key is wrong.");
      return null;
    });
    const r = await call({ fileBase64: PDF, mimeType: "application/pdf" });
    expect(r.status).toBe(502);
    expect(r.json.error).toMatch(/couldn't open this file/);
    expect(ai.json).toHaveBeenCalledTimes(1);
  });
});

describe("image path unchanged", () => {
  it("a photo is one call with the plain prompt; dates fixed on the server as before", async () => {
    ai.json.mockResolvedValue({ rows: [aiRow(3), aiRow(4)] });
    const r = await call({ fileBase64: PDF, mimeType: "image/jpeg" });
    expect(r.status).toBe(200);
    expect(ai.json).toHaveBeenCalledTimes(1);
    const a = ai.json.mock.calls[0][0] as GeminiArgs;
    expect(askedPages(a.user)).toBeNull();
    expect(a.attachment?.mimeType).toBe("image/jpeg");
    expect(r.json.rows.map((x: { txn_date: string }) => x.txn_date)).toEqual(["2026-09-03", "2026-09-04"]);
    expect(r.json.mode).toBe("gemini");
    expect(r.json.chunk).toBeUndefined();
  });

  it("pages are ignored for an image — one call, whole picture", async () => {
    ai.json.mockResolvedValue({ rows: [aiRow(3)] });
    await call({ fileBase64: PDF, mimeType: "image/png", pages: { from: 1, to: 2, total: 4 } });
    expect(askedPages((ai.json.mock.calls[0][0] as GeminiArgs).user)).toBeNull();
  });
});
