// @vitest-environment jsdom
//
// R-2040 — AI Lead Workflow B, the owner's path in the lead drawer: the AI wrote a draft
// (R-2039, run step draft_ready) → the Email tab shows it, "Not sent" → "Review & send" opens the
// lead email composer PRE-FILLED (editable) → "Approve & send" posts to the existing
// /api/leads/[id]/email with the run id → the card shows "Sent". A refused send shows the route's
// reason and the draft stays "Not sent". The wiring below mirrors lead-detail-sheet.tsx.
// fetch is mocked — no email leaves.
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() } }));

import { LeadAiDraftCard, type AiDraft } from "./lead-ai-draft-card";
import { LeadEmailComposer } from "./lead-email-composer";

const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runRow = (step: string) => ({
  id: RUN, step, pitch: "Saw you run 40 mailboxes on cPanel.\nWorth a 10-minute call this week?",
  draft_subject: "Quick idea for Acme", updated_at: "2026-11-01T10:00:00Z",
});

let step = "draft_ready";
let emailReply: { status: number; json: Record<string, unknown> } = { status: 200, json: { ok: true, logged: true, aiRunSent: true } };
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith("/ai-workflow")) return new Response(JSON.stringify({ run: runRow(step) }), { status: 200 });
  if (url.endsWith("/email") && init?.method === "POST") {
    if (emailReply.status === 200 && emailReply.json.aiRunSent) step = "sent";
    return new Response(JSON.stringify(emailReply.json), { status: emailReply.status });
  }
  return new Response("{}", { status: 404 });
});

function Drawer() {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<AiDraft | null>(null);
  return (
    <>
      <LeadAiDraftCard leadId="L1" hasEmail onReview={(d) => { setDraft(d); setOpen(true); }} />
      {open && (
        <LeadEmailComposer open={open} onOpenChange={setOpen} leadId="L1" company="Acme"
          toEmail="buyer@example.invalid" contactName="Ravi" plan={null} senderName="Anutech" draft={draft} />
      )}
    </>
  );
}

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Drawer /></QueryClientProvider>);
}

beforeEach(() => {
  step = "draft_ready";
  emailReply = { status: 200, json: { ok: true, logged: true, aiRunSent: true } };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/* hidden: true — while the modal composer is open, Radix hides the rest of the page from the a11y tree. */
const card = () => screen.getByRole("region", { name: "AI email draft", hidden: true });

describe("R-2040 AI draft → Approve & send", () => {
  it("shows the draft as Not sent, and Review & send opens the composer pre-filled with it", async () => {
    renderDrawer();
    await waitFor(() => expect(within(card()).getByText("Not sent")).toBeTruthy());
    expect(within(card()).getByText("Quick idea for Acme")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review & send/ }));
    expect((screen.getByLabelText(/Subject/) as HTMLInputElement).value).toBe("Quick idea for Acme");
    expect((screen.getByLabelText(/Message/) as HTMLTextAreaElement).value).toBe(runRow("draft_ready").pitch);
    expect(screen.getByRole("button", { name: "Approve & send" })).toBeTruthy();
  });

  it("Approve & send posts the EDITED text + aiRunId to the existing email route; then the card says Sent", async () => {
    renderDrawer();
    await waitFor(() => screen.getByRole("button", { name: /Review & send/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review & send/ }));
    fireEvent.change(screen.getByLabelText(/Message/), { target: { value: "Edited line one.\nEdited line two." } });
    fireEvent.click(screen.getByRole("button", { name: "Approve & send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/leads/L1/email", expect.objectContaining({ method: "POST" })));
    const post = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith("/email") && i?.method === "POST")!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({ subject: "Quick idea for Acme", body: "Edited line one.\nEdited line two.", aiRunId: RUN });

    await waitFor(() => expect(within(card()).getByText("Sent")).toBeTruthy());
    expect(within(card()).queryByRole("button", { name: /Review & send/ })).toBeNull();
    /* the composer closed after the send */
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve & send" })).toBeNull());
  });

  it("a refused send shows the route's reason in the box and the draft stays Not sent", async () => {
    emailReply = { status: 502, json: { error: "Not sent — customer messages are switched off for this company." } };
    renderDrawer();
    await waitFor(() => screen.getByRole("button", { name: /Review & send/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review & send/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve & send" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("customer messages are switched off"));
    expect(within(card()).getByText("Not sent")).toBeTruthy();
    /* the composer stays open with the text, ready to try again */
    expect(screen.getByRole("button", { name: "Approve & send" })).toBeTruthy();
  });

  it("nothing is sent by just opening the lead or the draft (no auto-send)", async () => {
    renderDrawer();
    await waitFor(() => screen.getByRole("button", { name: /Review & send/ }));
    fireEvent.click(screen.getByRole("button", { name: /Review & send/ }));
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith("/email") && i?.method === "POST")).toBe(false);
  });

  it("the plain Email composer (no draft) is unchanged: Send email, no aiRunId", async () => {
    const qc = new QueryClient();
    render(<QueryClientProvider client={qc}>
      <LeadEmailComposer open onOpenChange={() => {}} leadId="L1" company="Acme" toEmail="buyer@example.invalid" contactName="Ravi" plan={null} senderName="Anutech" />
    </QueryClientProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Send email" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]!.body))).not.toHaveProperty("aiRunId");
  });
});
