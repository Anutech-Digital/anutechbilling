/**
 * R-1009: the Call / WhatsApp / Email buttons use the value as it is when it is real, and ask
 * the server (once) only when the gateway masked it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { toast } from "sonner";
import { followRevealed, usableContact } from "./reveal-client";

const REF = { table: "leads" as const, id: "33333333-3333-4333-8333-333333333333", field: "contact_phone" };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(toast.error).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("usableContact", () => {
  it("a real number comes straight back — no request (owner / manager)", async () => {
    expect(await usableContact("+91 98765 43210", REF, "call")).toBe("+91 98765 43210");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a masked number is fetched from /api/contacts/reveal", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, value: "+91 98765 43210" }), { status: 200 }));
    expect(await usableContact("••••••••3210", REF, "call")).toBe("+91 98765 43210");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/contacts/reveal");
    expect(JSON.parse(init.body)).toEqual({ ...REF, purpose: "call" });
  });

  it("a refusal shows the server's sentence and gives nothing to dial", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "This lead is not open to you." }), { status: 404 }));
    expect(await usableContact("••••3210", REF, "call")).toBe(null);
    expect(toast.error).toHaveBeenCalledWith("Could not open this contact", { description: "This lead is not open to you." });
  });

  it("no value → null, no request", async () => {
    expect(await usableContact(null, REF, "call")).toBe(null);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("followRevealed", () => {
  it("leaves a real link alone", () => {
    const e = { preventDefault: vi.fn() };
    followRevealed(e, "9876543210", REF, "call", (r) => `tel:${r}`);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops a link to a mask, asks for the real value, then opens the real link", async () => {
    const win = { location: { href: "" }, open: vi.fn() };
    vi.stubGlobal("window", win);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, value: "9876543210" }), { status: 200 }));
    const e = { preventDefault: vi.fn() };
    followRevealed(e, "••••••3210", REF, "call", (r) => `tel:${r}`);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(win.location.href).toBe("tel:9876543210"));
  });
});
