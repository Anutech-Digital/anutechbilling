/**
 * R-2915 — the whole Zoho chart of accounts, whatever Zoho's paging does. Staging (Excel, 17 Nov):
 * after two "Read from Zoho again" ~170 documents still said `account type … is not read yet` — the
 * stored chart was incomplete. The read must bring every page, the inactive accounts too, count each
 * Zoho call, and never loop. One account by its id is the last resort for one the lists missed.
 * Zoho is a fake fetch; values are made up.
 */
import { describe, it, expect } from "vitest";
import { readChartAccount, readChartOfAccounts } from "./fy-fetch";

const ORG = "600";
const TOKEN = "testonly-access";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const acc = (id: string, type = "expense", active = true) =>
  ({ account_id: id, account_name: `Account ${id}`, account_code: "", account_type: type, is_active: active });
const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => acc(`a${from + i}`));

interface Fake {
  /** The All list, page by page (index 0 = page 1). */
  all: Array<{ rows: Array<Record<string, unknown>>; more: boolean }>;
  inactive?: Array<Record<string, unknown>>;
  /** Answer every page number with page 1 (Zoho ignoring `page`). */
  ignorePage?: boolean;
  one?: Record<string, { status?: number; body: unknown }>;
}
function fakeZoho(o: Fake) {
  const urls: URL[] = [];
  const f = (async (input: string) => {
    const u = new URL(input);
    urls.push(u);
    const path = u.pathname.replace("/books/v3/", "");
    if (path === "chartofaccounts") {
      const page = o.ignorePage ? 1 : Number(u.searchParams.get("page") ?? 1);
      if (u.searchParams.get("filter_by") === "AccountType.Inactive") {
        return json({ code: 0, chartofaccounts: page === 1 ? o.inactive ?? [] : [], page_context: { has_more_page: false } });
      }
      const p = o.all[page - 1] ?? { rows: [], more: false };
      return json({ code: 0, chartofaccounts: p.rows, page_context: { has_more_page: p.more } });
    }
    const one = o.one?.[decodeURIComponent(path.replace("chartofaccounts/", ""))];
    if (one) return json(one.body, one.status ?? 200);
    return json({ code: 1002, message: "Account does not exist." }, 404);
  }) as unknown as typeof fetch;
  return { f, urls };
}
const lists = (urls: URL[], filter: string) => urls.filter((u) => u.searchParams.get("filter_by") === filter);

describe("R-2915 readChartOfAccounts — every account, every page", () => {
  it("reads every page while Zoho says there is more", async () => {
    const { f, urls } = fakeZoho({ all: [{ rows: range(0, 200), more: true }, { rows: range(200, 200), more: true }, { rows: range(400, 30), more: false }] });
    const accounts = await readChartOfAccounts(ORG, TOKEN, f);
    expect(accounts).toHaveLength(430);
    expect(new Set(accounts.map((a) => a.id)).size).toBe(430);
    expect(lists(urls, "AccountType.All").map((u) => u.searchParams.get("page"))).toEqual(["1", "2", "3"]);
  });

  it("follows a full page even when Zoho says there is no more page", async () => {
    const { f } = fakeZoho({ all: [{ rows: range(0, 200), more: false }, { rows: range(200, 60), more: false }] });
    const accounts = await readChartOfAccounts(ORG, TOKEN, f);
    expect(accounts).toHaveLength(260);
    expect(accounts.some((a) => a.id === "a259")).toBe(true);
  });

  it("stops when a page brings nothing new — Zoho ignoring the page number never loops", async () => {
    const { f, urls } = fakeZoho({ all: [{ rows: range(0, 200), more: true }], ignorePage: true });
    const accounts = await readChartOfAccounts(ORG, TOKEN, f);
    expect(accounts).toHaveLength(200);
    expect(lists(urls, "AccountType.All")).toHaveLength(2);
  });

  it("inactive accounts are read too (their own list), each account once", async () => {
    const { f, urls } = fakeZoho({
      all: [{ rows: [acc("a1"), acc("a2", "other_current_asset")], more: false }],
      inactive: [acc("a2", "other_current_asset", false), acc("old-loan", "long_term_liability", false), acc("old-pantry", "expense", false)],
    });
    const accounts = await readChartOfAccounts(ORG, TOKEN, f);
    expect(accounts.map((a) => a.id)).toEqual(["a1", "a2", "old-loan", "old-pantry"]);
    expect(accounts.find((a) => a.id === "old-loan")).toMatchObject({ type: "long_term_liability", active: false });
    expect(lists(urls, "AccountType.Inactive")).toHaveLength(1);
  });

  it("sorts by a column that cannot tie (account name) — pages of blank account codes shift", async () => {
    const { f, urls } = fakeZoho({ all: [{ rows: [acc("a1")], more: false }] });
    await readChartOfAccounts(ORG, TOKEN, f);
    expect(urls.every((u) => u.searchParams.get("sort_column") === "account_name")).toBe(true);
    expect(urls.every((u) => u.searchParams.get("per_page") === "200")).toBe(true);
  });

  it("calls are counted — one per Zoho request, a failed one too", async () => {
    const { f, urls } = fakeZoho({ all: [{ rows: range(0, 200), more: true }, { rows: range(200, 5), more: false }] });
    let calls = 0;
    await readChartOfAccounts(ORG, TOKEN, f, () => { calls += 1; });
    expect(calls).toBe(urls.length);
    expect(calls).toBe(3);
    let failed = 0;
    const down = (async () => json({ code: 9, message: "down" }, 500)) as unknown as typeof fetch;
    await expect(readChartOfAccounts(ORG, TOKEN, down, () => { failed += 1; })).rejects.toThrow();
    expect(failed).toBe(1);
  });
});

describe("R-2915 readChartAccount — one account by its Zoho id", () => {
  it("returns the account typed", async () => {
    const { f, urls } = fakeZoho({ all: [], one: { "77": { body: { code: 0, chart_of_account: acc("77", "long_term_liability", false) } } } });
    expect(await readChartAccount(ORG, TOKEN, "77", f)).toEqual({ id: "77", name: "Account 77", code: "", type: "long_term_liability", active: false });
    expect(urls[0].pathname).toBe("/books/v3/chartofaccounts/77");
    expect(urls[0].searchParams.get("organization_id")).toBe(ORG);
  });

  it("an account Zoho does not know, another account's answer, or no type → null (never a guessed type)", async () => {
    const { f } = fakeZoho({ all: [], one: {
      other: { body: { code: 0, chart_of_account: acc("someone-else") } },
      untyped: { body: { code: 0, chart_of_account: { account_id: "untyped", account_name: "X" } } },
      gone400: { status: 400, body: { code: 1002, message: "Account does not exist." } },
    } });
    expect(await readChartAccount(ORG, TOKEN, "deleted", f)).toBeNull();
    expect(await readChartAccount(ORG, TOKEN, "gone400", f)).toBeNull();
    expect(await readChartAccount(ORG, TOKEN, "other", f)).toBeNull();
    expect(await readChartAccount(ORG, TOKEN, "untyped", f)).toBeNull();
  });

  it("a Zoho failure that is not 'no such account' goes up (401, busy, server error)", async () => {
    const { f } = fakeZoho({ all: [], one: {
      auth: { status: 401, body: { code: 57, message: "You are not authorized to perform this operation" } },
      down: { status: 500, body: { code: 9, message: "down" } },
    } });
    await expect(readChartAccount(ORG, TOKEN, "auth", f)).rejects.toThrow();
    await expect(readChartAccount(ORG, TOKEN, "down", f)).rejects.toThrow();
  });
});
