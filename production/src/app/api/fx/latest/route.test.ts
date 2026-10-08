/* R-045 slice 3 — /api/fx/latest returns the rate WITH its source, kind, label and date.
   fetchInrRate is mocked: no network. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const fetchInrRate = vi.fn();
vi.mock("@/lib/fx/rate-source", () => ({ fetchInrRate: (...a: unknown[]) => fetchInrRate(...a) }));

import { GET } from "./route";

const req = (from: string) => new NextRequest(`http://localhost/api/fx/latest?from=${from}`);

beforeEach(() => fetchInrRate.mockReset());

describe("GET /api/fx/latest", () => {
  it("passes through source, kind, label and asOf", async () => {
    fetchInrRate.mockResolvedValue({ rate: 95.9832, from: "USD", to: "INR", asOf: "2026-09-30", source: "fbil", kind: "reference", label: "FBIL reference rate (RBI)" });
    const res = await GET(req("usd"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rate: 95.9832, source: "fbil", kind: "reference", asOf: "2026-09-30" });
    expect(fetchInrRate).toHaveBeenCalledWith("USD");
  });

  it("every source down → 502 asking for a manual rate (no number invented)", async () => {
    fetchInrRate.mockResolvedValue(null);
    const res = await GET(req("USD"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/manually/);
  });

  it("rejects a currency we do not bill in", async () => {
    const res = await GET(req("XYZ"));
    expect(res.status).toBe(400);
    expect(fetchInrRate).not.toHaveBeenCalled();
  });
});
