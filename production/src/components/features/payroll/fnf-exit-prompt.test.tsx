// @vitest-environment jsdom
/** R-2428 — the "Start exit?" prompt after a full & final: owner sees it prefilled; others get a note. */
import * as React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ role: "owner", exit: null as string | null }));
const info = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info, success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/queries/payroll", () => ({
  useStartEmployeeExit: () => ({ mutate: vi.fn(), isPending: false }),
  useEmployees: () => ({ isLoading: false, data: [{ id: "e-k", name: "Keshav Malik", joining_date: "2026-04-01", exit_date: state.exit }] }),
}));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ isLoading: false, data: { role: state.role } }) }));

import { FnfExitPrompt } from "./fnf-exit-prompt";

const prompt = { employeeId: "e-k", lastDay: "2026-04-16", amount: 19056 };
beforeEach(() => { info.mockClear(); state.role = "owner"; state.exit = null; });
afterEach(cleanup);

describe("R-2428 FnfExitPrompt", () => {
  it("owner: Start exit opens with the F&F date as last day", () => {
    render(<FnfExitPrompt prompt={prompt} onClose={() => {}} />);
    expect(screen.getByText(/Start exit — Keshav Malik/)).toBeTruthy();
    expect(screen.getByText(/Full & final ₹19,056 paid on/)).toBeTruthy();
    expect((screen.getByLabelText(/^Last working day/) as HTMLInputElement).value).toBe("2026-04-16");
  });

  it("accountant: no dialog, a note to ask the owner", () => {
    state.role = "accountant";
    const onClose = vi.fn();
    render(<FnfExitPrompt prompt={prompt} onClose={onClose} />);
    expect(screen.queryByText(/Start exit — /)).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/ask the owner to start their exit/));
    expect(onClose).toHaveBeenCalled();
  });

  it("exit already started: nothing", () => {
    state.exit = "2026-04-16";
    const onClose = vi.fn();
    render(<FnfExitPrompt prompt={prompt} onClose={onClose} />);
    expect(screen.queryByText(/Start exit — /)).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });
});
