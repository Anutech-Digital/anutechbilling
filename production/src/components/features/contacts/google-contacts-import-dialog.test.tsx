// @vitest-environment jsdom
//
// R-1427: on staging /leads "froze" when /api/contacts/google-fetch answered 410 (contact
// importing is retired). The dialog put the raw code on screen with a "Try again" that
// could only hit the same 410 again. Now: one request, a calm "switched off" note that
// says what to do instead, no retry button, and the dialog closes normally so the leads
// list behind it is usable again.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import GoogleContactsImportDialog from "./google-contacts-import-dialog";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/errors/toast-error", () => ({ toastError: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { signInWithOAuth: vi.fn() } }) }));

const fetchMock = vi.fn();

function respond(status: number, body: string) {
  return Promise.resolve(new Response(body, { status, headers: { "content-type": "application/json" } }));
}

function Harness({ initialOpen = true }: { initialOpen?: boolean }) {
  const [open, setOpen] = React.useState(initialOpen);
  const [qc] = React.useState(() => new QueryClient());
  return (
    <QueryClientProvider client={qc}>
      {/* stands in for the leads list behind the dialog */}
      <ul aria-label="Leads"><li>Asha Traders</li></ul>
      <button type="button" onClick={() => setOpen(true)}>Open import</button>
      <GoogleContactsImportDialog open={open} onOpenChange={setOpen} />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("GoogleContactsImportDialog — Google answers 410 (R-1427)", () => {
  it("asks once, shows a calm 'switched off' note, no retry, no spinner", async () => {
    fetchMock.mockImplementation(() => respond(410, JSON.stringify({ error: "contact_import_retired", message: "retired" })));
    render(<Harness />);

    expect(await screen.findByText(/Import from Google is switched off/i)).toBeTruthy();
    expect(screen.queryByText(/contact_import_retired/)).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(screen.queryByText(/Fetching contacts from Google/i)).toBeNull();

    // give any stray effect a chance to loop — it must not
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("closing the dialog leaves the leads list usable; reopening asks once more, not in a loop", async () => {
    fetchMock.mockImplementation(() => respond(410, ""));
    render(<Harness />);
    await screen.findByText(/Import from Google is switched off/i);

    fireEvent.click(screen.getAllByRole("button", { name: /^close$/i })[0]);
    await waitFor(() => expect(screen.queryByText(/Import from Google is switched off/i)).toBeNull());
    expect(screen.getByText("Asha Traders")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open import" }));
    await screen.findByText(/Import from Google is switched off/i);
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a non-JSON error page is a readable error with one retry button, not a crash", async () => {
    fetchMock.mockImplementation(() => respond(502, "<html>Bad gateway</html>"));
    render(<Harness />);
    expect(await screen.findByText(/Couldn't fetch contacts/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a reply that lands after the dialog closed is ignored", async () => {
    let release: (v: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((r) => { release = r; }));
    render(<Harness />);
    expect(await screen.findByText(/Fetching contacts from Google/i)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /^close$/i })[0]);
    await waitFor(() => expect(screen.queryByText(/Fetching contacts from Google/i)).toBeNull());
    await act(async () => { release(new Response("", { status: 410 })); await Promise.resolve(); });
    expect(screen.queryByText(/Import from Google is switched off/i)).toBeNull();
  });
});
