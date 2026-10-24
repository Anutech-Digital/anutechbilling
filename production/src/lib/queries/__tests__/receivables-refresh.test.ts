// @vitest-environment jsdom
/**
 * R-1634 — after money moves, Payment Follow-up (/collections) shows the new balance without a
 * reload.
 *
 * useCollections reads ["collections"] (collections.ts) and the customer page's card reads
 * ["collections", "customer", id]. No money save refreshed that key: a payment recorded on the
 * /collections page's own sheet left the customer's row on the old "baaki". Every save that
 * changes what a customer owes now calls ONE helper, invalidateReceivables, so a screen that
 * shows a balance cannot be forgotten again at one save path.
 *
 * Two halves: the saves themselves against a real QueryClient, and a scan that no file
 * refreshes the dues keys by hand (it would skip the helper, and with it /collections).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";

const rpcData: Record<string, unknown> = {
  delete_payment: null,
  refund_payment: { refund_voucher_no: "RF-1", amount: 100 },
  record_multi_invoice_payment: { payment_id: "p1" },
  issue_credit_note: { credit_note_id: "CN-1", new_net_payable: 0 },
  write_off_subscription: { subscription_id: "s1", outstanding_amount: 100, invoices_written_off: ["INV-1"], invoice_amount: 100, invoices_left_open: [] },
};
function ok(): Record<string, unknown> {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "update", "eq", "in", "is", "order", "range"]) b[m] = () => b;
  b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(res);
  return b;
}
const fakeClient = {
  rpc: async (name: string) => ({ data: rpcData[name] ?? null, error: null }),
  from: () => ok(),
};
vi.mock("@/lib/supabase/client", () => ({ createClient: () => fakeClient }));
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined, warning: () => undefined }) }));

import {
  useDeletePayment, useRecordMultiInvoicePayment, useRefundPayment, useUpdatePayment, useWriteOffSubscription,
} from "../payments";
import { useIssueCreditNote } from "../credit-notes";
import { RECEIVABLE_KEYS } from "../receivables-refresh";
import { queryKeys } from "../keys";

afterEach(cleanup);

/** The keys exactly as the screens write them. */
const SCREEN = {
  collections: ["collections"],
  collectionsCustomer: ["collections", "customer", "cust-1"],
  dues: ["outstanding-receivables"],
  aging: ["accounting", "aging"],
  invoices: ["invoices"],
} as const;

function setup<T>(useHook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const key of Object.values(SCREEN)) qc.setQueryData(key as unknown as QueryKey, { loaded: true });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(useHook, { wrapper });
  const stale = (key: readonly string[]) => qc.getQueryState(key as unknown as QueryKey)?.isInvalidated === true;
  const allStale = () => Object.values(SCREEN).every((k) => stale(k));
  return { result, stale, allStale };
}

describe("money saves refresh Payment Follow-up (R-1634)", () => {
  it("the helper's keys include /collections, the dues card and Aging", () => {
    const keys = RECEIVABLE_KEYS.map((k) => k.join("/"));
    expect(keys).toContain(queryKeys.collections().join("/"));
    expect(keys).toContain("outstanding-receivables");
    expect(keys).toContain(queryKeys.aging().join("/"));
  });

  it("a multi-invoice payment (the /collections sheet) refreshes /collections", async () => {
    const { result, allStale } = setup(() => useRecordMultiInvoicePayment());
    await act(() => result.current.mutateAsync({
      customerId: "cust-1", receivedOn: "2026-10-23", method: "upi" as never, bankAccountId: null,
      reference: "UTR1", received: 100, allocations: [{ invoice_id: "inv-1", amount: 100 }],
      excessToCredit: false, notes: null,
    }));
    expect(allStale()).toBe(true);
  });

  it("deleting, refunding and editing a payment refresh /collections", async () => {
    const del = setup(() => useDeletePayment());
    await act(() => del.result.current.mutateAsync("pay-1"));
    expect(del.allStale()).toBe(true);

    const refund = setup(() => useRefundPayment());
    await act(() => refund.result.current.mutateAsync({ id: "pay-1", reason: "duplicate" }));
    expect(refund.allStale()).toBe(true);

    const edit = setup(() => useUpdatePayment());
    await act(() => edit.result.current.mutateAsync({ id: "pay-1", method: "upi" } as never));
    expect(edit.allStale()).toBe(true);
  });

  it("a credit note and a write-off refresh /collections", async () => {
    const cn = setup(() => useIssueCreditNote());
    await act(() => cn.result.current.mutateAsync({ invoiceId: "inv-1", grossAmount: 100, reasonCode: "other" as never }));
    expect(cn.allStale()).toBe(true);

    const wo = setup(() => useWriteOffSubscription());
    await act(() => wo.result.current.mutateAsync({ id: "s1", reason: "Customer closed the business" }));
    expect(wo.allStale()).toBe(true);
  });
});

/* ─── the scan ────────────────────────────────────────────────────────────────────── */

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.posix.join(dir, d.name);
    if (d.isDirectory()) return d.name === "generated" ? [] : walk(p);
    return /\.tsx?$/.test(d.name) && !/\.test\.|\.spec\./.test(d.name) ? [p] : [];
  });
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/^\s*\/\/.*$/gm, "");

/** A hand-written refresh of the dues list or of payments — money moved, so /collections must too. */
const BY_HAND = [
  /invalidateQueries\(\s*\{\s*queryKey:\s*\[\s*["'](?:outstanding-receivables|payments)["']\s*\]/,
  /for\s*\(\s*const\s+\w+\s+of\s+\[[^\]]*["'](?:outstanding-receivables|payments)["'][^\]]*\]\s*\)/,
  /for\s*\(\s*const\s+\w+\s+of\s+\[[^\]]*\[\s*["'](?:outstanding-receivables|payments)["']\s*\][^)]*\)/,
];

function byHand(src: string): boolean {
  return BY_HAND.some((re) => re.test(strip(src)));
}

describe("no save refreshes the dues by hand (R-1634 scan)", () => {
  it("the scan catches the old shapes (fixtures)", () => {
    expect(byHand('qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });')).toBe(true);
    expect(byHand('qc.invalidateQueries({ queryKey: ["payments"] });')).toBe(true);
    expect(byHand('for (const key of ["payments", "invoices"]) { qc.invalidateQueries({ queryKey: [key] }); }')).toBe(true);
    expect(byHand('for (const key of [["payments"], ["quotes"]]) qc.invalidateQueries({ queryKey: key });')).toBe(true);
    expect(byHand('qc.invalidateQueries({ queryKey: ["payments", "by-quote", id] });')).toBe(false);
    expect(byHand("invalidateReceivables(qc);")).toBe(false);
  });

  it("src/: every money save goes through invalidateReceivables", () => {
    const bad = walk("src")
      .filter((f) => !f.endsWith("lib/queries/receivables-refresh.ts"))
      .filter((f) => byHand(readFileSync(f, "utf8")));
    expect(bad, "refreshes payments / dues by hand — call invalidateReceivables(qc) (lib/queries/receivables-refresh.ts) so /collections refreshes too").toEqual([]);
  });
});
