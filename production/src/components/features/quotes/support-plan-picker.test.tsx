// @vitest-environment jsdom
//
// R-364: on /quotes/[id]/edit a support plan missing from the catalogue showed only a red
// "Not in your catalogue yet" line. An owner/manager now gets "Add to catalog" there, which
// creates the row through the catalogue's own mutation and puts the plan on the quote.
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { Item } from "@/lib/supabase/database.types";

/** Records each save; never throws itself (see the mock below). */
const mutateAsync = vi.fn();
/** Set to make the next save fail the way a refused insert does. */
let failSave: Error | null = null;
vi.mock("@/lib/queries/items", () => ({
  /* The failure is thrown here rather than by the spy: a vi.fn that throws inside a mocked
     module fails the test even when the component catches it (vitest quirk). */
  useCreateItem: () => ({
    mutateAsync: async (input: Record<string, unknown>) => {
      mutateAsync(input);
      if (failSave) throw failSave;
      return { ...input, tenant_id: "fbb976f1-1111-2222-3333-444455556666" };
    },
    isPending: false,
  }),
}));

import { SupportPlanPicker } from "./support-plan-picker";

const TENANT = "fbb976f1-1111-2222-3333-444455556666";
const ACCESS = { tenantId: TENANT, tenantName: "Excel Technologies" };

function row(id: string, over: Partial<Item> = {}): Item {
  return { id, name: id, msrp: 0, wholesale: 0, prices: {}, is_active: true, item_type: "subscription", kind: "main", ...over } as unknown as Item;
}

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); failSave = null; });

describe("support plan picker — Add to catalog (R-364)", () => {
  it("shows Add to catalog only on plans missing from the catalogue", () => {
    /* Standard yearly exists, Enterprise yearly does not. */
    render(
      <SupportPlanPicker
        items={[row(`SUP-STANDARD-YR-${TENANT.replace(/-/g, "")}`, { prices: { annual_total: { msrp: 9_996, wholesale: 0 } } } as never)]}
        onAdd={() => {}}
        catalogAccess={ACCESS}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Add to catalog" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Add to quote" })).toHaveLength(1);
  });

  it("hides the button from a role that cannot edit the catalogue", () => {
    render(<SupportPlanPicker items={[]} onAdd={() => {}} catalogAccess={null} />);
    expect(screen.queryByRole("button", { name: "Add to catalog" })).toBeNull();
    expect(screen.getAllByText(/Ask an owner or manager/i).length).toBe(2);
  });

  it("will not save without a price", () => {
    render(<SupportPlanPicker items={[]} onAdd={() => {}} catalogAccess={ACCESS} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add to catalog" })[0]);
    const dialog = screen.getByRole("dialog");
    const price = within(dialog).getByLabelText(/Price/);
    fireEvent.change(price, { target: { value: "" } });
    const save = within(dialog).getByRole("button", { name: /Add to catalog and quote/ });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(save.closest("form") as HTMLFormElement);
    expect(mutateAsync).not.toHaveBeenCalled();
    fireEvent.change(price, { target: { value: "99.5" } });
    fireEvent.submit(save.closest("form") as HTMLFormElement);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("creates the tenant's row with the prefilled name and price, then adds it to the quote", async () => {
    const onAdd = vi.fn();
    render(<SupportPlanPicker items={[]} onAdd={onAdd} catalogAccess={ACCESS} />);
    /* Yearly is the default cycle; the first missing paid plan is Standard. */
    fireEvent.click(screen.getAllByRole("button", { name: "Add to catalog" })[0]);
    const dialog = screen.getByRole("dialog");
    expect((within(dialog).getByLabelText(/Name/) as HTMLInputElement).value).toBe("Excel Technologies Standard Support (Yearly)");
    expect((within(dialog).getByLabelText(/Price/) as HTMLInputElement).value).toBe("9996");
    fireEvent.click(within(dialog).getByRole("button", { name: /Add to catalog and quote/ }));

    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    const input = mutateAsync.mock.calls[0][0] as Record<string, unknown>;
    expect(input.id).toBe(`SUP-STANDARD-YR-${TENANT.replace(/-/g, "")}`);
    expect("tenant_id" in input).toBe(false);
    expect(input.prices).toEqual({ annual_total: { msrp: 9_996, wholesale: 0 } });
    expect(onAdd.mock.calls[0][0]).toMatchObject({
      item_id: input.id, rate: 9_996, qty: 1, cost: 0, commitment: "annual_yearly",
    });
  });

  it("quotes the price the operator typed, not the default", async () => {
    const onAdd = vi.fn();
    render(<SupportPlanPicker items={[]} onAdd={onAdd} catalogAccess={ACCESS} />);
    fireEvent.click(screen.getByRole("button", { name: "Monthly" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Add to catalog" })[0]);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Price/), { target: { value: "1199" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Add to catalog and quote/ }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect((mutateAsync.mock.calls[0][0] as { msrp: number }).msrp).toBe(1_199);
    expect(onAdd.mock.calls[0][0]).toMatchObject({ rate: 1_199, commitment: "monthly" });
  });

  it("keeps the dialog open and adds nothing when the save fails", async () => {
    const onAdd = vi.fn();
    failSave = new Error("duplicate key");
    render(<SupportPlanPicker items={[]} onAdd={onAdd} catalogAccess={ACCESS} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add to catalog" })[0]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /Add to catalog and quote/ }));
    await new Promise((r) => setTimeout(r, 0));
    expect(mutateAsync).toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
