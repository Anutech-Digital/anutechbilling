// @vitest-environment jsdom
/* R-1998 — Reconcile → Project payment: the project's open instalments, oldest ticked first up to
   the receipt, a TDS line, one Save (R-1910 audit "ONE path"; target 3 clicks).
   Owner's examples: Acme's website project, 3 kists of ₹1,18,000.
     · ₹2,36,000 from "NEFT ACME TRADERS" → Acme's project opens by itself, kist 1 + kist 2 ticked,
       Save sends both to allocate_project_receipt;
     · ₹1,50,000 → kist 1 full + ₹32,000 on kist 2 (part);
     · ₹2,12,400 with ₹23,600 TDS → the sums match only once the TDS is in; Save sends the TDS;
     · ₹4,00,000 → more than everything due: no Save, the advance path (R-1997) is named;
     · an RPC refusal is shown with its hint link. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const state = vi.hoisted(() => ({
  allocate: vi.fn(),
  book: vi.fn(),
  projects: [] as unknown[],
}));

vi.mock("@/lib/queries/project-receipts", () => ({
  useOpenProjects: () => ({ data: state.projects, isLoading: false }),
  useAllocateProjectReceipt: () => ({ mutateAsync: state.allocate, isPending: false }),
  useBookBankCreditAsProjectPayment: () => ({ mutateAsync: state.book, isPending: false }),
  receiptMilestones: () => [],
}));

import { ProjectPaymentSection } from "./project-payment-section";

const ms = (n: number, paid = 0) => ({
  id: `k${n}`, seq: n, label: `Kist ${n}`, total: 118000, paid, remaining: 118000 - paid, invoiceId: null,
});

const customers = [{ id: "c-acme", name: "Acme Traders" }, { id: "c-other", name: "Bharat Steel" }];

function renderFor(amount: number, description = "NEFT CR-ACME TRADERS-UTR77") {
  const onDone = vi.fn();
  render(
    <ProjectPaymentSection
      txn={{ id: "t1", txn_date: "2026-10-20", description, reference: "UTR77" }}
      amount={amount}
      customers={customers}
      customerId=""
      onCustomerChange={() => {}}
      onNewCustomer={() => {}}
      onCancel={() => {}}
      onDone={onDone}
    />,
  );
  return { onDone };
}

const row = (label: string) => screen.getByRole("group", { name: label });
const save = () => screen.getByRole("button", { name: /save & reconcile/i });

beforeEach(() => {
  state.allocate.mockReset().mockResolvedValue({ allocations: [] });
  state.book.mockReset();
  state.projects = [
    { id: "p-other", title: "ERP rollout", customerName: "Bharat Steel", customerId: "c-other", total: 500000, paid: 0, gstRate: 18,
      milestones: [{ ...ms(1), id: "o1", total: 500000, remaining: 500000 }] },
    { id: "p-acme", title: "Website", customerName: "Acme Traders", customerId: "c-acme", total: 354000, paid: 0, gstRate: 18,
      milestones: [ms(1), ms(2), ms(3)] },
  ];
});
afterEach(cleanup);

describe("R-1998 instalment list — FIFO auto-tick", () => {
  it("₹2,36,000: Acme's project opens by itself, kist 1 + kist 2 ticked, Save sends both (3 clicks)", async () => {
    const { onDone } = renderFor(236000);
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("p-acme");
    expect((within(row("Kist 1")).getByRole("checkbox", { name: "Tick Kist 1" }) as HTMLInputElement).checked).toBe(true);
    expect((within(row("Kist 2")).getByRole("checkbox", { name: "Tick Kist 2" }) as HTMLInputElement).checked).toBe(true);
    expect((within(row("Kist 3")).getByRole("checkbox", { name: "Tick Kist 3" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Amount for Kist 2") as HTMLInputElement).value).toBe("118000");
    expect(screen.getByText(/matches/i)).toBeTruthy();

    fireEvent.click(save());
    await waitFor(() => expect(state.allocate).toHaveBeenCalledTimes(1));
    expect(state.allocate.mock.calls[0][0]).toEqual({
      bankTxnId: "t1", projectId: "p-acme",
      allocations: [
        { milestoneId: "k1", amount: 118000, raiseInvoice: true },
        { milestoneId: "k2", amount: 118000, raiseInvoice: true },
      ],
      tds: null, receivedAt: "2026-10-20", reference: "UTR77",
    });
    expect(state.book).not.toHaveBeenCalled();
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it("₹1,50,000: the last kist ticked is part-paid (₹32,000 on kist 2)", () => {
    renderFor(150000);
    expect((screen.getByLabelText("Amount for Kist 1") as HTMLInputElement).value).toBe("118000");
    expect((screen.getByLabelText("Amount for Kist 2") as HTMLInputElement).value).toBe("32000");
    expect((save() as HTMLButtonElement).disabled).toBe(false);
  });

  it("an edited amount that no longer matches the receipt → the gap is shown and Save is off", () => {
    renderFor(236000);
    fireEvent.change(screen.getByLabelText("Amount for Kist 2"), { target: { value: "100000" } });
    expect(screen.getByText(/₹18,000 short/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("R-1998 TDS line", () => {
  it("₹2,12,400 in the bank + ₹23,600 TDS settles kist 1 + kist 2; Save sends the TDS", async () => {
    renderFor(212400);
    fireEvent.click(screen.getByRole("checkbox", { name: /tds deducted/i }));
    fireEvent.change(screen.getByLabelText("TDS amount"), { target: { value: "23600" } });
    expect((screen.getByLabelText("Amount for Kist 1") as HTMLInputElement).value).toBe("118000");
    expect((screen.getByLabelText("Amount for Kist 2") as HTMLInputElement).value).toBe("118000");
    expect(screen.getByText(/matches/i)).toBeTruthy();

    fireEvent.click(save());
    await waitFor(() => expect(state.allocate).toHaveBeenCalledTimes(1));
    expect(state.allocate.mock.calls[0][0].tds).toEqual({ section: "194J", ratePct: 10, amount: 23600 });
    expect(state.allocate.mock.calls[0][0].allocations.map((a: { amount: number }) => a.amount)).toEqual([118000, 118000]);
  });
});

describe("R-1998 more money than is due (D1 — advance is R-1997)", () => {
  it("₹4,00,000 on ₹3,54,000 due: no Save, the extra and the advance path are said", () => {
    renderFor(400000);
    expect(screen.getByText(/₹46,000 more than/)).toBeTruthy();
    expect(screen.getByText(/This money is for → Advance/)).toBeTruthy();
    expect((save() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("R-1998 error from the RPC", () => {
  it("shows the RPC's own message and its hint as a link", async () => {
    state.allocate.mockRejectedValue({
      message: "This bank line is already reconciled (invoice). Un-reconcile it first on Banking if it was matched wrongly, then record the project payment again.",
      hint: "/accounting/banking",
    });
    const { onDone } = renderFor(236000);
    fireEvent.click(save());
    expect(await screen.findByText(/already reconciled \(invoice\)/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Banking" }).getAttribute("href")).toBe("/accounting/banking");
    expect(onDone).not.toHaveBeenCalled();
  });
});

/* R-2004 — owner's localhost check of R-1998: on "NEFT CR-…-SCN ACME WEBSITE CO-KIST 1 AND 2" the owner
   chose "SCN Acme Website Co" in "Who paid?", clicked Project payment → the picker stayed on "Select a
   project…" and also listed Bharat's "SCN Mobile app" (both names share "SCN", and both projects'
   first two kists add up to ₹2,36,000). The customer chosen wins; the picker shows only theirs. */
describe("R-2004 the customer chosen picks the project", () => {
  const scnCustomers = [{ id: "c-acme", name: "SCN Acme Website Co" }, { id: "c-bharat", name: "SCN Bharat Apps" }];
  const scnProjects = () => [
    { id: "p-web", title: "SCN Website", customerName: "SCN Acme Website Co", customerId: "c-acme", total: 354000, paid: 0, gstRate: 18,
      milestones: [ms(1), ms(2), ms(3)] },
    { id: "p-app", title: "SCN Mobile app", customerName: "SCN Bharat Apps", customerId: "c-bharat", total: 236000, paid: 0, gstRate: 18,
      milestones: [{ ...ms(1), id: "b1" }, { ...ms(2), id: "b2" }] },
  ];
  const el = (customerId: string) => (
    <ProjectPaymentSection
      txn={{ id: "t9", txn_date: "2026-10-20", description: "NEFT CR-HDFC0001957-SCN ACME WEBSITE CO-KIST 1 AND 2", reference: "SCN-1" }}
      amount={236000}
      customers={scnCustomers}
      customerId={customerId}
      onCustomerChange={() => {}}
      onNewCustomer={() => {}}
      onCancel={() => {}}
      onDone={() => {}}
    />
  );
  const projectSelect = () => screen.getByLabelText("Project") as HTMLSelectElement;
  const optionTexts = () => Array.from(projectSelect().options).map((o) => o.textContent ?? "");

  beforeEach(() => { state.projects = scnProjects(); });

  it("Acme chosen → SCN Website is selected by itself, kist 1 + 2 ticked, Bharat's project is not listed", () => {
    render(el("c-acme"));
    expect(projectSelect().value).toBe("p-web");
    expect(optionTexts().some((t) => t.includes("SCN Mobile app"))).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Tick Kist 1" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Tick Kist 2" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Tick Kist 3" }) as HTMLInputElement).checked).toBe(false);
  });

  it("customer switched Acme → Bharat → SCN Mobile app is selected, Acme's project leaves the list", () => {
    const { rerender } = render(el("c-acme"));
    expect(projectSelect().value).toBe("p-web");
    rerender(el("c-bharat"));
    expect(projectSelect().value).toBe("p-app");
    expect(optionTexts().some((t) => t.includes("SCN Website"))).toBe(false);
  });

  it("no customer chosen → every open project is listed", () => {
    render(el(""));
    expect(optionTexts().some((t) => t.includes("SCN Website"))).toBe(true);
    expect(optionTexts().some((t) => t.includes("SCN Mobile app"))).toBe(true);
  });

  it("the owner's own project pick stays while the customer stays the same", () => {
    state.projects = [...scnProjects(), { id: "p-seo", title: "SCN SEO", customerName: "SCN Acme Website Co", customerId: "c-acme",
      total: 118000, paid: 0, gstRate: 18, milestones: [{ ...ms(1), id: "s1" }] }];
    const { rerender } = render(el("c-acme"));
    fireEvent.change(projectSelect(), { target: { value: "p-seo" } });
    rerender(el("c-acme"));
    expect(projectSelect().value).toBe("p-seo");
  });

  it("the customer chosen has no open project → New project opens", () => {
    state.projects = [scnProjects()[1]];
    render(el("c-acme"));
    expect(screen.getByRole("tab", { name: /New project/ }).getAttribute("aria-selected")).toBe("true");
  });
});
