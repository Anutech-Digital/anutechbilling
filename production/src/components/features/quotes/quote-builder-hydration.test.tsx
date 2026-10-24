// @vitest-environment jsdom
//
// R-1497 — /quotes/new threw "Minified React error #418 (HTML)" on staging: the HTML the
// server sent for the quote builder was not the HTML the browser drew on its first render.
// This renders the builder the way Next does on a hard load — renderToString on the
// "server" (no window/document/navigator), then hydrateRoot over that markup in the
// "browser" — and fails if React reports any hydration mismatch.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/quotes/new",
}));

/* No network in a test — every query the builder starts stays pending. */
vi.mock("@/lib/supabase/client", () => {
  const never = new Promise(() => {});
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, p) => (p === "then" ? never.then.bind(never) : chain),
    apply: () => chain,
  });
  return { createClient: () => chain };
});

vi.mock("@/components/providers/workspace-tabs-provider", () => ({
  useWorkspaceTabs: () => ({ activeId: null, setDraft: () => {} }),
}));

import { QuoteBuilder } from "./quote-builder";

type Seed = Array<[readonly unknown[], unknown]>;

function Tree({ seed = [] }: { seed?: Seed }) {
  const [qc] = React.useState(() => {
    const c = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    for (const [key, data] of seed) c.setQueryData(key, data);
    return c;
  });
  return (
    <QueryClientProvider client={qc}>
      <QuoteBuilder />
    </QueryClientProvider>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

function serverHtml(): string {
  /* A real server has no window/document/navigator/localStorage — hide them while the
     "server" renders, so a `typeof window` branch takes the server path here too. */
  const g = globalThis as Record<string, unknown>;
  const hidden = ["window", "document", "navigator", "localStorage", "sessionStorage", "matchMedia"] as const;
  const saved = hidden.map((k) => Object.getOwnPropertyDescriptor(g, k));
  try {
    for (const k of hidden) Object.defineProperty(g, k, { value: undefined, configurable: true, writable: true });
    return renderToString(<Tree />);
  } finally {
    hidden.forEach((k, i) => {
      const d = saved[i];
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    });
  }
}

async function hydrationErrors(clientSeed: Seed = []): Promise<string[]> {
  const html = serverHtml();
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const errors: string[] = [];
  const consoleErr = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    const msg = a.map(String).join(" ");
    if (/hydrat|did not match|cannot be a (descendant|child)/i.test(msg)) errors.push(msg);
  });
  try {
    await act(async () => {
      hydrateRoot(container, <Tree seed={clientSeed} />, {
        onRecoverableError: (e) => errors.push(String((e as Error)?.message ?? e)),
      });
    });
  } finally {
    consoleErr.mockRestore();
  }
  /* And the builder itself must actually be drawn once hydration is over. */
  if (!/New quotation/.test(container.textContent ?? "")) errors.push("builder never rendered after hydration");
  return errors;
}

const ME = {
  userId: "u1", authEmail: "owner@example.test", isPlatformAdmin: false, fullName: "Owner",
  initials: "OW", color: null, role: "owner", canViewDeals: true, tenantId: "t1", tenantName: "Test Co",
  tenantLogoUrl: null, tenantGstin: null, tenantEmail: null, tenantPhone: null, tenantAddress: null,
  tenantPinCode: null, tenantState: null, tenantStateCode: null, tenantContactName: null,
  tenantLutNumber: null, tenantLutValidUpto: null, tenantUpiVpa: null, tenantUpiPayeeName: null,
  tenantRemitBankName: null, tenantRemitAccountName: null, tenantRemitAccountNumber: null,
  tenantRemitIfsc: null, tenantRemitBranch: null, tenantGracePeriodDays: 7,
  tenantSetupCompletedAt: null, tenantGstinVerifiedAt: null, tenantGstinVerification: null,
};

describe("R-1497: /quotes/new hydrates without a server/browser HTML mismatch", () => {
  it("cold cache: the browser's first render matches the server HTML", async () => {
    expect(await hydrationErrors()).toEqual([]);
  });

  it("warm cache: the shell already fetched the signed-in user before the builder hydrated", async () => {
    /* The page sits under <Suspense> and its chunk is large, so on a hard load the app shell
       (Sidebar/TopBar) hydrates first and its useCurrentUser() call can finish before the
       builder hydrates. React Query hands that cached row to the builder's FIRST client
       render — the server never had it. */
    expect(await hydrationErrors([[["current-user"], ME]])).toEqual([]);
  });

  it("warm cache: customers / subscriptions / catalogue already in the cache", async () => {
    /* Child components (CustomerCombobox) read the cache on their own, so gating only the
       builder's own useCurrentUser() would not be enough. */
    expect(await hydrationErrors([
      [["customers"], [{ id: "c1", name: "Acme", status: "active" }]],
      [["subscriptions"], []],
      [["items", "all", false], [{ id: "i1", name: "Google Workspace Business Starter", item_type: "recurring", price: 270, vendor: "google" }]],
    ])).toEqual([]);
  });
});
