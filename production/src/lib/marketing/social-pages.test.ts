/**
 * R-2729: saving every Page of a Facebook login — tokens sealed, the main Page on, new Pages off,
 * Pages seen before keep their on/off choice. The database, vault and Meta are faked.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/crypto/vault", () => ({ encryptSecret: (s: string) => `sealed(${s})`, decryptSecret: (s: string | null) => (s ? s.replace(/^sealed\((.*)\)$/, "$1") : null) }));
vi.mock("./social-content", () => ({ instagramForPage: vi.fn(async (id: string) => (id === "111" ? { id: "9001", username: "anutech" } : null)) }));

import { pageConnection, syncPagesFromLogin } from "./social-pages.server";

function fakeDb(existing: { page_id: string; active: boolean }[], token?: string) {
  const writes: { table: string; op: string; payload: unknown; filters: [string, string, unknown][] }[] = [];
  const from = (table: string) => {
    const w = { table, op: "select", payload: undefined as unknown, filters: [] as [string, string, unknown][] };
    writes.push(w);
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b, order: () => b,
      eq: (k: string, v: unknown) => { w.filters.push(["eq", k, v]); return b; },
      neq: (k: string, v: unknown) => { w.filters.push(["neq", k, v]); return b; },
      upsert: (p: unknown) => { w.op = "upsert"; w.payload = p; return b; },
      update: (p: unknown) => { w.op = "update"; w.payload = p; return b; },
      maybeSingle: async () => ({ data: table === "social_page_tokens" ? (token ? { page_token: token } : null) : { page_id: "111", name: "Anutech", instagram_id: "9001" }, error: null }),
      then: (res: (v: unknown) => unknown) => res({ data: table === "social_pages" && w.op === "select" ? existing.map((e) => ({ ...e, is_main: false, name: "x" })) : [], error: null }),
    });
    return b;
  };
  return { db: { from } as never, writes };
}

const T = "11111111-1111-4111-8111-111111111111";
const PAGES = [{ id: "111", name: "Anutech", access_token: "tokA" }, { id: "222", name: "Neo Trail", access_token: "tokN" }, { id: "333", name: "Delfos", access_token: "tokD" }];

describe("R-2729 saving the Pages of a Facebook login", () => {
  it("seals every token, saves Instagram, switches the main Page on and new Pages off, keeps known Pages' choice", async () => {
    const { db, writes } = fakeDb([{ page_id: "333", active: true }]);
    expect(await syncPagesFromLogin(db, T, PAGES, "111")).toBe(3);
    const tokens = writes.find((w) => w.table === "social_page_tokens" && w.op === "upsert")!.payload as { page_id: string; page_token: string; tenant_id: string }[];
    expect(tokens.map((t) => t.page_token)).toEqual(["sealed(tokA)", "sealed(tokN)", "sealed(tokD)"]);
    expect(tokens.every((t) => t.tenant_id === T)).toBe(true);
    const pages = writes.find((w) => w.table === "social_pages" && w.op === "upsert")!.payload as { page_id: string; active?: boolean; instagram_id: string | null; instagram_username: string | null }[];
    expect(pages.find((p) => p.page_id === "111")).toMatchObject({ active: true, instagram_id: "9001", instagram_username: "anutech" });
    expect(pages.find((p) => p.page_id === "222")).toMatchObject({ active: false, instagram_id: null });
    expect(pages.find((p) => p.page_id === "333")).not.toHaveProperty("active"); // seen before: its on/off stays
    const main = writes.filter((w) => w.table === "social_pages" && w.op === "update");
    expect(main.at(-1)!.payload).toEqual({ is_main: true, active: true });
    expect(main.at(-1)!.filters).toContainEqual(["eq", "page_id", "111"]);
  });

  it("ignores Pages without a token or a numeric id", async () => {
    const { db } = fakeDb([]);
    expect(await syncPagesFromLogin(db, T, [{ id: "abc", name: "x", access_token: "t" }, { id: "444", name: "y", access_token: "" }], "444")).toBe(0);
  });

  it("opens the sealed token only on the server, for this company's Page", async () => {
    const { db, writes } = fakeDb([], "sealed(tokA)");
    expect(await pageConnection(db, T, "111")).toEqual({ pageId: "111", pageToken: "tokA", pageName: "Anutech", instagramId: "9001" });
    expect(writes.find((w) => w.table === "social_page_tokens")!.filters).toEqual([["eq", "tenant_id", T], ["eq", "page_id", "111"]]);
    expect((await pageConnection(db, T, "../x")).pageToken).toBeNull();
  });
});
