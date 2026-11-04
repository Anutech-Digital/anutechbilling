// @vitest-environment jsdom
/**
 * R-2176 (GP-10c, G-PERSONAL; decision on the card): a PERSONAL user's Help → Report a problem
 * goes to the support desk as a ticket (free support plan) — POST /api/personal/support-ticket —
 * never into `feedback` (refused by the personal data gateway, R-2125). The person sees the
 * ticket number; a refusal (desk not set up for them yet) is shown as it is, text kept.
 * Business users are unchanged (useSubmitFeedback → `feedback`).
 * And the personal bell has no "All tasks" link (/tasks is a business page).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const { me, mutateAsync, toast } = vi.hoisted(() => ({
  me: { data: {} as Record<string, unknown>, isLoading: false },
  mutateAsync: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/vault/personal", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => me }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync, isPending: false }) }));
vi.mock("sonner", () => ({ toast }));
vi.mock("./help-report-matches", () => ({ HelpReportMatches: () => null }));
vi.mock("@/lib/queries/tasks", () => ({ useTasks: () => ({ data: [], isLoading: false }) }));
vi.mock("@/lib/queries/leads", () => ({ useRecentLeads: () => ({ data: [], isLoading: false }) }));
vi.mock("@/lib/queries/contacts", () => ({ useCelebrations: () => ({ data: [], isLoading: false }) }));
vi.mock("@/lib/queries/notifications", () => ({
  useNotifications: () => ({ data: [], isLoading: false }),
  useMarkNotificationRead: () => ({ mutate: vi.fn() }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn() }),
}));

import { HelpReportTab } from "./help-report-tab";
import { NotificationPanel } from "@/components/layout/notification-panel";

const PERSONAL = { tenantId: "pt", userId: "u1", role: "personal", fullName: "Asha", authEmail: "asha@example.test" };
const OWNER = { tenantId: "t1", userId: "u2", role: "owner", fullName: "O", authEmail: "o@x.in" };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  mutateAsync.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const onFiled = vi.fn();
function renderTab() {
  return render(<HelpReportTab pathname="/vault/personal/banking" getTrail={() => []} caughtError={null} onCaughtErrorUsed={() => {}} onFiled={onFiled} />);
}
function typeAndSubmit(text: string) {
  fireEvent.change(screen.getByLabelText("What went wrong?"), { target: { value: text } });
  fireEvent.submit(screen.getByTestId("help-report-form"));
}

describe("Help → Report a problem, personal session (R-2176)", () => {
  it("submits to the support desk, not `feedback`, and shows the ticket number", async () => {
    me.data = PERSONAL;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ticketId: "TKT-ABC-1F" }), { status: 200 }));
    renderTab();
    typeAndSubmit("Balance shows 0");
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/personal/support-ticket");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ type: "bug", severity: "medium", pagePath: "/vault/personal/banking" });
    expect(JSON.parse(String((init as RequestInit).body)).text).toContain("Balance shows 0");
    expect(String(toast.success.mock.calls[0][0]) + JSON.stringify(toast.success.mock.calls[0][1])).toContain("TKT-ABC-1F");
    expect(onFiled).toHaveBeenCalled();
  });

  it("a refusal is shown as the server said it, and the text stays for a retry", async () => {
    me.data = PERSONAL;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Your free support desk is not set up yet, so this report was NOT sent.", code: "NOT_LINKED" }), { status: 409 }));
    renderTab();
    typeAndSubmit("Balance shows 0");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(String(toast.error.mock.calls[0][0])).toMatch(/NOT sent/);
    expect((screen.getByLabelText("What went wrong?") as HTMLTextAreaElement).value).toBe("Balance shows 0");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("no network → honest error, nothing claimed", async () => {
    me.data = PERSONAL;
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    renderTab();
    typeAndSubmit("x");
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(JSON.stringify(toast.error.mock.calls[0])).toMatch(/NOT sent/);
  });

  it("says where it goes, and offers no business-only extras (AI write-up, screenshots, Admin → Feedback)", () => {
    me.data = PERSONAL;
    renderTab();
    expect(screen.getByTestId("help-report-attached").textContent).toMatch(/support team/i);
    expect(screen.getByTestId("help-report-attached").textContent).not.toMatch(/Admin → Feedback/);
    expect(screen.queryByText("Write it up with AI")).toBeNull();
    expect(screen.queryByLabelText("Take a screenshot of this page")).toBeNull();
    expect(screen.queryByLabelText("Attach an image")).toBeNull();
    expect((screen.getByLabelText("What went wrong?") as HTMLTextAreaElement).placeholder).not.toMatch(/screenshot/i);
  });
});

describe("Help → Report a problem, business session (unchanged)", () => {
  it("still goes to `feedback` through useSubmitFeedback, no support-ticket call", async () => {
    me.data = OWNER;
    mutateAsync.mockResolvedValue({ failedUploads: [], triaged: true });
    renderTab();
    expect(screen.getByText("Write it up with AI")).toBeTruthy();
    typeAndSubmit("Invoice PDF blank");
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/personal/support-ticket", expect.anything());
  });
});

describe("the bell footer (R-2176)", () => {
  it("personal: no 'All tasks' link", () => {
    me.data = PERSONAL;
    render(<NotificationPanel open onOpenChange={() => {}} />);
    expect(screen.queryByText("All tasks")).toBeNull();
  });
  it("business: 'All tasks' stays", () => {
    me.data = OWNER;
    render(<NotificationPanel open onOpenChange={() => {}} />);
    expect(screen.getByText("All tasks")).toBeTruthy();
  });
});
