// @vitest-environment jsdom
//
// R-259 — the invoice code field: live preview while editable, read-only once locked.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { InvoiceCodeField, type InvoiceCodeState } from "./invoice-code-field";

afterEach(cleanup);

const open: InvoiceCodeState = { saved: null, code: "3F9A", locked: false, nextNumber: 1, fyYY: "27", preview: "INV-3F9A-27-0001" };

function Harness({ state }: { state: InvoiceCodeState }) {
  const [v, setV] = React.useState("");
  return <InvoiceCodeField id="code" value={v} onChange={setV} state={state} />;
}

describe("R-259 InvoiceCodeField", () => {
  it("typing shrm previews INV-SHRM-27-0001", () => {
    render(<Harness state={open} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "shrm" } });
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("SHRM");
    expect(screen.getByText("INV-SHRM-27-0001")).toBeTruthy();
  });

  it("is read-only after the first invoice", () => {
    render(<Harness state={{ ...open, saved: "SHRM", code: "SHRM", locked: true, nextNumber: 2, preview: "INV-SHRM-27-0002" }} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.disabled).toBe(true);
    expect(input.value).toBe("SHRM");
    expect(screen.getByText(/Locked/)).toBeTruthy();
    expect(screen.getByText("INV-SHRM-27-0002")).toBeTruthy();
  });
});
