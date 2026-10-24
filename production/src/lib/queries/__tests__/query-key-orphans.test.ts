// @vitest-environment jsdom
/**
 * R-1589 — after a save, the screen must show the new number without a reload.
 *
 * TanStack Query refreshes a screen only when a save invalidates a key that is a PREFIX of
 * the screen's own query key. Nine save paths invalidated ["aging"] while Aging reads
 * ["accounting", "aging"]; a payment delete invalidated "purchase-orders" while Purchase
 * Orders reads "purchase_orders"; a multi-invoice payment invalidated "customer-credits"
 * while the credit balance reads "customer_credits"; a commission payment invalidated
 * ["pnl"] while P&L reads ["accounting", "pnl", …]. No error anywhere — the old number just
 * stayed (global staleTime 30 s, and a mounted screen never refetches on its own).
 *
 * Two halves:
 *   1. the saves themselves, run against a real QueryClient holding the screens' queries
 *      under the keys the screens use — each must come back invalidated;
 *   2. a scan of src/: every invalidateQueries / refetchQueries / cancelQueries key must be
 *      a prefix of some query's key, or be listed in INTENTIONAL with the reason.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";

/* ─── a client whose every write succeeds ─────────────────────────────────────────── */
const rpcData: Record<string, unknown> = {
  delete_payment: null,
  refund_payment: { refund_voucher_no: "RF-1", amount: 100 },
  record_multi_invoice_payment: { payment_id: "p1" },
  issue_credit_note: { credit_note_id: "CN-1", new_net_payable: 0 },
  pay_referral_commission: null,
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
vi.mock("sonner", () => ({ toast: Object.assign(() => undefined, { success: () => undefined, error: () => undefined }) }));

import { useDeletePayment, useRecordMultiInvoicePayment, useRefundPayment } from "../payments";
import { useIssueCreditNote } from "../credit-notes";
import { useCancelCommission, usePayCommission } from "../referral-commissions";
import { queryKeys } from "../keys";

afterEach(cleanup);

/** The keys exactly as the screens write them (literal, not through queryKeys). */
const SCREEN = {
  aging: ["accounting", "aging"],
  credit: ["customer_credits", "open-total", "cust-1"],
  creditsList: ["customer_credits", "open-by-customer"],
  poList: ["purchase_orders"],
  pnl: ["accounting", "pnl", "2026-04-01", "2027-03-31"],
  bankAccounts: ["bank_accounts"],
} as const;

/** A QueryClient holding a fresh copy of every screen query, and the hook under test. */
function setup<T>(useHook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  for (const key of Object.values(SCREEN)) qc.setQueryData(key as unknown as QueryKey, { loaded: true });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  const { result } = renderHook(useHook, { wrapper });
  const stale = (key: readonly string[]) => qc.getQueryState(key as unknown as QueryKey)?.isInvalidated === true;
  return { result, stale };
}

describe("a save refreshes the screens it changes (R-1589)", () => {
  it("the screens' keys sit under the queryKeys prefixes", () => {
    expect(SCREEN.aging.slice(0, 2)).toEqual([...queryKeys.aging()]);
    expect(SCREEN.pnl.slice(0, 2)).toEqual([...queryKeys.pnl()]);
    expect(SCREEN.credit.slice(0, 1)).toEqual([...queryKeys.customerCredits()]);
    expect(SCREEN.poList).toEqual([...queryKeys.purchaseOrders()]);
  });

  it("deleting a payment refreshes Aging, the customer's credit and Purchase Orders", async () => {
    const { result, stale } = setup(() => useDeletePayment());
    await act(() => result.current.mutateAsync("pay-1"));
    expect(stale(SCREEN.aging)).toBe(true);
    expect(stale(SCREEN.credit)).toBe(true);
    expect(stale(SCREEN.creditsList)).toBe(true);
    expect(stale(SCREEN.poList)).toBe(true);
  });

  it("refunding a payment refreshes Aging and the customer's credit", async () => {
    const { result, stale } = setup(() => useRefundPayment());
    await act(() => result.current.mutateAsync({ id: "pay-1", reason: "duplicate" }));
    expect(stale(SCREEN.aging)).toBe(true);
    expect(stale(SCREEN.credit)).toBe(true);
  });

  it("a multi-invoice payment refreshes Aging and the customer's credit (was 'customer-credits')", async () => {
    const { result, stale } = setup(() => useRecordMultiInvoicePayment());
    await act(() => result.current.mutateAsync({
      customerId: "cust-1", receivedOn: "2026-10-18", method: "upi" as never, bankAccountId: null,
      reference: "UTR1", received: 100, allocations: [{ invoice_id: "inv-1", amount: 100 }],
      excessToCredit: false, notes: null,
    }));
    expect(stale(SCREEN.aging)).toBe(true);
    expect(stale(SCREEN.credit)).toBe(true);
  });

  it("a credit note refreshes Aging (was ['aging']) and the customer's credit", async () => {
    const { result, stale } = setup(() => useIssueCreditNote());
    await act(() => result.current.mutateAsync({ invoiceId: "inv-1", grossAmount: 100, reasonCode: "other" as never }));
    expect(stale(SCREEN.aging)).toBe(true);
    expect(stale(SCREEN.credit)).toBe(true);
  });

  it("paying / cancelling a commission refreshes P&L (was ['pnl']) and the bank balances (was ['banking'])", async () => {
    const pay = setup(() => usePayCommission());
    await act(() => pay.result.current.mutateAsync({ commissionId: "c1", bankAccountId: "b1" } as never));
    expect(pay.stale(SCREEN.pnl)).toBe(true);
    expect(pay.stale(SCREEN.bankAccounts)).toBe(true);

    const cancel = setup(() => useCancelCommission());
    await act(() => cancel.result.current.mutateAsync("c1"));
    expect(cancel.stale(SCREEN.pnl)).toBe(true);
  });
});

/* ─── the scan ────────────────────────────────────────────────────────────────────── */

/**
 * Invalidations whose key no query in src/ uses, kept on purpose. Empty when R-1589 landed:
 * a key nothing reads refreshes nothing, so fix the key (or delete the line) instead.
 */
const INTENTIONAL: Record<string, string> = {};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.posix.join(dir, d.name);
    if (d.isDirectory()) return d.name === "generated" ? [] : walk(p);
    return /\.tsx?$/.test(d.name) && !/\.test\.|\.spec\./.test(d.name) ? [p] : [];
  });

/** Comments stripped, so prose about an old key neither trips nor satisfies the scan. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, "")).replace(/^\s*\/\/.*$/gm, "");

/** A key's leading literal parts, and whether anything (a variable, a spread) follows them. */
type Key = { lit: string[]; open: boolean };

const FACTORY: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(queryKeys).map(([k, f]) => [k, f() as readonly string[]]),
);

/** Read the key expression starting at `i` in `src` (a file's constants in `consts`). */
function readKey(src: string, i: number, consts: Map<string, Key>): Key | null {
  const rest = src.slice(i);
  const f = /^queryKeys\.(\w+)\(\)/.exec(rest);
  if (f) return FACTORY[f[1]] ? { lit: [...FACTORY[f[1]]], open: false } : null;
  const id = /^([A-Za-z_]\w*)\b/.exec(rest);
  if (id) return consts.get(id[1]) ?? null;   // a key constant, or a key function's call
  if (rest[0] !== "[") return null;
  const lit: string[] = [];
  let j = 1;
  for (;;) {
    while (/\s/.test(rest[j] ?? "")) j++;
    if (rest[j] === "]") return { lit, open: false };
    const s = /^(["'])([^"'\n]*)\1/.exec(rest.slice(j));
    const spreadF = /^\.\.\.queryKeys\.(\w+)\(\)/.exec(rest.slice(j));
    const spreadC = /^\.\.\.([A-Za-z_]\w*)\b(?!\s*\()/.exec(rest.slice(j));
    if (s) { lit.push(s[2]); j += s[0].length; }
    else if (spreadF && lit.length === 0 && FACTORY[spreadF[1]]) { lit.push(...FACTORY[spreadF[1]]); j += spreadF[0].length; }
    else if (spreadC && lit.length === 0 && consts.get(spreadC[1])) {
      const c = consts.get(spreadC[1])!;
      lit.push(...c.lit);
      if (c.open) return { lit, open: true };
      j += spreadC[0].length;
    }
    else return { lit, open: true };
    while (/\s/.test(rest[j] ?? "")) j++;
    if (rest[j] === ",") { j++; continue; }
    if (rest[j] === "]") return { lit, open: false };
    return { lit, open: true };
  }
}

const CLIENT_CALL = /\b(invalidateQueries|refetchQueries|cancelQueries|resetQueries|removeQueries)\(\s*\{\s*queryKey:\s*/g;

type Found = { file: string; line: number; key: Key };

function scan(files: { file: string; src: string }[]) {
  const defs: Key[] = [];
  const invs: Found[] = [];
  for (const { file, src } of files) {
    // File-level key constants: `const X = [...]` / `const x = (…) => [...]` (as const or not).
    const consts = new Map<string, Key>();
    for (const m of src.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:\([^)]*\)\s*=>\s*)?(?=\[)/g)) {
      const k = readKey(src, m.index! + m[0].length, consts);
      if (k && k.lit.length) consts.set(m[1], k);
    }
    const invAt = new Set<number>();
    for (const m of src.matchAll(CLIENT_CALL)) {
      const at = m.index! + m[0].length;
      invAt.add(at);
      const key = readKey(src, at, consts);
      if (key && key.lit.length) invs.push({ file, line: src.slice(0, at).split("\n").length, key });
    }
    // `for (const k of ["a", "b"]) qc.invalidateQueries({ queryKey: [k] })`
    for (const m of src.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+\[([^\]]*)\]\s*\)\s*\{?\s*(?:void\s+)?\w+\.invalidateQueries\(\s*\{\s*queryKey:\s*\[\s*(\w+)\s*\]/g)) {
      if (m[1] !== m[3]) continue;
      for (const s of m[2].matchAll(/["']([^"']+)["']/g)) {
        invs.push({ file, line: src.slice(0, m.index!).split("\n").length, key: { lit: [s[1]], open: false } });
      }
    }
    for (const m of src.matchAll(/\bqueryKey:\s*/g)) {
      const at = m.index! + m[0].length;
      if (invAt.has(at)) continue;
      const key = readKey(src, at, consts);
      if (key && key.lit.length) defs.push(key);
    }
  }
  /** `inv` refreshes `def` when inv's literal parts are a prefix of def's (def's open tail matches anything). */
  const covers = (inv: Key, def: Key) =>
    inv.lit.every((p, i) => (i < def.lit.length ? def.lit[i] === p : def.open));
  const orphans = invs.filter((v) => !defs.some((d) => covers(v.key, d)));
  return { defs, invs, orphans };
}

const fmt = (o: Found) => `${o.file}:${o.line} invalidates ${JSON.stringify(o.key.lit)}${o.key.open ? "+…" : ""}`;

describe("every invalidated key is one some query uses (R-1589 scan)", () => {
  it("the scan catches the R-1589 bugs (fixtures)", () => {
    const { orphans } = scan([
      { file: "page.tsx", src: 'useQuery({ queryKey: ["accounting", "aging"], queryFn });\nuseQuery({ queryKey: ["purchase_orders"] });\nuseQuery({ queryKey: ["accounting", "pnl", a, b] });' },
      { file: "save.ts", src: [
        'qc.invalidateQueries({ queryKey: ["aging"] });',
        'qc.invalidateQueries({ queryKey: ["purchase-orders"] });',
        'qc.invalidateQueries({ queryKey: ["pnl"] });',
        'for (const key of ["purchase_orders", "customer-credits"]) { qc.invalidateQueries({ queryKey: [key] }); }',
        'qc.invalidateQueries({ queryKey: ["accounting"] });',
        'qc.invalidateQueries({ queryKey: queryKeys.aging() });',
        'qc.invalidateQueries({ queryKey: ["accounting", "pnl", "2026-04-01"] });',
      ].join("\n") },
    ]);
    expect(orphans.map((o) => o.key.lit.join("/"))).toEqual(["aging", "purchase-orders", "pnl", "customer-credits"]);
  });

  it("resolves key constants and spreads", () => {
    const { orphans } = scan([{ file: "x.ts", src: [
      'export const ADS_KEY = ["ads"] as const;',
      'const followupsKey = (id: string) => ["leads", "followups", id];',
      'useQuery({ queryKey: [...ADS_KEY, "spend", day] });',
      'useQuery({ queryKey: followupsKey(id) });',
      'qc.invalidateQueries({ queryKey: [...ADS_KEY, "spend"] });',
      'qc.invalidateQueries({ queryKey: ADS_KEY });',
      'qc.invalidateQueries({ queryKey: [...ADS_KEY, "nope"] });',
    ].join("\n") }]);
    expect(orphans.map((o) => o.key.lit.join("/"))).toEqual(["ads/nope"]);
  });

  it("src/: no invalidation of a key nothing reads", () => {
    const files = walk("src").map((file) => ({ file, src: strip(readFileSync(file, "utf8")) }));
    const { invs, orphans } = scan(files);
    expect(invs.length, "the scan found the app's invalidations").toBeGreaterThan(300);
    const bad = orphans.filter((o) => !INTENTIONAL[o.key.lit.join("/")]);
    expect(bad.map(fmt), "invalidated key that no useQuery uses — the screen stays stale; use the screen's key (lib/queries/keys.ts)").toEqual([]);
  });

  it("INTENTIONAL has no stale entries", () => {
    const files = walk("src").map((file) => ({ file, src: strip(readFileSync(file, "utf8")) }));
    const { orphans } = scan(files);
    const live = new Set(orphans.map((o) => o.key.lit.join("/")));
    for (const k of Object.keys(INTENTIONAL)) expect(live.has(k), `${k} is no longer an orphan — drop it from INTENTIONAL`).toBe(true);
  });
});
