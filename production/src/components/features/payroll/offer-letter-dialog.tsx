/**
 * OfferLetterDialog — generate a simple, editable offer letter for an employee.
 *
 * Auto-fills from the employee (name · designation · salary · joining date) and
 * the tenant (company name · address · contact · logo). The owner edits the key
 * fields, then Print / Save-as-PDF. Nothing is sent automatically — it's a
 * document to hand over. The preview uses inline styles so it prints identically
 * (via a hidden iframe — no popup blockers, no app chrome on the page).
 */
"use client";

import * as React from "react";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";

function todayISO() {
  return istToday();
}

const DEFAULT_TERMS =
  "• Your employment is subject to a probation period of 3 months.\n" +
  "• Either party may end the engagement with 30 days' written notice.\n" +
  "• You agree to keep company and customer information confidential.\n" +
  "• This offer is subject to verification of the documents you have submitted.";

export function OfferLetterDialog({
  employee, onClose,
}: {
  employee: { name: string; designation?: string | null; monthly_gross: number; joining_date?: string | null };
  onClose: () => void;
}) {
  const { data: me } = useCurrentUser();
  const printRef = React.useRef<HTMLDivElement>(null);

  const [designation, setDesignation] = React.useState(employee.designation || "Employee");
  const [salary, setSalary] = React.useState(String(employee.monthly_gross || 0));
  const [joining, setJoining] = React.useState(employee.joining_date || todayISO());
  const [letterDate, setLetterDate] = React.useState(todayISO());
  const [terms, setTerms] = React.useState(DEFAULT_TERMS);

  const monthly = Math.max(0, Math.round(Number(salary) || 0));
  const annual = monthly * 12;

  const company = me?.tenantName ?? "Your Company";
  const signer = me?.fullName ?? "Authorised Signatory";

  function handlePrint() {
    const html = printRef.current?.innerHTML;
    if (!html) return;
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow?.document;
    if (!doc) { document.body.removeChild(iframe); return; }
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>Offer Letter — ${employee.name}</title>` +
      `<style>@page{margin:18mm}body{margin:0;font-family:Georgia,'Times New Roman',serif;color:#1a1a1a}</style>` +
      `</head><body>${html}</body></html>`,
    );
    doc.close();
    iframe.contentWindow?.focus();
    setTimeout(() => {
      iframe.contentWindow?.print();
      setTimeout(() => document.body.removeChild(iframe), 1000);
    }, 250);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-3xl p-0 gap-0 flex flex-col max-h-[92vh]">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-hairline flex-row items-center justify-between gap-3 space-y-0">
          <DialogTitle className="text-base">Offer letter — {employee.name}</DialogTitle>
          <Button size="sm" variant="primary" icon="download" onClick={handlePrint} className="mr-8">Print / Save PDF</Button>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {/* Editable fields */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 border-b border-hairline bg-paper-2/30">
            <FormField htmlFor="offer-letter-designation" label="Designation"><Input id="offer-letter-designation" value={designation} onChange={(e) => setDesignation(e.target.value)} /></FormField>
            <FormField htmlFor="offer-letter-monthly-gross" label="Monthly gross (₹)"><Input id="offer-letter-monthly-gross" type="number" min={0} value={salary} onChange={(e) => setSalary(e.target.value)} /></FormField>
            <FormField htmlFor="offer-letter-joining-date" label="Joining date"><Input id="offer-letter-joining-date" type="date" value={joining} onChange={(e) => setJoining(e.target.value)} /></FormField>
            <FormField htmlFor="offer-letter-letter-date" label="Letter date"><Input id="offer-letter-letter-date" type="date" value={letterDate} onChange={(e) => setLetterDate(e.target.value)} /></FormField>
            <div className="sm:col-span-2">
              <FormField htmlFor="offer-letter-terms-conditions" label="Terms &amp; conditions"><Textarea id="offer-letter-terms-conditions" rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} /></FormField>
            </div>
          </div>

          {/* Letter preview — inline styles so print matches exactly. */}
          <div className="p-4 bg-paper-2/40">
            <div ref={printRef} style={{ background: "#fff", maxWidth: 720, margin: "0 auto", padding: "40px 48px", fontFamily: "Georgia, 'Times New Roman', serif", color: "#1a1a1a", fontSize: 14, lineHeight: 1.7, boxShadow: "0 1px 4px rgba(0,0,0,.08)" }}>
              {/* Letterhead */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, borderBottom: "2px solid #1a1a1a", paddingBottom: 12, marginBottom: 20 }}>
                {me?.tenantLogoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={me.tenantLogoUrl} alt="" style={{ height: 44, width: 44, objectFit: "contain" }} />
                )}
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 0.3 }}>{company}</div>
                  <div style={{ fontSize: 11, color: "#555" }}>
                    {[me?.tenantAddress, me?.tenantEmail, me?.tenantPhone].filter(Boolean).join(" · ")}
                    {me?.tenantGstin ? ` · GSTIN ${me.tenantGstin}` : ""}
                  </div>
                </div>
              </div>

              <div style={{ textAlign: "center", fontSize: 15, fontWeight: 700, textDecoration: "underline", margin: "6px 0 18px" }}>
                LETTER OF APPOINTMENT
              </div>

              <div style={{ fontSize: 12, color: "#555", marginBottom: 14 }}>Date: {formatDate(letterDate)}</div>

              <p style={{ margin: "0 0 12px" }}>Dear <b>{employee.name}</b>,</p>

              <p style={{ margin: "0 0 12px" }}>
                We are pleased to offer you the position of <b>{designation}</b> at <b>{company}</b>. Your appointment
                will be effective from <b>{formatDate(joining)}</b>.
              </p>

              <p style={{ margin: "0 0 12px" }}>
                Your gross remuneration will be <b>{rupee(monthly)} per month</b>
                {annual > 0 ? <> (<b>{rupee(annual)} per year</b>, CTC)</> : null}, subject to applicable statutory
                deductions.
              </p>

              {terms.trim() && (
                <>
                  <p style={{ margin: "16px 0 6px", fontWeight: 700 }}>Terms &amp; conditions</p>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{terms}</div>
                </>
              )}

              <p style={{ margin: "16px 0 12px" }}>
                We look forward to welcoming you to the team. Kindly sign and return a copy of this letter to
                confirm your acceptance.
              </p>

              <div style={{ marginTop: 36, display: "flex", justifyContent: "space-between", gap: 24 }}>
                <div>
                  <div style={{ borderTop: "1px solid #1a1a1a", width: 200, paddingTop: 4, fontSize: 12 }}>
                    <b>{signer}</b><br />For {company}
                  </div>
                </div>
                <div>
                  <div style={{ borderTop: "1px solid #1a1a1a", width: 200, paddingTop: 4, fontSize: 12 }}>
                    Accepted by {employee.name}<br />Date: ____________
                  </div>
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-ink-3 mt-3 flex items-center justify-center gap-1">
              <Icon name="info" size={11} /> Edit the fields above — the preview updates instantly. Hand it over using Print / Save PDF.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
