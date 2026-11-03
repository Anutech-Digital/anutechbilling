// @vitest-environment jsdom
//
// R-2392 — PersonPicker: search your People, pick with mouse or Enter, "+ New contact"
// inline, and (Income / Expense only) a typed name kept as plain text.
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import * as React from "react";

const contacts = [
  { id: "c1", name: "Ramesh", relation: "family", phone: "98100 00000", email: null, pan: null, note: null, archived: false },
  { id: "c2", name: "Anita", relation: "friend", phone: null, email: "anita@example.com", pan: null, note: null, archived: false },
];
const save = { mutateAsync: vi.fn(), isPending: false };
vi.mock("@/lib/queries/personal-contacts", () => ({
  usePersonalContacts: () => ({ data: contacts, isLoading: false }),
  useSavePersonalContact: () => save,
}));

import { PersonPicker, type PersonValue } from "./person-picker";

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => { save.mutateAsync.mockReset(); });
afterEach(cleanup);

function Harness({ allowText, initial = { contactId: null, name: "" }, spy }: { allowText?: boolean; initial?: PersonValue; spy: (v: PersonValue) => void }) {
  const [v, setV] = React.useState<PersonValue>(initial);
  return <PersonPicker id="pp" allowText={allowText} value={v} onChange={(n) => { setV(n); spy(n); }} />;
}

const open = () => fireEvent.click(screen.getByRole("combobox"));
const search = (s: string) => fireEvent.change(screen.getByRole("searchbox", { name: "Search your people" }), { target: { value: s } });

describe("PersonPicker (R-2392)", () => {
  it("lists your people A→Z with relation and phone; a click picks one", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    open();
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names[0]).toMatch(/^Anita/);
    expect(names[1]).toMatch(/^Ramesh.*Family · 98100 00000/);
    fireEvent.click(screen.getByRole("option", { name: /Ramesh/ }));
    expect(spy).toHaveBeenCalledWith({ contactId: "c1", name: "Ramesh" });
    expect(screen.getByRole("combobox").textContent).toContain("Ramesh");
  });

  it("search by phone, Enter picks the first match", () => {
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    open();
    search("9810000");
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search your people" }), { key: "Enter" });
    expect(spy).toHaveBeenCalledWith({ contactId: "c1", name: "Ramesh" });
  });

  it("+ New contact saves the typed name and picks the new person", async () => {
    save.mutateAsync.mockResolvedValue({ id: "c9", name: "Suresh", relation: "other" });
    const spy = vi.fn();
    render(<Harness spy={spy} />);
    open();
    search("Suresh");
    await act(async () => { fireEvent.click(screen.getByRole("option", { name: '+ New contact "Suresh"' })); });
    expect(save.mutateAsync).toHaveBeenCalledWith({ name: "Suresh", relation: "other", phone: null, email: null, pan: null, note: null });
    expect(spy).toHaveBeenCalledWith({ contactId: "c9", name: "Suresh" });
  });

  it("an exact name already in People offers no duplicate '+ New contact'", () => {
    render(<Harness spy={vi.fn()} />);
    open();
    search("ramesh");
    expect(screen.queryByRole("option", { name: /New contact/ })).toBeNull();
  });

  it("allowText: a shop name can be used without adding it; 'No person' clears", () => {
    const spy = vi.fn();
    render(<Harness allowText spy={spy} />);
    open();
    search("Big Bazaar");
    fireEvent.click(screen.getByRole("option", { name: 'Use "Big Bazaar" without adding to People' }));
    expect(spy).toHaveBeenLastCalledWith({ contactId: null, name: "Big Bazaar" });
    expect(screen.getByRole("combobox").textContent).toContain("not in People");
    open();
    fireEvent.click(screen.getByRole("option", { name: "No person" }));
    expect(spy).toHaveBeenLastCalledWith({ contactId: null, name: "" });
  });

  it("an old typed party opens with its name in the search, one click from + New contact", () => {
    render(<Harness spy={vi.fn()} initial={{ contactId: null, name: "Plot buyer" }} />);
    open();
    expect((screen.getByRole("searchbox", { name: "Search your people" }) as HTMLInputElement).value).toBe("Plot buyer");
    expect(screen.getByRole("option", { name: '+ New contact "Plot buyer"' })).toBeDefined();
  });
});
