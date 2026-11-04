// @vitest-environment jsdom
/**
 * R-2011 (DPDP): the shared data notice — itemised (what data, what for), links to the Privacy
 * policy, your rights and the grievance contact, and a SEPARATE marketing box that starts
 * unticked. The /enquiry form (real component) submits exactly as before with the box empty,
 * plus the consent field; ticked → marketing:true.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DataNotice } from "./DataNotice";
import { DATA_NOTICE_VERSION, MARKETING_OPT_IN_LABEL } from "@/lib/consent/data-notice";
import { legalBlockId } from "./LegalDoc";
import { EnquiryClient } from "@/app/(public)/enquiry/enquiry-client";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness(props: { adultLine?: boolean }) {
  const [v, setV] = React.useState(false);
  return <DataNotice purpose="order" optIn={v} onOptIn={setV} adultLine={props.adultLine} />;
}

describe("DataNotice", () => {
  it("itemised notice with Privacy policy, rights and grievance links; opt-in starts unticked", () => {
    render(<Harness />);
    expect(screen.getByText("How we use your data")).toBeTruthy();
    expect(screen.getByText(/We collect your name, email, mobile/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy policy" }).getAttribute("href")).toBe("/privacy-policy");
    expect(screen.getByRole("link", { name: "Your rights" }).getAttribute("href")).toBe("/privacy-policy#your-rights");
    expect(screen.getByRole("link", { name: "Grievance contact" }).getAttribute("href")).toBe("/privacy-policy#grievances");
    const box = screen.getByRole("checkbox", { name: new RegExp(MARKETING_OPT_IN_LABEL) }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.required).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(screen.queryByTestId("adult-line")).toBeNull();
  });

  it("checkout shows the 18+ line", () => {
    render(<Harness adultLine />);
    expect(screen.getByTestId("adult-line").textContent).toBe("I am 18+ or buying for my business.");
  });

  it("the AI chat shows the notice without an offers box", () => {
    render(<DataNotice purpose="chat" compact />);
    expect(screen.getByText(/what you type/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("the anchors the links point to exist on the privacy policy", () => {
    expect(legalBlockId("Your rights")).toBe("your-rights");
    expect(legalBlockId("Grievances")).toBe("grievances");
  });
});

describe("/enquiry form — real component", () => {
  async function fillAndSend(tick: boolean) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, leadId: "L-1", ackSent: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<EnquiryClient brandName="Anutech" brandPhone={null} brandLogoUrl={null} />);
    const type = (id: string, v: string) => fireEvent.change(document.getElementById(id)!, { target: { value: v } });
    type("fullName", "Rajesh Kumar");
    type("companyName", "Acme Pvt Ltd");
    type("email", "rajesh@example.invalid");
    type("phone", "9876543210");
    type("message", "Need 10 Google Workspace users");
    const box = screen.getByRole("checkbox", { name: new RegExp(MARKETING_OPT_IN_LABEL) }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    if (tick) fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: /Send enquiry/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return { url, body: JSON.parse(String(init.body)) };
  }

  it("box left empty: same request as before + consent marketing:false", async () => {
    const { url, body } = await fillAndSend(false);
    expect(url).toBe("/api/public/enquiry/general");
    expect(body).toMatchObject({ fullName: "Rajesh Kumar", companyName: "Acme Pvt Ltd", email: "rajesh@example.invalid", phone: "9876543210" });
    expect(body.consent).toEqual({ form: "enquiry", noticeVersion: DATA_NOTICE_VERSION, marketing: false });
  });

  it("box ticked: consent marketing:true", async () => {
    const { body } = await fillAndSend(true);
    expect(body.consent).toEqual({ form: "enquiry", noticeVersion: DATA_NOTICE_VERSION, marketing: true });
  });
});
