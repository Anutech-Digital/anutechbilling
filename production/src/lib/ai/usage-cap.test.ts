import { describe, it, expect, vi, beforeEach } from "vitest";

const rpc = vi.fn();
vi.mock("@/lib/supabase/bare", () => ({ createBareClient: () => ({ rpc }) }));

import { istMonthStart, aiCapMessage, aiUsageLine, reserveAiCall, recordAiTokens, aiUsageSummary } from "./usage-cap";

beforeEach(() => {
  rpc.mockReset();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key-for-tests";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("istMonthStart — the month turns at midnight India time, not UTC", () => {
  it("31 Oct 23:59 IST is still October", () => {
    expect(istMonthStart(new Date("2026-10-31T18:29:59Z"))).toBe("2026-10-01");
  });
  it("1 Nov 00:00 IST is November (still 31 Oct in UTC)", () => {
    expect(istMonthStart(new Date("2026-10-31T18:30:00Z"))).toBe("2026-11-01");
  });
  it("December → January rolls the year", () => {
    expect(istMonthStart(new Date("2026-12-31T18:30:00Z"))).toBe("2027-01-01");
  });
});

describe("aiCapMessage", () => {
  it("says used / cap and when it resets", () => {
    const m = aiCapMessage({ used: 2, cap: 2, month: "2026-10-01" });
    expect(m).toContain("2 of 2");
    expect(m).toContain("1 Nov");
    expect(m).toMatch(/limit/i);
  });
});

describe("aiUsageLine (Settings → Integrations → AI)", () => {
  it("short line used / cap; the reset day in the detail", () => {
    const u = aiUsageLine({ used: 12, cap: 1000, month: "2026-10-01" });
    expect(u.line).toBe("12 / 1,000 AI calls this month");
    expect(u.detail).toBe("Your company has used 12 of its 1,000 AI calls this month. The count starts again on 1 Nov.");
  });
  it("says when the limit is reached; December resets on 1 Jan", () => {
    const u = aiUsageLine({ used: 2, cap: 2, month: "2026-12-01" });
    expect(u.line).toBe("2 / 2 AI calls this month");
    expect(u.detail).toContain("starts again on 1 Jan. The limit is reached");
  });
});

describe("reserveAiCall", () => {
  it("asks the RPC with company, feature and enforce", async () => {
    rpc.mockResolvedValue({ data: { allowed: true, used: 1, cap: 1000, month: "2026-10-01" }, error: null });
    const r = await reserveAiCall("t1", "ai/test", true);
    expect(rpc).toHaveBeenCalledWith("ai_usage_reserve", { p_tenant_id: "t1", p_feature: "ai/test", p_enforce: true });
    expect(r).toEqual({ allowed: true, used: 1, cap: 1000, month: "2026-10-01" });
  });

  it("refused → allowed false with a message", async () => {
    rpc.mockResolvedValue({ data: { allowed: false, used: 2, cap: 2, month: "2026-10-01" }, error: null });
    const r = await reserveAiCall("t1", "ai/test", true);
    expect(r.allowed).toBe(false);
    expect(r.allowed === false && r.message).toContain("2 of 2");
  });

  it("a counter that cannot be reached does not stop AI (fails open, logged)", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const r = await reserveAiCall("t1", "ai/test", true);
    expect(r.allowed).toBe(true);
    expect(console.error).toHaveBeenCalled();
  });

  it("a thrown error also fails open", async () => {
    rpc.mockRejectedValue(new Error("network"));
    await expect(reserveAiCall("t1", "ai/test", true)).resolves.toMatchObject({ allowed: true });
  });
});

describe("recordAiTokens", () => {
  it("sends rounded token counts", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await recordAiTokens("t1", "ai/test", { inputTokens: 10.4, outputTokens: 3 });
    expect(rpc).toHaveBeenCalledWith("ai_usage_add_tokens", { p_tenant_id: "t1", p_feature: "ai/test", p_input: 10, p_output: 3 });
  });
  it("nothing to record → no call", async () => {
    await recordAiTokens("t1", "ai/test", { inputTokens: 0, outputTokens: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("never throws", async () => {
    rpc.mockRejectedValue(new Error("down"));
    await expect(recordAiTokens("t1", "x", { inputTokens: 1, outputTokens: 1 })).resolves.toBeUndefined();
  });
});

describe("aiUsageSummary", () => {
  it("maps the RPC row", async () => {
    rpc.mockResolvedValue({ data: { month: "2026-10-01", used: 12, cap: 1000, input_tokens: 5000, output_tokens: 900 }, error: null });
    await expect(aiUsageSummary("t1")).resolves.toEqual({ month: "2026-10-01", used: 12, cap: 1000, inputTokens: 5000, outputTokens: 900 });
  });
  it("null when it cannot be read", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "x" } });
    await expect(aiUsageSummary("t1")).resolves.toBeNull();
  });
});
