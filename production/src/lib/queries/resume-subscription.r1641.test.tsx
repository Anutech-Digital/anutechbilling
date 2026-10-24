// @vitest-environment jsdom
/* R-1641 — "Resume" on a paused subscription (Payments → follow-up) had no onError: when the
   database refused, the button did nothing and said nothing, so the owner thought it had
   resumed. And an update that RLS filters to zero rows is not an error at all — it "worked"
   and changed nothing. Both must say: not resumed, still paused, and offer to try again. */
import * as React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const h = vi.hoisted(() => ({
  result: { data: [{ id: "S-1" }] as unknown, error: null as unknown },
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: h.success, error: h.error } }));

vi.mock("@/lib/supabase/client", () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, p) => {
      if (p === "then") { const r = Promise.resolve(h.result); return r.then.bind(r); }
      return () => chain;
    },
  });
  return { createClient: () => ({ from: () => chain }) };
});

import { useResumeSubscription } from "./payments";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => { h.success.mockReset(); h.error.mockReset(); });
afterEach(cleanup);

describe("R-1641 — Resume says when it did not resume", () => {
  it("database refuses → error toast with why + Try again, no success toast", async () => {
    h.result = { data: null, error: { message: "new row violates row-level security policy for table \"subscriptions\"" } };
    const { result } = renderHook(() => useResumeSubscription(), { wrapper });
    result.current.mutate("S-1");
    await waitFor(() => expect(h.error).toHaveBeenCalledTimes(1));
    const [title, opts] = h.error.mock.calls[0];
    expect(title).toBe("You don't have access to this.");
    expect(opts.description).toMatch(/still paused/i);
    expect(opts.action?.label).toBe("Try again");
    expect(h.success).not.toHaveBeenCalled();
  });

  it("update matched no row → treated as not resumed, not as success", async () => {
    h.result = { data: [], error: null };
    const { result } = renderHook(() => useResumeSubscription(), { wrapper });
    result.current.mutate("S-1");
    await waitFor(() => expect(h.error).toHaveBeenCalledTimes(1));
    expect(h.error.mock.calls[0][1].description).toMatch(/still paused/i);
    expect(h.success).not.toHaveBeenCalled();
  });

  it("Try again re-runs the resume for the same subscription", async () => {
    h.result = { data: null, error: { message: "Failed to fetch" } };
    const { result } = renderHook(() => useResumeSubscription(), { wrapper });
    result.current.mutate("S-1");
    await waitFor(() => expect(h.error).toHaveBeenCalledTimes(1));
    h.result = { data: [{ id: "S-1" }], error: null };
    h.error.mock.calls[0][1].action.onClick();
    await waitFor(() => expect(h.success).toHaveBeenCalledWith("Subscription resumed"));
  });

  it("works → success toast only", async () => {
    h.result = { data: [{ id: "S-1" }], error: null };
    const { result } = renderHook(() => useResumeSubscription(), { wrapper });
    result.current.mutate("S-1");
    await waitFor(() => expect(h.success).toHaveBeenCalledWith("Subscription resumed"));
    expect(h.error).not.toHaveBeenCalled();
  });
});
