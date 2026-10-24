// @vitest-environment jsdom
/**
 * R-1740 follow-up (22 Oct 2026, browser check): on a customer page the chip was saved
 * (PATCH 204, DB relative/close) but still read "Unknown", also after reload. The refetch
 * was customer_contacts?select=role,is_primary,contacts(<CONTACT_COLUMNS>) and that column
 * list still had the old `relationship` and not relationship_type / closeness. Same list
 * feeds useContact → the lead drawer chip and the contact page.
 *
 * The fake client below behaves like PostgREST: it returns ONLY the columns the select names,
 * so a missing column in the query reaches the screen as it did in the browser.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, renderHook, cleanup, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The real row in the database after Save (owner example: Relative · Close).
const DB_ROW: Record<string, unknown> = {
  id: "C-MVHL6BYS-3N", tenant_id: "t1", full_name: "Rohit", email: "rohit@x.in", phone: null,
  company: "T-V4", title: null, source: "manual", status: "engaged", customer_id: null,
  relationship: null, relationship_type: "relative", closeness: "close", role: "poc", is_primary: true,
  emails: [], phones: [], tags: [],
};
const selects: string[] = [];

/** Keep only the columns named in a select list (PostgREST behaviour). */
function project(row: Record<string, unknown>, cols: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cols.split(",").map((s) => s.trim()).filter(Boolean)) if (c in row) out[c] = row[c];
  return out;
}

function fakeClient() {
  return {
    from(table: string) {
      let sel = "";
      const q = {
        select(s: string) { sel = s; selects.push(`${table}:${s}`); return q; },
        eq() { return q; },
        order() { return q; },
        maybeSingle: async () => ({ data: project(DB_ROW, sel), error: null }),
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          // customer_contacts → role, is_primary, contacts(<cols>)
          const inner = /contacts\(([^)]*)\)/.exec(sel)?.[1] ?? "";
          const data = [{ role: "poc", is_primary: true, contacts: project(DB_ROW, inner) }];
          return Promise.resolve({ data, error: null }).then(res, rej);
        },
      };
      return q;
    },
  };
}
vi.mock("@/lib/supabase/client", () => ({ createClient: () => fakeClient() }));

import { useContact, useCustomerContacts } from "@/lib/queries/contacts";
import { CONTACT_COLUMNS } from "@/lib/queries/columns";
import { CustomerRelationshipChip } from "./relationship-chip";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
);

afterEach(() => { cleanup(); selects.length = 0; });

describe("R-1740: the chip reads what was saved", () => {
  it("CONTACT_COLUMNS carries relationship_type and closeness, not the retired relationship", () => {
    const cols = CONTACT_COLUMNS.split(",").map((s) => s.trim());
    expect(cols).toContain("relationship_type");
    expect(cols).toContain("closeness");
    expect(cols).not.toContain("relationship");
  });

  it("customer header: the useCustomerContacts rows show 'Relative · Close'", async () => {
    const { result } = renderHook(() => useCustomerContacts("cust-1"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(selects.some((s) => s.startsWith("customer_contacts:") && /relationship_type/.test(s) && /closeness/.test(s))).toBe(true);
    render(<CustomerRelationshipChip people={result.current.data} canEdit={false} />, { wrapper });
    expect(screen.getByText("Relative · Close")).toBeTruthy();
  });

  it("lead drawer / contact page: useContact returns relationship_type and closeness", async () => {
    const { result } = renderHook(() => useContact("C-MVHL6BYS-3N"), { wrapper });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(result.current.data).toMatchObject({ relationship_type: "relative", closeness: "close" });
  });
});
