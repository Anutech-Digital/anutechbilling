// @vitest-environment jsdom
/**
 * R-1740 — the shared chip + controls. Owner example 1 (Rahul = Friend, Close) through the
 * same editor the contact page, a lead and a customer all use.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mutateAsync = vi.fn().mockResolvedValue("C-RAHUL");
vi.mock("@/lib/queries/contacts", () => ({
  useSetContactRelationship: () => ({ mutateAsync, isPending: false }),
}));

import { RelationshipChip, RelationshipEditor, RelationshipFields } from "./relationship-chip";

afterEach(() => { cleanup(); mutateAsync.mockClear(); });

describe("RelationshipChip", () => {
  it("Friend · Close is pink; Partner with no closeness reads 'Partner · Professional' in blue; unknown is grey", () => {
    render(<>
      <RelationshipChip type="friend" closeness="close" />
      <RelationshipChip type="partner" closeness={null} />
      <RelationshipChip type="unknown" />
    </>);
    expect(screen.getByText("Friend · Close").className).toMatch(/bg-rose-soft/);
    expect(screen.getByText("Partner · Professional").className).toMatch(/bg-indigo-soft/);
    expect(screen.getByText("Unknown").className).toMatch(/bg-paper-2/);
  });
});

describe("RelationshipFields", () => {
  it("closeness buttons are off while the relationship is Unknown; picking Unknown clears closeness", () => {
    const onChange = vi.fn();
    const { rerender } = render(<RelationshipFields type="unknown" closeness={null} onChange={onChange} />);
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<RelationshipFields type="friend" closeness="close" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Close" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("Relationship"), { target: { value: "unknown" } });
    expect(onChange).toHaveBeenLastCalledWith({ type: "unknown", closeness: null });
    // Tapping the chosen closeness again clears it.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onChange).toHaveBeenLastCalledWith({ type: "friend", closeness: null });
  });
});

describe("RelationshipEditor", () => {
  it("Rahul: Unknown → Friend · Close, saved to his contact row", async () => {
    render(<RelationshipEditor contactId="C-RAHUL" type="unknown" closeness={null} personName="Rahul" />);
    fireEvent.click(screen.getByRole("button", { name: /Your relationship with Rahul: Unknown/ }));
    fireEvent.change(await screen.findByLabelText("Relationship"), { target: { value: "friend" } });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ id: "C-RAHUL", relationship_type: "friend", closeness: "close" }));
  });

  it("with nobody to save to, it is only the chip", () => {
    render(<RelationshipEditor contactId={null} type="relative" closeness="close" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Relative · Close")).toBeTruthy();
  });
});
