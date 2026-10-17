// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

import { QuoteBuilder } from "./QuoteBuilder";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("R-1461 quote page: Generate names only what is missing", () => {
  it("items chosen + no contact → contact message only, no 'line', focus on Company, nothing sent", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<QuoteBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Generate quotation" }));
    const msg = screen.getByRole("alert");
    expect(msg.textContent).toBe("Still needed: company, your name, 10-digit mobile and email.");
    expect(msg.textContent).not.toMatch(/line/i);
    expect(document.activeElement).toBe(screen.getByLabelText(/^Company/));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("no items + complete contact → lines message only, focus in the product list", () => {
    render(<QuoteBuilder />);
    // Fill the contact step first.
    fireEvent.click(screen.getByRole("button", { name: /Where to send it/ }));
    fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Acme Pvt Ltd" } });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ravi Kumar" } });
    fireEvent.change(screen.getByLabelText("Mobile"), { target: { value: "98765 43210" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ravi@acme.in" } });
    // Untick the one preselected line.
    fireEvent.click(screen.getByRole("button", { name: /What to quote/ }));
    for (const box of screen.getAllByRole("checkbox")) if (box.getAttribute("aria-checked") === "true") fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Generate quotation" }));
    expect(screen.getByRole("alert").textContent).toBe("Still needed: at least one line.");
    expect(document.activeElement?.getAttribute("role")).toBe("checkbox");
  });

  it("a complete form submits as before (no missing-parts message)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: true, reference: "Q-1" }), { status: 200 }));
    render(<QuoteBuilder />);
    fireEvent.click(screen.getByRole("button", { name: /Where to send it/ }));
    fireEvent.change(screen.getByLabelText("Company"), { target: { value: "Acme Pvt Ltd" } });
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ravi Kumar" } });
    fireEvent.change(screen.getByLabelText("Mobile"), { target: { value: "98765 43210" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ravi@acme.in" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate quotation" }));
    expect(screen.queryByText(/Still needed/)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith("/api/enquiry", expect.objectContaining({ method: "POST" }));
  });
});
