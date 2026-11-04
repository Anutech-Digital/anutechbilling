// @vitest-environment jsdom
/**
 * R-2175 (G-PERSONAL, check-2125 follow-up): the app shell (Sidebar, TopBar bell, attendance
 * reminder) runs on every page. For a PERSONAL session its business-only reads were refused by
 * the data gateway (R-2125 allowlist) — rpc nav_badges, rpc my_attendance_today, holidays,
 * tasks, leads, contacts, subscriptions — one 403 + one `gateway_refused` log line each, on
 * every page, and the help "error was caught" badge lit up. A personal workspace has none of
 * those records, so the shell must not ask.
 *
 * Owner's real path: personal login → any money page → the shell mounts. We render the same
 * hooks/components the shell mounts, with a recording Supabase client, and list every table /
 * RPC they touch. Personal: none of the business ones. Business owner: unchanged (all asked).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { render, renderHook, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const calls: string[] = [];

/** A supabase-js stand-in: every from()/rpc() is recorded; any chain resolves to empty rows. */
function chain(): unknown {
  const result = { data: [], error: null, count: 0 };
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (res: (v: unknown) => unknown) => Promise.resolve(result).then(res);
      return () => proxy;
    },
  });
  return proxy;
}
const fakeClient = {
  from: (table: string) => { calls.push(`table:${table}`); return chain(); },
  rpc: (name: string) => { calls.push(`rpc:${name}`); return chain(); },
  auth: { getUser: async () => ({ data: { user: { id: "u-1" } } }) },
};
vi.mock("@/lib/supabase/client", () => ({ createClient: () => fakeClient }));

const me: { data: unknown; isLoading: boolean } = { data: null, isLoading: false };
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => me,
  useIdentity: () => ({ status: "member", email: null }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/vault/personal" }));

import { useNavBadges } from "./useNavBadges";
import { useNotificationFeed } from "@/components/layout/notification-panel";
import { useHasSubscriptions } from "@/lib/queries/sell-mode";
import { AttendanceReminder } from "@/components/features/attendance/attendance-reminder";

const BUSINESS_ONLY = [
  "rpc:nav_badges", "rpc:my_attendance_today", "table:holidays",
  "table:tasks", "table:leads", "table:contacts", "table:subscriptions",
];

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function mountShell() {
  renderHook(() => { useNavBadges(); useNotificationFeed(); useHasSubscriptions(true); }, { wrapper });
  render(<AttendanceReminder />, { wrapper });
}

const user = (role: string) => ({ userId: "u-1", role, tenantId: "t-1", tenantName: "X" });

beforeEach(() => { calls.length = 0; });
afterEach(() => cleanup());

describe("app shell calls (R-2175)", () => {
  it("a business owner still gets every shell read (unchanged)", async () => {
    me.data = user("owner"); me.isLoading = false;
    mountShell();
    await waitFor(() => { for (const c of BUSINESS_ONLY) expect(calls).toContain(c); });
  });

  it("a personal session asks for none of the business-only reads", async () => {
    me.data = user("personal"); me.isLoading = false;
    mountShell();
    /* The bell's own source (notifications) is on the personal allowlist and still loads —
       wait for it, so a stray business call would have fired by now. */
    await waitFor(() => expect(calls).toContain("table:notifications"));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => BUSINESS_ONLY.includes(c))).toEqual([]);
  });

  it("while identity is loading nothing business-only fires (the role is not known yet)", async () => {
    me.data = undefined; me.isLoading = true;
    mountShell();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => BUSINESS_ONLY.includes(c))).toEqual([]);
  });
});
