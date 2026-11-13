// @vitest-environment jsdom
/**
 * R-2661 — the "Zoho calls today: N of 900" line on the Zoho read dialogs: shows the company's count
 * once the route answers, says when Zoho itself refused for the day, shows nothing on a failed or
 * odd answer (never a wrong number), reads again when refreshKey changes. fetch is mocked.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { DAY_CALLS_URL, dayCallsText, limitHitLabel, ZohoDayCallsLine } from "./zoho-day-calls-line";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("R-2661 ZohoDayCallsLine", () => {
  it("shows the count once known, from the day-calls route", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, day: "2026-11-13", calls: 612, budget: 900, limitHitAt: null, spent: false, retryAt: 1 })));
    vi.stubGlobal("fetch", f);
    render(<ZohoDayCallsLine />);
    await waitFor(() => expect(screen.getByTestId("zoho-day-calls").textContent).toBe("Zoho calls today: 612 of 900"));
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toBe(DAY_CALLS_URL);
  });

  it("Zoho's own refusal is said with its IST time; a failed or odd answer shows nothing", async () => {
    expect(limitHitLabel("2026-11-13T04:24:00Z")).toBe("Zoho refused (daily limit) at 9:54 am IST");
    expect(limitHitLabel("garbage")).toBe("Zoho refused (daily limit) today");
    expect(dayCallsText({ calls: 12, budget: 900, limitHitAt: "2026-11-13T04:24:00Z" })).toBe("Zoho calls today: 12 of 900 · Zoho refused (daily limit) at 9:54 am IST");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, listed: 3 }))));
    render(<ZohoDayCallsLine />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("zoho-day-calls")).toBeNull();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<ZohoDayCallsLine />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("zoho-day-calls")).toBeNull();
  });

  it("reads again when refreshKey changes (a read finished)", async () => {
    let calls = 1;
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, day: "2026-11-13", calls: calls++, budget: 900, limitHitAt: null, spent: false, retryAt: 1 })));
    vi.stubGlobal("fetch", f);
    const { rerender } = render(<ZohoDayCallsLine refreshKey={0} />);
    await waitFor(() => expect(screen.getByTestId("zoho-day-calls").textContent).toContain("1 of 900"));
    rerender(<ZohoDayCallsLine refreshKey={1} />);
    await waitFor(() => expect(screen.getByTestId("zoho-day-calls").textContent).toContain("2 of 900"));
    expect(f).toHaveBeenCalledTimes(2);
  });
});
