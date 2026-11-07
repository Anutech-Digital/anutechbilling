// @vitest-environment jsdom
//
// R-1491 (Pawan, staging 17 Oct 2026): on the website's Google Workspace trial form, trying one
// product and then another stacked the WhatsApp messages — the old request's state stayed with
// the new one. Owner's path: pick Business Starter → Request the free trial → Send on WhatsApp →
// "← Change the request" → pick Business Standard → Request again. The second confirmation and
// its WhatsApp text must be built ONLY from Business Standard (replace, never append): no
// Starter line, no old reference as its own number, and no "WhatsApp also opened" note carried
// over from the first request.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/shared/turnstile", () => ({ useTurnstile: () => ({ headers: {}, reset: () => {}, widget: null }) }));

import { TrialForm } from "./TrialForm";

const fetchMock = vi.fn();

beforeEach(() => {
  try { window.localStorage?.clear(); } catch { /* no storage in this jsdom — the form tolerates it */ }
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  let n = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    n += 1;
    return new Response(JSON.stringify({ ok: true, ackSent: false, reference: `Q-TEST-000${n}` }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const field = (label: RegExp) => screen.getAllByLabelText(label)[0] as HTMLInputElement;

function fillDetails() {
  fireEvent.click(screen.getByRole("button", { name: /Continue to details/ }));
  fireEvent.change(field(/^Company/), { target: { value: "Acme Traders" } });
  fireEvent.change(field(/Your name/), { target: { value: "Ramesh Kumar" } });
  fireEvent.change(field(/Domain/), { target: { value: "acme.in" } });
  fireEvent.change(field(/Email — the logins go here/), { target: { value: "ramesh@acme.in" } });
  fireEvent.change(field(/^Mobile/), { target: { value: "98765 43210" } });
}

async function request() {
  fireEvent.click(screen.getAllByRole("button", { name: /Request the free trial/ })[0]);
  await screen.findByRole("link", { name: "Send on WhatsApp" });
}

const waText = () => {
  const href = screen.getByRole("link", { name: "Send on WhatsApp" }).getAttribute("href") ?? "";
  return decodeURIComponent(href.split("?text=")[1] ?? "");
};

describe("R-1491 trial form — changing the product replaces the WhatsApp message", () => {
  it("product A then product B → only B's message, no old state stacked on it", async () => {
    render(<TrialForm />);
    fireEvent.click(screen.getByRole("radio", { name: /Google Workspace Business Starter/ }));
    fillDetails();
    await request();
    expect(waText()).toContain("Edition: Google Workspace Business Starter");
    expect(waText()).toContain("TRIAL REQUEST Q-TEST-0001");
    fireEvent.click(screen.getByRole("link", { name: "Send on WhatsApp" }));
    expect(screen.getByText(/WhatsApp also opened with the request written/)).toBeTruthy();

    // Change the request → pick another Google Workspace product → request again.
    fireEvent.click(screen.getByRole("button", { name: /Change the request/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Google Workspace Business Standard/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue to details/ }));
    await request();

    const text = waText();
    expect(text).toContain("TRIAL REQUEST Q-TEST-0002");
    expect(text).toContain("Edition: Google Workspace Business Standard");
    expect(text).not.toContain("Business Starter");
    expect((text.match(/TRIAL REQUEST/g) ?? []).length).toBe(1);
    // The team is told the first request is void, so only B is set up.
    expect(text).toContain("Replaces my earlier request Q-TEST-0001");
    // The "WhatsApp opened" note belonged to request A — B's WhatsApp was not opened yet.
    expect(screen.queryByText(/WhatsApp also opened with the request written/)).toBeNull();
    expect(screen.getByText(/We confirm the trial length and cap before switching anything on/)).toBeTruthy();

    // The server is told too: the second enquiry names Standard and the request it replaces.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(body.edition).toBe("GW Business Standard");
    expect(body.requirement).toContain("Business Standard");
    expect(body.requirement).not.toContain("Business Starter");
    expect(body.requirement).toContain("Replaces earlier request Q-TEST-0001");
  });

  it("a first request carries no 'replaces' line", async () => {
    render(<TrialForm />);
    fillDetails();
    await request();
    expect(waText()).not.toMatch(/Replaces/);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.requirement).not.toMatch(/Replaces/);
  });
});
