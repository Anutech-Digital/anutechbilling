// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { useForm, useFieldArray } from "react-hook-form";
import { ContactPersonsTable } from "./contact-persons-table";
import type { CustomerFormData } from "./use-customer-form";

afterEach(() => cleanup());

const blank = { salutation: "", first_name: "", last_name: "", email: "", phone: "", mobile: "", designation: "" };
let values: () => CustomerFormData["contact_persons"] = () => [];

function Harness() {
  const { control, register, getValues } = useForm<CustomerFormData>({
    defaultValues: { contact_persons: [{ ...blank, first_name: "Asha" }] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "contact_persons" });
  values = () => getValues("contact_persons");
  return (
    <>
      <ContactPersonsTable fields={fields} register={register} onMakePrimary={() => {}} onRemove={remove} />
      <button type="button" onClick={() => append({ ...blank })}>Add Contact Person</button>
    </>
  );
}

/* R-293: the grid was min-w-[860px] at EVERY width — on a 375px phone the customer form
   scrolled sideways and the row menu (Remove / Make primary) sat off screen. */
describe("ContactPersonsTable — phone layout (R-293)", () => {
  it("is only 860px wide from md up; below md each person is a card", () => {
    render(<Harness />);
    const table = screen.getByRole("table");
    expect(table.className).toContain("md:min-w-[860px]");
    expect(table.className.split(/\s+/)).not.toContain("min-w-[860px]");
    const card = screen.getByTestId("contact-person");
    expect(card.className).toContain("grid");
    expect(card.className).toContain("md:table-row");
    expect(table.querySelector("thead")!.className).toContain("hidden md:table-header-group");
  });

  it("every field has a visible phone label tied to it", () => {
    render(<Harness />);
    for (const name of ["Salutation", "First name", "Last name", "Email address", "Work phone", "Mobile"]) {
      const label = screen.getByText(name, { selector: "label" });
      const input = document.getElementById(label.getAttribute("for")!);
      expect(input, `${name} label points at nothing`).not.toBeNull();
    }
  });

  it("add, edit and remove still work", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add Contact Person" }));
    expect(screen.getAllByTestId("contact-person")).toHaveLength(2);

    const second = document.getElementById("contact_persons_1_email") as HTMLInputElement;
    fireEvent.change(second, { target: { value: "ravi@acme.in" } });
    expect(values()?.[1]?.email).toBe("ravi@acme.in");

    const trigger = screen.getByRole("button", { name: "Contact 1 actions" });
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    await act(async () => { fireEvent.click(await screen.findByRole("menuitem", { name: /Remove/ })); });
    expect(screen.getAllByTestId("contact-person")).toHaveLength(1);
    expect(values()?.[0]?.email).toBe("ravi@acme.in");
  });

  it("the customer form uses it (no second 860px grid left inline)", () => {
    const src = readFileSync("src/components/features/customers/customer-form-page.tsx", "utf8");
    expect(src).toContain("<ContactPersonsTable");
    expect(src).not.toContain("min-w-[860px]");
  });
});
