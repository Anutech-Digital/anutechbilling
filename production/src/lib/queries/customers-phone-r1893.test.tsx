// @vitest-environment jsdom
//
// R-1893 (25 Oct 2026, Pardeep) — a customer's mobile has ONE home: the primary contact.
//
// The owner typed a Mobile in the customer form and the company profile never showed it: the
// form saved customers.contact_mobile, while the profile reads the primary contact's phone.
//   • A NEW customer's primary contact must be created WITH the typed number — mobile first,
//     else the phone. It used to get contact_phone only, so a mobile-only customer had a
//     contact with no phone.
//   • An EDIT that saves a new number is copied to the primary contact by the database
//     (trigger, supabase/tests/r1893_primary_contact_phone.test.sql); the screen must then
//     re-read the contacts, or it keeps showing the old (blank) phone until a reload.
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const attached: Array<Record<string, unknown>> = [];

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/queries/require-tenant", () => ({ requireTenantId: async () => "t1" }));
vi.mock("@/lib/contacts/attach", () => ({
  attachPrimaryContact: async (_db: unknown, input: Record<string, unknown>) => {
    attached.push(input);
    return { kind: "created", contactId: "ct1" };
  },
}));
vi.mock("@/lib/supabase/client", () => {
  const row = { id: "cust1", name: "Anil Tayal Co" };
  const chain = {
    insert: () => chain, update: () => chain, eq: () => chain, select: () => chain,
    single: async () => ({ data: row, error: null }),
  };
  return { createClient: () => ({ from: () => chain }) };
});

import { useCreateCustomer, useUpdateCustomer } from "./customers";

function wrap(qc: QueryClient) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

beforeEach(() => { attached.length = 0; });

describe("R-1893: the typed mobile reaches the primary contact", () => {
  it("a new customer with only a Mobile gets a contact with that mobile", async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useCreateCustomer(), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({
        name: "Anil Tayal Co", contact_name: "Anil Tayal", contact_email: "office2@example.in",
        contact_mobile: "9876543210", contact_phone: null,
      } as never);
    });
    expect(attached[0]?.phone).toBe("9876543210");
  });

  it("mobile first when both are typed; the phone when there is no mobile", async () => {
    const qc = new QueryClient();
    const { result } = renderHook(() => useCreateCustomer(), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({
        name: "X Co", contact_name: "Ravi K", contact_mobile: "9111111111", contact_phone: "01140000000",
      } as never);
      await result.current.mutateAsync({
        name: "Y Co", contact_name: "Ravi K", contact_mobile: "  ", contact_phone: "01140000000",
      } as never);
    });
    expect(attached.map((a) => a.phone)).toEqual(["9111111111", "01140000000"]);
  });

  it("saving an edit re-reads the customer's contacts (the database copied the number there)", async () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useUpdateCustomer(), { wrapper: wrap(qc) });
    await act(async () => {
      await result.current.mutateAsync({ id: "cust1", patch: { contact_mobile: "9222222222" } });
    });
    /* Any invalidated key that is a prefix of the profile Contacts query refreshes it. */
    const target = ["contacts", "customer", "cust1"];
    const hit = spy.mock.calls.some((c) => {
      const k = ((c[0] as { queryKey?: unknown[] })?.queryKey ?? []) as unknown[];
      return k.length > 0 && k.every((part, i) => part === target[i]);
    });
    expect(hit).toBe(true);
  });
});
