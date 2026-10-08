// @vitest-environment jsdom
//
// R-097 — every checkout box and the terms checkbox has a name a screen reader says.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { Field, TermsCheckbox, TERMS_NUDGE_ID } from "./fields";

afterEach(cleanup);
const noop = () => {};

describe("checkout fields (R-097)", () => {
  it("each box is found by its label text (explicit htmlFor + id)", () => {
    render(
      <>
        <Field label="YOUR NAME" value="" onChange={noop} autoComplete="name" />
        <Field id="checkout-email" label="EMAIL — THE GST INVOICE GOES HERE" value="" onChange={noop} type="email" autoComplete="email" />
        <Field label="GSTIN — FOR INPUT CREDIT" value="" onChange={noop} />
      </>,
    );
    const name = screen.getByLabelText("YOUR NAME");
    const email = screen.getByLabelText("EMAIL — THE GST INVOICE GOES HERE");
    const gstin = screen.getByLabelText("GSTIN — FOR INPUT CREDIT");
    expect(name.getAttribute("autocomplete")).toBe("name");
    expect(email.id).toBe("checkout-email");          // the page scrolls to this id
    expect(email.getAttribute("autocomplete")).toBe("email");
    expect(new Set([name.id, email.id, gstin.id]).size).toBe(3);
    expect(document.querySelector(`label[for="${gstin.id}"]`)).toBeTruthy();
  });

  it("two boxes without a fixed id never share one", () => {
    render(
      <>
        <Field label="DOMAIN FOR PLAN A" value="" onChange={noop} />
        <Field label="DOMAIN FOR PLAN B" value="" onChange={noop} />
      </>,
    );
    expect(screen.getByLabelText("DOMAIN FOR PLAN A").id).not.toBe(screen.getByLabelText("DOMAIN FOR PLAN B").id);
  });

  it("typing reports the value", () => {
    let v = "";
    render(<Field label="CITY" value="" onChange={(x) => { v = x; }} />);
    fireEvent.change(screen.getByLabelText("CITY"), { target: { value: "Ludhiana" } });
    expect(v).toBe("Ludhiana");
  });

  it("the terms checkbox is named by its sentence, not 'on'", () => {
    render(
      <TermsCheckbox checked={false} onChange={noop} invalid={false}>
        I have read the <a href="/terms-and-conditions">terms and conditions</a> and the refund policy
      </TermsCheckbox>,
    );
    const box = screen.getByRole("checkbox", { name: /I have read the terms and conditions and the refund policy/ });
    expect(box.getAttribute("aria-invalid")).toBeNull();
    expect(box.getAttribute("aria-describedby")).toBeNull();
  });

  it("ticking it (box or sentence) reports true", () => {
    let ticked = false;
    render(<TermsCheckbox checked={false} onChange={(x) => { ticked = x; }} invalid={false}>I agree</TermsCheckbox>);
    fireEvent.click(screen.getByText("I agree"));
    expect(ticked).toBe(true);
  });

  it("Pay pressed before ticking: marked invalid and pointed at the nudge", () => {
    render(<TermsCheckbox checked={false} onChange={noop} invalid>I agree</TermsCheckbox>);
    const box = screen.getByRole("checkbox", { name: "I agree" });
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(box.getAttribute("aria-describedby")).toBe(TERMS_NUDGE_ID);
  });
});
