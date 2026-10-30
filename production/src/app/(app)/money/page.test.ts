/**
 * R-2115 checker FAIL (30 Oct 2026): a personal login typing /invoices went to
 * /money?denied=%2Finvoices, but /money redirected to a bare /vault/personal — the ?denied
 * param was dropped, so the "You don't have access" toast never showed. /money must forward
 * its query to /vault/personal.
 */
import { describe, it, expect, vi } from "vitest";

const redirect = vi.hoisted(() => vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }));
vi.mock("next/navigation", () => ({ redirect }));

import MoneyPage from "./page";

const target = async (searchParams: Record<string, string | string[] | undefined>) => {
  try {
    await MoneyPage({ searchParams: Promise.resolve(searchParams) });
  } catch (e) {
    const m = /^REDIRECT (.*)$/.exec((e as Error).message);
    if (m) return m[1];
    throw e;
  }
  throw new Error("no redirect");
};

describe("/money forwards to /vault/personal (GP-07a)", () => {
  it("keeps ?denied so the access toast shows", async () => {
    expect(await target({ denied: "/invoices" })).toBe("/vault/personal?denied=%2Finvoices");
  });

  it("plain /money goes to plain /vault/personal", async () => {
    expect(await target({})).toBe("/vault/personal");
  });

  it("keeps every query param (repeated ones too), dropping empty ones", async () => {
    expect(await target({ denied: "/team", tab: ["a", "b"], x: undefined })).toBe("/vault/personal?denied=%2Fteam&tab=a&tab=b");
  });
});
