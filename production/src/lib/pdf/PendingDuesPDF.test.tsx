// @vitest-environment jsdom
/* ─────────────────────────────────────────────────────────────────────────────
   R-1526 — Statement of pending dues PDF. The React tree is really built (@react-pdf
   primitives become div/span) and what is printed is read back: every open bill with its
   dates and amount, TOTAL DUE, "not a tax invoice", bank details, and ONE QR only when the
   caller passed one (no UPI ID / non-INR → no QR image at all).
   ───────────────────────────────────────────────────────────────────────────── */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@react-pdf/renderer", () => {
  const strip = ({ children }: { children?: React.ReactNode }) => children;
  const box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const text = ({ children }: { children?: React.ReactNode }) => <span>{children}</span>;
  const link = ({ children, src }: { children?: React.ReactNode; src?: string }) => <a href={src}>{children}</a>;
  return {
    Document: strip, Page: box, View: box, Text: text, Link: link,
    Image: ({ src }: { src?: string }) => <img alt="img" src={src} />,
    StyleSheet: { create: <T,>(x: T) => x },
    Font: { register: () => {}, registerHyphenationCallback: () => {} },
  };
});

import { PendingDuesPDF, STATEMENT_TITLE, type PendingDuesPDFProps } from "./PendingDuesPDF";
import { proformaBank } from "./quote-template";
import type { DuesLine } from "@/lib/collections/pending-dues";

afterEach(cleanup);

const LINES: DuesLine[] = [
  { kind: "invoice", id: "INV-A101", label: "INV-A101", quoteId: null, date: "2026-08-01", dueDate: "2026-08-15", daysOverdue: 63, amountDue: 59000 },
  { kind: "invoice", id: "INV-A140", label: "INV-A140", quoteId: null, date: "2026-10-10", dueDate: "2026-10-25", daysOverdue: -8, amountDue: 11800 },
  { kind: "subscription", id: "s1", label: "Workspace · acme.in", quoteId: "Q-9", date: "2026-09-20", dueDate: "2026-10-01", daysOverdue: 16, amountDue: 1500 },
];

function printed(props: Partial<PendingDuesPDFProps> = {}) {
  const { container } = render(
    <PendingDuesPDF tenantName="Demo Co" tenantGstin="06AAAAA0000A1Z5" customerName="Acme Ltd" asOn="2026-10-17" lines={LINES} total={72300} {...props} />,
  );
  return { text: container.textContent ?? "", imgs: [...container.querySelectorAll("img")].map((i) => i.getAttribute("src")) };
}

describe("PendingDuesPDF", () => {
  it("title, as-on date, every bill with dates + days overdue + amount, and the total", () => {
    const { text } = printed();
    expect(text).toContain(STATEMENT_TITLE);
    expect(text).toContain("Acme Ltd");
    expect(text).toContain("Demo Co");
    for (const n of ["INV-A101", "INV-A140", "Workspace · acme.in"]) expect(text).toContain(n);
    expect(text).toContain("63 days");
    expect(text).toContain("Not yet due");
    expect(text).toMatch(/59,000/);
    expect(text).toMatch(/TOTAL DUE/);
    expect(text).toMatch(/72,300/);
  });

  it("says it is a statement of account, not a tax invoice", () => {
    expect(printed().text).toContain("This is a statement of account, not a tax invoice.");
  });

  it("bank details from the tenant's remit_* fields", () => {
    const bank = proformaBank({ name: "Demo Co", remit_bank_name: "HDFC Bank", remit_account_number: "50200012345678", remit_ifsc: "HDFC0001234" });
    const { text } = printed({ bank });
    expect(text).toContain("50200012345678");
    expect(text).toContain("HDFC0001234");
  });

  it("ONE QR for the total when the caller passes it; none otherwise", () => {
    const withQr = printed({ upiQrDataUrl: "data:image/png;base64,QR", upiVpa: "demo@okhdfcbank" });
    expect(withQr.imgs.filter((s) => s === "data:image/png;base64,QR")).toHaveLength(1);
    expect(withQr.text).toContain("Scan to pay the total");
    expect(withQr.text).toContain("demo@okhdfcbank");

    const none = printed({ upiQrDataUrl: null });
    expect(none.imgs).toHaveLength(0);
    expect(none.text).not.toContain("Scan to pay");
  });

  it("a pay link only when one exists", () => {
    expect(printed().text).not.toContain("Pay online");
    expect(printed({ payLinkUrl: "https://pay.example/x" }).text).toContain("https://pay.example/x");
  });
});
