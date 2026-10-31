// @vitest-environment jsdom
/**
 * R-2302 (G-TEAMCHAT TC-09) — record links, through the R-2299 slot API only.
 *
 * Owner's path: paste a quote's address (or pick it with "Link a record") → a chip shows above
 * the box → Send stores ONLY {type,id} → the message shows "Quote Q-… · ₹… · Sent" that opens
 * the quote. A Sales login reading an invoice link sees "Invoice — you don't have access" and
 * no amount — and its browser never even asks the database for that invoice.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatMember, ChatMessage } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";

const mutate = vi.fn();
vi.mock("@/lib/queries/team-chat", () => ({ usePostChatMessage: () => ({ mutate, isPending: false }) }));

let role: string | null = "owner";
vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: role ? { role, tenantId: "t1", userId: "u1" } : null, isLoading: false }),
}));

/* The viewer's own browser client: every read is recorded. */
const reads: { table: string; id: string }[] = [];
const ROWS: Record<string, Record<string, unknown>> = {
  "quotes:Q-2026-0042": { id: "Q-2026-0042", customer_name: "Acme Pvt Ltd", amount: 23600, status: "sent" },
  "invoices:INV-0007": { id: "INV-0007", customer_name: "Acme Pvt Ltd", amount: 118000, status: "sent" },
};
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => {
        let id = "";
        const q = {
          eq: (_c: string, v: string) => { id = v; reads.push({ table, id: v }); return q; },
          maybeSingle: async () => ({ data: ROWS[`${table}:${id}`] ?? null, error: null }),
        };
        return q;
      },
    }),
  }),
}));

/* Ctrl+K's own search — the picker reuses it. */
const paletteCalls: { query: string; on: Record<string, boolean> }[] = [];
vi.mock("@/lib/queries/palette-search", () => ({
  usePaletteSearch: (query: string, open: boolean, on: Record<string, boolean>) => {
    if (open) paletteCalls.push({ query, on });
    const hit = open && /acme/i.test(query);
    return {
      customers: hit ? [{ id: "c1", name: "acme", display_name: "Acme Pvt Ltd", city: "Delhi" }] : [],
      quotes: hit ? [{ id: "Q-2026-0042", customer_name: "Acme Pvt Ltd", amount: 23600, status: "sent", plan: null }] : [],
      invoices: [], subscriptions: [], contacts: [], payments: [], fetching: false,
    };
  },
}));
vi.mock("@/lib/queries/leads", () => ({ useLeadSearch: () => ({ data: [], isFetching: false }) }));

import { Composer } from "../composer";
import { linksExtension } from "./links";

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ME = "11111111-1111-4111-8111-111111111111";
const TEAMMATES: TeamMember[] = [{ id: ME, full_name: "Pardeep Sharma", email: null, role: "owner", initials: null, color: null }];
const MEMBERS: ChatMember[] = [
  { channel_id: CH, user_id: ME, tenant_id: "t1", joined_at: "2026-10-31T00:00:00Z", last_read_at: null, member_role: "member", notify: "all" },
];
const ext = linksExtension!;
const ORIGIN = window.location.origin;

const wrap = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const renderComposer = () =>
  wrap(<Composer channelId={CH} channelLabel="#general" myUserId={ME} members={MEMBERS} teammates={TEAMMATES} extensions={[ext]} />);
const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const sentLinks = () => mutate.mock.calls.at(-1)![0].links as unknown[];

const message = (links: unknown): ChatMessage =>
  ({
    id: "m1", channel_id: CH, tenant_id: "t1", author_id: ME, body: "see this", kind: "text", parent_id: null,
    mentions: [], links, created_at: "2026-10-31T10:00:00Z", edited_at: null, deleted_at: null, attachments: [],
  }) as unknown as ChatMessage;
const renderMessage = (links: unknown) => {
  const Below = ext.MessageBelow!;
  return wrap(<Below message={message(links)} channelId={CH} myUserId={ME} teammates={TEAMMATES} />);
};

beforeEach(() => { mutate.mockReset(); reads.length = 0; paletteCalls.length = 0; role = "owner"; });
afterEach(() => { cleanup(); });

describe("R-2302 composer: pasted / picked app links become {type,id} links", () => {
  it("is a real extension (not the R-2299 null stub)", () => {
    expect(linksExtension).not.toBeNull();
    expect(ext.id).toBe("links");
    expect(ext.Toolbar).toBeTypeOf("function");
    expect(ext.AboveInput).toBeTypeOf("function");
    expect(ext.MessageBelow).toBeTypeOf("function");
  });

  it("a pasted app address shows a chip, and Send stores ONLY {type,id} — never an amount or a name", async () => {
    renderComposer();
    type(`Pls check ${ORIGIN}/quotes/Q-2026-0042 and https://zoho.com/books`);
    expect(await screen.findByRole("button", { name: "Remove link Quote Q-2026-0042" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(sentLinks()).toEqual([{ type: "quote", id: "Q-2026-0042" }]);
    for (const l of sentLinks()) expect(Object.keys(l as object).sort()).toEqual(["id", "type"]);
    // The composer never read the record: a link is ids only.
    expect(reads).toEqual([]);
  });

  it("removing a chip keeps the text but sends no link", async () => {
    renderComposer();
    type("see /invoices/INV-0007");
    fireEvent.click(await screen.findByRole("button", { name: "Remove link Invoice INV-0007" }));
    expect(screen.queryByRole("button", { name: /Remove link/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(mutate.mock.calls[0][0].body).toBe("see /invoices/INV-0007");
    expect(sentLinks()).toEqual([]);
  });

  it("'Link a record' searches with Ctrl+K's search and a pick writes the record's address + chip", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Link a record" }));
    const search = screen.getByRole("combobox", { name: "Search records to link" });
    fireEvent.change(search, { target: { value: "acme" } });
    const option = await screen.findByRole("option", { name: /Quote Q-2026-0042/ });
    // Only groups this role can open are searched (owner: quotes + invoices on; contacts never).
    const last = paletteCalls.at(-1)!;
    expect(last.query).toBe("acme");
    expect(last.on.contacts).toBe(false);
    fireEvent.click(option);
    expect(box().value).toBe("/quotes/Q-2026-0042 ");
    expect(await screen.findByRole("button", { name: "Remove link Quote Q-2026-0042" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Search records to link" })).toBeNull();
  });

  it("a Sales login's picker does not search invoices at all", async () => {
    role = "sales";
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Link a record" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Search records to link" }), { target: { value: "acme" } });
    await waitFor(() => expect(paletteCalls.some((c) => c.query === "acme")).toBe(true));
    expect(paletteCalls.at(-1)!.on.invoices).toBe(false);
  });
});

describe("R-2302 message: live preview under the READER's own access (NO-LEAK)", () => {
  it("the owner sees the quote's number, amount and status, and the card opens the quote", async () => {
    renderMessage([{ type: "quote", id: "Q-2026-0042" }]);
    const link = await screen.findByRole("link", { name: /Quote Q-2026-0042/ });
    expect(link.getAttribute("href")).toBe("/quotes/Q-2026-0042");
    expect(link.textContent).toContain("₹23,600");
    expect(link.textContent).toContain("Sent");
    expect(reads).toEqual([{ table: "quotes", id: "Q-2026-0042" }]);
  });

  it("a Sales login sees 'Invoice — you don't have access', no amount, and its browser never reads the invoice", async () => {
    role = "sales";
    const { container } = renderMessage([{ type: "invoice", id: "INV-0007" }]);
    expect(await screen.findByText("Invoice — you don't have access")).toBeTruthy();
    expect(container.textContent).not.toMatch(/₹|118|Acme/);
    expect(screen.queryByRole("link")).toBeNull();
    expect(reads).toEqual([]);
  });

  it("a row the reader's RLS hides says 'not found or you don't have access'", async () => {
    renderMessage([{ type: "invoice", id: "INV-HIDDEN" }]);
    expect(await screen.findByText("Invoice — not found or you don't have access")).toBeTruthy();
  });

  it("a stored link with extra keys shows only what the reader's own read returns (never the stored extras)", async () => {
    role = "sales";
    const { container } = renderMessage([{ type: "invoice", id: "INV-0007", amount: 118000, customer_name: "Acme Pvt Ltd" }, { type: "bogus", id: "x" }]);
    expect(await screen.findByText("Invoice — you don't have access")).toBeTruthy();
    expect(container.textContent).not.toMatch(/118|Acme|bogus/);
  });

  it("a message with no links draws nothing", () => {
    const { container } = renderMessage([]);
    expect(container.textContent).toBe("");
  });
});
