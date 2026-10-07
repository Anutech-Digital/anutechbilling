/**
 * R-363 — "Enquiries: folder badalne par GET /api/inbound-emails network error" (staging, 6 Oct).
 *
 * Folders are filtered on the client; switching one never calls the API. What the report
 * saw was the 20s poll: (1) the inbox fetch ignored React Query's abort signal, so a fetch
 * that was superseded or left behind on navigation died as a bare "Failed to fetch"
 * instead of a quiet cancel, and (2) the page put "Could not load your enquiries" in place
 * of the WHOLE list on any failed poll — so one blip emptied every folder the user clicked.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_NETWORK_MESSAGE, fetchInboxPage, inboxListView, isAbortError,
} from "./list-load-state";
import { INBOX_NEXT_CURSOR_HEADER } from "@/lib/queries/keyset";

const ID = "00000000-0000-4000-8000-000000000001";

describe("inboxListView", () => {
  it("first load in flight is the skeleton", () => {
    expect(inboxListView({ isLoading: true, error: null, hasData: false })).toEqual({ view: "loading", refreshFailed: false });
  });
  it("nothing ever loaded + an error is the full error state", () => {
    expect(inboxListView({ isLoading: false, error: new Error("x"), hasData: false })).toEqual({ view: "error", refreshFailed: false });
  });
  it("a failed background poll KEEPS the list and only flags the refresh", () => {
    expect(inboxListView({ isLoading: false, error: new Error("x"), hasData: true })).toEqual({ view: "list", refreshFailed: true });
  });
  it("healthy", () => {
    expect(inboxListView({ isLoading: false, error: null, hasData: true })).toEqual({ view: "list", refreshFailed: false });
  });
});

describe("fetchInboxPage", () => {
  it("passes React Query's signal to fetch, so a superseded or abandoned poll is aborted", async () => {
    const f = vi.fn(async () => new Response("[]", { status: 200 }));
    const ctl = new AbortController();
    await fetchInboxPage(null, ctl.signal, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith("/api/inbound-emails", { signal: ctl.signal });
  });

  it("reads rows and the next cursor", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify([{ id: ID }]), {
      status: 200, headers: { [INBOX_NEXT_CURSOR_HEADER]: JSON.stringify({ created_at: "2026-10-01T00:00:00Z", id: ID }) },
    }));
    const page = await fetchInboxPage({ created_at: "2026-10-02T00:00:00Z", id: ID }, undefined, f as unknown as typeof fetch);
    expect(page.rows).toHaveLength(1);
    expect(page.next).toEqual({ created_at: "2026-10-01T00:00:00Z", id: ID });
    expect((f.mock.calls[0] as unknown[])[0]).toMatch(/^\/api\/inbound-emails\?before=/);
  });

  it("a network failure becomes a plain sentence, not 'Failed to fetch'", async () => {
    const f = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    await expect(fetchInboxPage(null, undefined, f as unknown as typeof fetch)).rejects.toThrow(INBOX_NETWORK_MESSAGE);
  });

  it("an aborted request stays an abort (React Query treats it as a cancel, AI Help ignores it)", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const f = vi.fn(async () => { throw new DOMException("aborted", "AbortError"); });
    const err = await fetchInboxPage(null, ctl.signal, f as unknown as typeof fetch).catch((e: unknown) => e);
    expect(isAbortError(err)).toBe(true);
  });

  it("a server error keeps the server's message", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await expect(fetchInboxPage(null, undefined, f as unknown as typeof fetch)).rejects.toThrow("boom");
  });
});

describe("wiring", () => {
  const src = (...p: string[]) => readFileSync(join(process.cwd(), "src", ...p), "utf8");

  it("both inbox hooks hand the signal to the fetch", () => {
    const q = src("lib", "queries", "inbound-emails.ts");
    expect(q).toMatch(/queryFn: \(\{ signal \}\)[^\n]*fetchInboxPage\(null, signal\)/);
    expect(q).toMatch(/queryFn: \(\{ pageParam, signal \}\) => fetchInboxPage\(pageParam, signal\)/);
    expect(q).not.toMatch(/fetch\(`\/api\/inbound-emails\$\{/);
  });

  it("the Enquiries page decides loading/error/list with inboxListView, not `error ?` alone", () => {
    const page = src("app", "(app)", "enquiries", "page.tsx");
    expect(page).toContain("inboxListView(");
    expect(page).not.toMatch(/\) : error \? \(/);
  });
});
