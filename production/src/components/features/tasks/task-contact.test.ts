import { describe, it, expect } from "vitest";
import { taskContact } from "./task-contact";

describe("R-354 taskContact", () => {
  it("lead phone → tel + wa.me with 91, email kept", () => {
    const c = taskContact({ leads: { company: "Acme", contact_name: "Amit", contact_phone: "98765 43210", contact_email: " amit@acme.in " }, customers: null });
    expect(c).toEqual({
      person: "Amit", phone: "98765 43210", email: "amit@acme.in",
      telHref: "tel:+919876543210", whatsappHref: "https://wa.me/919876543210",
    });
  });

  it("customer contact when there is no lead", () => {
    const c = taskContact({ leads: null, customers: { name: "Beta Ltd", contact_phone: null, contact_email: "a@b.co" } });
    expect(c?.email).toBe("a@b.co");
    expect(c?.telHref).toBeNull();
    expect(c?.whatsappHref).toBeNull();
  });

  it("nothing to show → null; a short number gets no call link", () => {
    expect(taskContact({ leads: null, customers: null })).toBeNull();
    expect(taskContact({ leads: null, customers: { name: "X", contact_phone: " ", contact_email: null } })).toBeNull();
    expect(taskContact({ leads: { company: "Y", contact_phone: "12345" }, customers: null })?.telHref).toBeNull();
  });
});
