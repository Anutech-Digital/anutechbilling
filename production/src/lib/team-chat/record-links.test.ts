/**
 * R-2302 (G-TEAMCHAT TC-09) — record links in team chat: the URL parser and the no-leak rule.
 *
 * Owner's path (card howToCheck): a teammate pastes a quote's address into #general; the
 * message shows "Quote Q-… · ₹… · Sent" and opens the quote. A Sales login reading a message
 * that links an INVOICE sees "Invoice — you don't have access" and never an amount.
 *
 * What these prove:
 *   - every app record URL (/quotes, /invoices, /customers, /subscriptions, /leads, /payments),
 *     pasted as a path OR as a full address of this app, becomes {type,id} — nothing else;
 *   - an external https link stays an external link (never a record), and unsafe schemes are nothing;
 *   - the preview is read under the VIEWER's own role + session: a role whose menu cannot open
 *     the record's page gets "no access" WITHOUT a database read (so no amount can arrive), and
 *     a row RLS hides reads as "not found or no access" — never the amount;
 *   - a stored link is {type,id} only (chat_links_ok): extra keys are dropped on the way in AND out.
 */
import { describe, expect, it, vi } from "vitest";
import { canOpenRoute } from "@/lib/nav";
import { USER_ROLES } from "@/lib/auth/roles";
import { quoteRowTotalPeriods, quoteTotalPeriodsText } from "@/lib/quotes/per-period-figures";
import {
  QUOTE_PREVIEW_COLUMNS,
  RECORD_LINK_TYPES,
  chatLinkKey,
  fetchRecordPreview,
  parseChatLink,
  recordHref,
  recordLinksInText,
  sanitizeChatLinks,
  viewerMayOpen,
  type PreviewDb,
} from "./record-links";

const APP = "https://app.example.in";

describe("parseChatLink — app record URLs become {type,id}", () => {
  it.each([
    ["/quotes/Q-2026-0042", "quote", "Q-2026-0042"],
    ["/invoices/INV-0007", "invoice", "INV-0007"],
    ["/customers/7f1c2a9e-1111-4111-8111-111111111111", "customer", "7f1c2a9e-1111-4111-8111-111111111111"],
    ["/subscriptions/9a8b7c6d-2222-4222-8222-222222222222", "subscription", "9a8b7c6d-2222-4222-8222-222222222222"],
    ["/leads/L-0099", "lead", "L-0099"],
    ["/payments/3c3c3c3c-3333-4333-8333-333333333333", "payment", "3c3c3c3c-3333-4333-8333-333333333333"],
  ])("%s → %s", (path, type, id) => {
    expect(parseChatLink(path, APP)).toEqual({ kind: "record", link: { type, id } });
  });

  it("a full address of THIS app is the same record (pasted from the address bar)", () => {
    expect(parseChatLink(`${APP}/quotes/Q-1?tab=lines#top`, APP)).toEqual({ kind: "record", link: { type: "quote", id: "Q-1" } });
    expect(parseChatLink(`${APP}/invoices/INV-9/print`, APP)).toEqual({ kind: "record", link: { type: "invoice", id: "INV-9" } });
  });

  it("the drawer / legacy forms the app itself writes are records too", () => {
    expect(parseChatLink("/subscriptions?open=9a8b7c6d-2222-4222-8222-222222222222&q=acme.in", APP))
      .toEqual({ kind: "record", link: { type: "subscription", id: "9a8b7c6d-2222-4222-8222-222222222222" } });
    expect(parseChatLink("/leads?lead=L-0099&ltab=activity", APP)).toEqual({ kind: "record", link: { type: "lead", id: "L-0099" } });
    expect(parseChatLink("/invoices?open=INV-3", APP)).toEqual({ kind: "record", link: { type: "invoice", id: "INV-3" } });
  });

  it("an invoice number with a '/' (document series) round-trips through its encoded address", () => {
    const parsed = parseChatLink("/invoices/ANU%2F26-27%2F001", APP);
    expect(parsed).toEqual({ kind: "record", link: { type: "invoice", id: "ANU/26-27/001" } });
    expect(recordHref({ type: "invoice", id: "ANU/26-27/001" })).toBe("/invoices/ANU%2F26-27%2F001");
  });

  it("list pages, 'new' forms and unknown pages are NOT records", () => {
    for (const p of ["/quotes", "/quotes/new", "/customers/new", "/customers/groups", "/invoices/", "/settings/team", "/reports/x"]) {
      expect(parseChatLink(p, APP)).toBeNull();
    }
  });

  it("an id the server would refuse (over 64 chars, spaces) is not a record", () => {
    expect(parseChatLink(`/quotes/${"Q".repeat(65)}`, APP)).toBeNull();
    expect(parseChatLink("/quotes/Q%201", APP)).toBeNull();
  });

  it("plain external https links stay external; another site's /quotes/ path is NOT our record", () => {
    expect(parseChatLink("https://www.zoho.com/books/", APP)).toEqual({ kind: "external", href: "https://www.zoho.com/books/" });
    expect(parseChatLink("https://evil.example.com/quotes/Q-1", APP))
      .toEqual({ kind: "external", href: "https://evil.example.com/quotes/Q-1" });
  });

  it("unsafe or odd links are nothing", () => {
    for (const s of ["javascript:alert(1)", "data:text/html,x", "mailto:a@b.in", "ftp://x.in/f", "//evil.com/quotes/Q-1",
      "https://user:pw@x.in/", "not a link", ""]) {
      expect(parseChatLink(s, APP)).toBeNull();
    }
  });

  it("every type's own address parses back to it (the picker writes these)", () => {
    for (const type of RECORD_LINK_TYPES) {
      if (type === "payment") continue; // no single-payment page — its card opens the customer's receipts
      const link = { type, id: "AB-12" };
      expect(parseChatLink(recordHref(link), APP)).toEqual({ kind: "record", link });
    }
  });
});

describe("recordLinksInText — the links a typed / pasted message carries", () => {
  it("finds each record once, in order, and ignores external links", () => {
    const body = `Pls check ${APP}/quotes/Q-1, also /invoices/INV-2 and /quotes/Q-1 again — https://zoho.com/x (ref).`;
    expect(recordLinksInText(body, APP)).toEqual([
      { type: "quote", id: "Q-1" },
      { type: "invoice", id: "INV-2" },
    ]);
  });

  it("caps at 20 (chat_links_ok refuses more)", () => {
    const body = Array.from({ length: 25 }, (_, i) => `/quotes/Q-${i}`).join(" ");
    expect(recordLinksInText(body, APP)).toHaveLength(20);
  });
});

describe("sanitizeChatLinks — a stored link is {type,id} ONLY", () => {
  it("drops extra keys (an amount or a name must never ride along) and unknown/garbled entries", () => {
    const stored = [
      { type: "quote", id: "Q-1", amount: 99999, customer_name: "Acme" },
      { type: "invoice", id: "" },
      { type: "spaceship", id: "X" },
      "Q-1",
      null,
      { type: "invoice", id: "INV-2" },
    ];
    const out = sanitizeChatLinks(stored);
    expect(out).toEqual([{ type: "quote", id: "Q-1" }, { type: "invoice", id: "INV-2" }]);
    for (const l of out) expect(Object.keys(l).sort()).toEqual(["id", "type"]);
    expect(sanitizeChatLinks("nope")).toEqual([]);
    expect(chatLinkKey({ type: "quote", id: "Q-1" })).toBe("quote:Q-1");
  });
});

/** A fake client that records every read and answers with `row`. */
function fakeDb(row: Record<string, unknown> | null) {
  const reads: { table: string; cols: string; id: string }[] = [];
  const db: PreviewDb = {
    from(table: string) {
      return {
        select(cols: string) {
          const q = {
            eq(_c: string, id: string) {
              reads.push({ table, cols, id });
              return q;
            },
            maybeSingle: async () => ({ data: row, error: null }),
          };
          return q;
        },
      };
    },
  };
  return { db, reads };
}

describe("fetchRecordPreview — NO-LEAK: read under the viewer's own access", () => {
  it("a Sales login cannot open invoices: 'Invoice — you don't have access', no amount, and NO database read", async () => {
    expect(viewerMayOpen("sales", "invoice")).toBe(false);
    const { db, reads } = fakeDb({ id: "INV-1", customer_name: "Acme", amount: 118000, status: "sent" });
    const spy = vi.spyOn(db, "from");
    const p = await fetchRecordPreview(db, { type: "invoice", id: "INV-1" }, "sales");
    expect(p).toEqual({ state: "no_access", type: "invoice", id: "INV-1", label: "Invoice", message: "Invoice — you don't have access" });
    expect(JSON.stringify(p)).not.toMatch(/118000|Acme/);
    expect(spy).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
  });

  it("an unknown / still-loading role fails CLOSED (no read)", async () => {
    const { db, reads } = fakeDb({ id: "Q-1", amount: 5 });
    expect((await fetchRecordPreview(db, { type: "quote", id: "Q-1" }, null)).state).toBe("no_access");
    expect((await fetchRecordPreview(db, { type: "quote", id: "Q-1" }, "martian")).state).toBe("no_access");
    expect(reads).toEqual([]);
  });

  it("asks the SAME rule as the menu / route guard (nav.ts canOpenRoute, ROUTE_DENY on top) for every role", () => {
    const page = { quote: "/quotes/Q-1", invoice: "/invoices/INV-1", customer: "/customers/c1",
      subscription: "/subscriptions", lead: "/leads", payment: "/payments" } as const;
    for (const role of USER_ROLES) {
      for (const type of RECORD_LINK_TYPES) {
        expect(viewerMayOpen(role, type), `${role} → ${type}`).toBe(canOpenRoute(role, page[type]));
      }
    }
    expect(viewerMayOpen("owner", "invoice")).toBe(true);
    expect(viewerMayOpen("sales", "lead")).toBe(true);
  });

  it("the owner sees the quote: number, amount, status and the address that opens it", async () => {
    const { db, reads } = fakeDb({ id: "Q-2026-0042", customer_name: "Acme Pvt Ltd", amount: 23600, status: "sent" });
    const p = await fetchRecordPreview(db, { type: "quote", id: "Q-2026-0042" }, "owner");
    expect(p).toEqual({
      state: "ok", type: "quote", id: "Q-2026-0042", label: "Quote",
      title: "Quote Q-2026-0042", subtitle: "Acme Pvt Ltd", amount: 23600, amountText: "₹23,600", status: "Sent", href: "/quotes/Q-2026-0042",
    });
    expect(reads).toEqual([{ table: "quotes", cols: QUOTE_PREVIEW_COLUMNS, id: "Q-2026-0042" }]);
  });

  /* R-2327 (4) — localhost check: the quote card read "₹38,232" (the whole YEAR) while the
     /quotes list read "₹3,186/month" + "₹38,232/year" (R-2222). The card now prints the list's
     own words, from the list's own helpers (quoteRowTotalPeriods + quoteTotalPeriodsText). */
  it("R-2327: an Annual quote paid monthly reads like the /quotes list — ₹3,186/month · ₹38,232/year", async () => {
    const row = {
      id: "Q-F588-27-0068", customer_name: "Acme", amount: 38232, status: "sent", subtotal: 32400, discount_pct: 0,
      tax_rate: 18, billing_cycle: "monthly", line_items: [{ name: "Starter", qty: 10, rate: 3240, commitment: "annual_yearly" }],
      is_add_seats: false, is_one_off: false, is_extension: false, extension_months: null,
    };
    const { db } = fakeDb(row);
    const p = await fetchRecordPreview(db, { type: "quote", id: row.id }, "owner");
    const list = quoteTotalPeriodsText(quoteRowTotalPeriods(row)!);
    expect(list).toEqual({ perBill: "₹3,186", unit: "/month", year: "₹38,232/year" });
    expect(p).toMatchObject({ state: "ok", amount: 38232, amountText: "₹3,186/month · ₹38,232/year" });
    expect((p as { amountText: string }).amountText).toBe(`${list.perBill}${list.unit} · ${list.year}`);
  });

  it("R-2327: a quarterly quote and a yearly quote read like the list too; no amount → no figure", async () => {
    const base = {
      id: "Q-1", customer_name: "Acme", amount: 38232, status: "sent", subtotal: 32400, discount_pct: 0, tax_rate: 18,
      line_items: [{ commitment: "annual_yearly" }], is_add_seats: false, is_one_off: false, is_extension: false, extension_months: null,
    };
    const text = async (over: Record<string, unknown>) =>
      ((await fetchRecordPreview(fakeDb({ ...base, ...over }).db, { type: "quote", id: "Q-1" }, "owner")) as { amountText: string | null }).amountText;
    expect(await text({ billing_cycle: "quarterly" })).toBe("₹9,558/quarter · ₹38,232/year");
    expect(await text({ billing_cycle: "yearly" })).toBe("₹38,232/year");
    expect(await text({ billing_cycle: "monthly", amount: null })).toBeNull();
  });

  it("R-2327: invoice and payment cards print their amount; a customer card has none", async () => {
    const inv = await fetchRecordPreview(fakeDb({ id: "INV-1", customer_name: "Acme", amount: 118000, status: "sent" }).db, { type: "invoice", id: "INV-1" }, "owner");
    expect(inv).toMatchObject({ amountText: "₹1,18,000" });
    const cust = await fetchRecordPreview(fakeDb({ id: "c1", name: "acme" }).db, { type: "customer", id: "c1" }, "owner");
    expect(cust).toMatchObject({ amountText: null });
  });

  it("a row the viewer's RLS hides comes back as 'not found or no access' — no amount", async () => {
    const { db } = fakeDb(null);
    const p = await fetchRecordPreview(db, { type: "invoice", id: "INV-404" }, "owner");
    expect(p).toEqual({ state: "not_found", type: "invoice", id: "INV-404", label: "Invoice", message: "Invoice — not found or you don't have access" });
  });

  it("a customer preview carries no money at all", async () => {
    const { db, reads } = fakeDb({ id: "c1", name: "acme", display_name: "Acme Pvt Ltd", city: "Delhi" });
    const p = await fetchRecordPreview(db, { type: "customer", id: "c1" }, "owner");
    expect(p).toMatchObject({ state: "ok", title: "Acme Pvt Ltd", amount: null, href: "/customers/c1" });
    expect(reads[0].cols).not.toMatch(/amount|balance/);
  });

  it("a payment opens that customer's receipts", async () => {
    const { db } = fakeDb({ id: "p1", amount: 5000, method: "upi", receipt_voucher_no: "RV-12", customer_id: "c9" });
    const p = await fetchRecordPreview(db, { type: "payment", id: "p1" }, "owner");
    expect(p).toMatchObject({ state: "ok", title: "Payment RV-12", amount: 5000, href: "/payments?customer=c9" });
  });

  it("a read error is 'couldn't load', never a guess", async () => {
    const db: PreviewDb = {
      from: () => ({ select: () => { const q = { eq: () => q, maybeSingle: async () => ({ data: null, error: { message: "boom" } }) }; return q; } }),
    };
    expect((await fetchRecordPreview(db, { type: "quote", id: "Q-1" }, "owner")).state).toBe("error");
  });
});
