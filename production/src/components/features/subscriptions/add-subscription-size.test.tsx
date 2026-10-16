// @vitest-environment jsdom
//
// R-1448: the "1-Click Onboard Subscription" dialog opens big enough on a desktop.
//
// ─── WHY THIS TEST EXISTS ───────────────────────────────────────────────────
// Abhishek, staging AI Help, 12 Oct 2026 (/subscriptions): the onboard modal opened
// small, cut off the bottom fields and needed scrolling. The dialog asked for
// `sm:max-w-[640px]`, but the shared DialogContent sets `md:!max-w-xl` with `!`, so
// the 640px never applied — the multi-field form was squeezed into 576px, and the
// box was only as tall as its content allowed.
//
// The fix uses the shared Tailwind width scale (md:!max-w-4xl, used by other large
// forms), fills the width up to that cap, and gives the box a 90vh height on desktop
// so the form scrolls inside it only when it must. Mobile stays the bottom sheet.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddSubscriptionDialog } from "./add-subscription-dialog";

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role: "owner" } }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [], isLoading: false }) }));

function chainOf(rows: unknown[]) {
  const settled = Promise.resolve({ data: rows, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, or: () => chain, ilike: () => chain,
    order: () => chain, limit: () => chain,
    then: (...a: unknown[]) => (settled.then as (...x: unknown[]) => unknown)(...a),
  };
  return chain;
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: null, error: null }),
    from: () => chainOf([]),
  }),
}));

afterEach(cleanup);

function dialogClasses(): string[] {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>,
  );
  const el = document.querySelector('[role="dialog"]');
  expect(el).not.toBeNull();
  return (el?.getAttribute("class") ?? "").split(/\s+/);
}

describe("R-1448: onboard dialog default size", () => {
  it("is wide on desktop — the shared 576px cap is replaced, not fought with a dead sm: class", () => {
    const cls = dialogClasses();
    expect(cls).toContain("md:!max-w-4xl");
    expect(cls).toContain("md:!w-full");
    expect(cls).not.toContain("md:!max-w-xl");
    expect(cls).not.toContain("md:!w-auto");
    expect(cls).not.toContain("sm:max-w-[640px]");
  });

  it("is tall on desktop (90vh), with the form scrolling inside only when needed", () => {
    const cls = dialogClasses();
    expect(cls).toContain("md:!h-[90vh]");
    expect(cls).toContain("max-h-[90vh]");
    const form = document.querySelector('[role="dialog"] form');
    expect(form?.className).toMatch(/\boverflow-y-auto\b/);
    expect(form?.className).toMatch(/\bflex-1\b/);
  });

  it("stays a bottom sheet on a phone", () => {
    const cls = dialogClasses();
    expect(cls).toContain("bottom-0");
    expect(cls).toContain("rounded-t-2xl");
    expect(cls).toContain("w-full");
  });
});
