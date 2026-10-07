// @vitest-environment jsdom
//
// R-208 (Pardeep's report f05783bf, 6 Oct 2026): after saving a lead the list stays in its
// "needs action" order, so the new lead sank below the overdue ones and nothing said where
// it went. Now, on /leads, saving opens the new lead's drawer (via ?lead=<id>) and the
// toast carries an "Open lead" button for that exact lead. From any other page only the
// toast shows — the user is not yanked off the page they were on.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const push = vi.fn();
const replace = vi.fn();
let pathname = "/leads";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => pathname,
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), dismiss: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const mutateAsync = vi.fn(async () => undefined);
vi.mock("@/lib/queries/leads", () => ({
  useCreateLead: () => ({ mutateAsync, isPending: false }),
  useLeadDuplicateCheck: () => ({ data: [] }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { userId: "u-1" } }) }));
vi.mock("@/components/shared/smart-paste", () => ({ SmartPaste: () => null }));

import { QuickAddLeadForm } from "./quick-add-lead-form";

afterEach(() => {
  cleanup();
  push.mockReset();
  replace.mockReset();
  toastSuccess.mockReset();
  mutateAsync.mockClear();
  pathname = "/leads";
});

async function saveOne(): Promise<string> {
  const onOpenChange = vi.fn();
  render(<QuickAddLeadForm open onOpenChange={onOpenChange} />);
  fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: "98765 43210" } });
  fireEvent.change(screen.getByLabelText(/Company/), { target: { value: "Acme Traders" } });
  fireEvent.click(screen.getByRole("button", { name: "Save lead" }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  const created = (mutateAsync.mock.calls[0] as unknown as [{ id: string }])[0];
  return created.id;
}

describe("QuickAddLeadForm — the saved lead is shown, not buried (R-208)", () => {
  it("on /leads opens the new lead's drawer straight away", async () => {
    const id = await saveOne();
    expect(replace).toHaveBeenCalledWith(`/leads?lead=${encodeURIComponent(id)}`);
  });

  it("toast offers 'Open lead' for that exact lead", async () => {
    pathname = "/lead-gen";
    const id = await saveOne();
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const opts = toastSuccess.mock.calls[0][1] as { action: { label: string; onClick: () => void } };
    expect(opts.action.label).toBe("Open lead");
    opts.action.onClick();
    expect(push).toHaveBeenCalledWith(`/leads?lead=${encodeURIComponent(id)}`);
    // Away from /leads nothing navigates by itself.
    expect(replace).not.toHaveBeenCalled();
  });
});
