/**
 * Characterization of the drawer's next-step CTA (S35). Every branch of the old inline
 * IIFE, in its original precedence, with the destination it used to navigate to.
 */
import { describe, it, expect } from "vitest";
import { nextActionFor, type NextActionInput } from "./next-action";

const base: NextActionInput = {
  lead: { stage: "contact", enquiry_type: "subscription", project_id: null, contact_phone: "+91 90000 00000" },
  leadProject: null,
  latestQuoteForAction: undefined,
  quoteAgeDays: null,
  threadSummary: { total: 0, latest: null },
  activities: [],
};
const lead = (over: Partial<NextActionInput["lead"]>) => ({ ...base.lead, ...over });
const quote = (over: Partial<NonNullable<NextActionInput["latestQuoteForAction"]>>) => ({ id: "Q-1", status: "sent", ...over });

describe("project leads", () => {
  it("accepted project (active/completed) and not yet won → mark Won", () => {
    const a = nextActionFor({
      ...base,
      lead: lead({ enquiry_type: "project", project_id: "p1" }),
      leadProject: { title: "ERP build", status: "active", total_amount: 250000 },
    })!;
    expect(a.label).toBe("Project accepted · mark Won");
    expect(a.target).toEqual({ kind: "stage", stage: "won" });
    expect(a.hint).toBe(`ERP build · ₹${(250000).toLocaleString("en-IN")}`);
  });

  it("otherwise → open the project quotation, with its status as the hint", () => {
    const a = nextActionFor({
      ...base,
      lead: lead({ enquiry_type: "project", project_id: "p1" }),
      leadProject: { title: "ERP build", status: "quoted", total_amount: 1 },
    })!;
    expect(a.label).toBe("Open project quotation");
    expect(a.target).toEqual({ kind: "go", href: "/projects/p1" });
    expect(a.hint).toBe("ERP build · awaiting acceptance");
  });

  it("a project lead with NO project id falls through to the ordinary rules", () => {
    const a = nextActionFor({ ...base, lead: lead({ enquiry_type: "project", project_id: null }) })!;
    expect(a.label).toBe("Send quote");
  });
});

describe("quote money states outrank everything else", () => {
  it("received → Issue GST invoice", () => {
    const a = nextActionFor({ ...base, latestQuoteForAction: quote({ payment_status: "received", payment_amount: 5900 }), quoteAgeDays: 3 })!;
    expect(a.label).toBe("Issue GST invoice");
    expect(a.target).toEqual({ kind: "go", href: "/quotes/Q-1" });
    expect(a.tone).toBe("emerald");
  });

  it("invoiced → View invoice (opens the INVOICE), or Open quote when no invoice id", () => {
    const a = nextActionFor({ ...base, latestQuoteForAction: quote({ payment_status: "invoiced", invoice_id: "INV-9" }), quoteAgeDays: 1 })!;
    expect(a.label).toBe("View invoice");
    expect(a.target).toEqual({ kind: "go", href: "/invoices/INV-9" });
    const b = nextActionFor({ ...base, latestQuoteForAction: quote({ payment_status: "invoiced", invoice_id: null }), quoteAgeDays: 1 })!;
    expect(b.label).toBe("Open quote");
    expect(b.target).toEqual({ kind: "go", href: "/quotes/Q-1" });
    expect(b.hint).toBe("Already invoiced");
  });

  it("partial → Record remaining payment", () => {
    expect(nextActionFor({ ...base, latestQuoteForAction: quote({ payment_status: "partial" }), quoteAgeDays: 1 })!.label)
      .toBe("Record remaining payment");
  });

  it("draft → Send draft quote, never the age copy", () => {
    const a = nextActionFor({ ...base, latestQuoteForAction: quote({ status: "draft" }), quoteAgeDays: 30 })!;
    expect(a.label).toBe("Send draft quote");
    expect(a.hint).toBe("Not sent yet");
  });

  it("sent and unpaid → Record payment; over 7 days is rose and says chase", () => {
    const fresh = nextActionFor({ ...base, latestQuoteForAction: quote({}), quoteAgeDays: 0 })!;
    expect(fresh.label).toBe("Record payment");
    expect(fresh.hint).toBe("Sent today");
    expect(fresh.tone).toBe("amber");
    const seven = nextActionFor({ ...base, latestQuoteForAction: quote({}), quoteAgeDays: 7 })!;
    expect(seven.tone).toBe("amber");
    const old = nextActionFor({ ...base, latestQuoteForAction: quote({}), quoteAgeDays: 8 })!;
    expect(old.tone).toBe("rose");
    expect(old.hint).toBe("Sent 8d ago · overdue — chase them");
    expect(old.help).toMatch(/Record the payment here/);
  });

  it("a quote with an unknown age falls through to the stage rules", () => {
    expect(nextActionFor({ ...base, latestQuoteForAction: quote({}), quoteAgeDays: null })!.label).toBe("Send quote");
  });
});

describe("no quote — by conversation, then by stage", () => {
  it("lost → re-engage, won → upsell (both send a quote)", () => {
    expect(nextActionFor({ ...base, lead: lead({ stage: "lost" }) })).toMatchObject({ label: "Re-engage · send new quote", target: { kind: "send_quote" } });
    expect(nextActionFor({ ...base, lead: lead({ stage: "won" }) })).toMatchObject({ label: "Upsell · new quote", target: { kind: "send_quote" } });
  });

  it("they wrote last → Reply, above every remaining stage rule (even a brand-new lead)", () => {
    const a = nextActionFor({
      ...base,
      lead: lead({ stage: "new" }),
      threadSummary: { total: 15, latest: { direction: "inbound", at: "2026-09-20T10:00:00Z" } as never },
    })!;
    expect(a.label).toBe("Reply — they are waiting");
    expect(a.target).toEqual({ kind: "email" });
    expect(a.help).toBeUndefined();
  });

  it("new with a phone and NOTHING sent, received or logged → Call now", () => {
    const a = nextActionFor({ ...base, lead: lead({ stage: "new" }) })!;
    expect(a.label).toBe("Call now · first contact");
    expect(a.target).toEqual({ kind: "tel", phone: "+91 90000 00000" });
  });

  it("new but already in touch (thread OR activity) → Send quote, with the reason", () => {
    const viaThread = nextActionFor({
      ...base, lead: lead({ stage: "new" }),
      threadSummary: { total: 2, latest: { direction: "outbound", at: "x" } as never },
    })!;
    expect(viaThread.label).toBe("Send quote");
    expect(viaThread.help).toMatch(/already been in touch/);
    const viaActivity = nextActionFor({ ...base, lead: lead({ stage: "new" }), activities: [{}] })!;
    expect(viaActivity.label).toBe("Send quote");
  });

  it("new with no phone → Send quote (nobody to call)", () => {
    expect(nextActionFor({ ...base, lead: lead({ stage: "new", contact_phone: null }) })!.label).toBe("Send quote");
  });

  it("trial → Convert trial; anything else → Send Quote", () => {
    expect(nextActionFor({ ...base, lead: lead({ stage: "trial" }) })!.label).toBe("Convert trial · send quote");
    expect(nextActionFor({ ...base, lead: lead({ stage: "demo" }) })!.label).toBe("Send quote");
    expect(nextActionFor({ ...base, lead: lead({ stage: "contact" }) })!.target).toEqual({ kind: "send_quote" });
  });
});
