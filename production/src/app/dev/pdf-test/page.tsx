/**
 * /dev/pdf-test — visual regression catalog for the Quote PDF.
 *
 * Each fixture exercises a different angle of the PDF renderer so any
 * change to QuotePDF.tsx can be visually re-validated by clicking through
 * the cases. Grouped into:
 *   • Tenant identity   — full vs minimal vs long name
 *   • Customer          — full contact vs anonymous
 *   • Line items        — single / multi / mixed commitments / many / wrap
 *   • Pricing & GST     — discount / IGST / lakh / crore scale / low tax
 *   • Edge cases        — empty items, long notes, no notes
 *
 * NOT included in production builds — see middleware redirect for /dev/*.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import type { QuotePDFProps } from "@/lib/pdf";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

// ─── Helpers to build line items ──────────────────────────────────────────

let _idCounter = 1;
const nextId = () => `LI-${String(_idCounter++).padStart(3, "0")}`;

function gwStarter(qty: number, commitment: QuoteLineItem["commitment"] = "annual_yearly"): QuoteLineItem {
  return {
    id: nextId(), name: "Google Workspace Business Starter",
    qty, rate: 1632, cost: 1320, commitment,
  };
}
function gwStandard(qty: number, commitment: QuoteLineItem["commitment"] = "annual_yearly"): QuoteLineItem {
  return {
    id: nextId(), name: "Google Workspace Standard",
    qty, rate: 4080, cost: 3300, commitment,
  };
}
function m365Premium(qty: number, commitment: QuoteLineItem["commitment"] = "annual_yearly"): QuoteLineItem {
  return {
    id: nextId(), name: "Microsoft 365 Business Premium",
    qty, rate: 7920, cost: 6480, commitment,
  };
}
function zohoOne(qty: number, commitment: QuoteLineItem["commitment"] = "annual_yearly"): QuoteLineItem {
  return {
    id: nextId(), name: "Zoho One — Enterprise",
    qty, rate: 14400, cost: 11800, commitment,
  };
}

// ─── Tenant identity presets ──────────────────────────────────────────────

const TENANT_FULL = {
  tenantName:    "Demo Co Pvt Ltd",
  tenantGstin:   "27AABCE9876D1Z3",
  tenantEmail:   "pardeep@example.test",
  tenantPhone:   "+91 98765 43210",
  tenantAddress: "Plot 14, Sector 7, Industrial Area, Andheri East, Mumbai 400093",
};

const TENANT_MINIMAL = {
  tenantName:    "Acme Resellers",
  tenantGstin:   null,
  tenantEmail:   null,
  tenantPhone:   null,
  tenantAddress: null,
};

const TENANT_LONG = {
  tenantName:    "Bharat Cloud Solutions & Digital Transformation Services Private Limited",
  tenantGstin:   "29AAACB1234F1Z5",
  tenantEmail:   "billing@bharatcloudsolutions.in",
  tenantPhone:   "+91 80 4567 8901",
  tenantAddress: "12th Floor, Brigade Gateway Tower B, Rajajinagar, Bengaluru, Karnataka 560055, India",
};

// ─── Helpers to compute totals (mirrors QuoteBuilder) ─────────────────────

function totalsFor(opts: {
  lineItems: QuoteLineItem[];
  discountPct?: number;
  taxRate?: number;
}) {
  const { lineItems, discountPct = 0, taxRate = 18 } = opts;
  const subtotal  = lineItems.reduce((s, l) => s + l.qty * l.rate, 0);
  const discount  = Math.round(subtotal * (discountPct / 100));
  const taxable   = subtotal - discount;
  const tax       = Math.round(taxable * (taxRate / 100));
  const total     = taxable + tax;
  return { subtotal, discount, taxable, tax, total };
}

// ─── Test fixture builder ─────────────────────────────────────────────────

type Fixture = {
  id:       string;
  group:    "Tenant" | "Customer" | "Line items" | "Pricing & GST" | "Edge cases";
  title:    string;
  why:      string; // what this exercises
  props:    QuotePDFProps;
};

const fixtures: Fixture[] = [];

function add(f: Omit<Fixture, "id"> & { id?: string }) {
  fixtures.push({ ...f, id: f.id ?? `fx-${fixtures.length + 1}` });
}

// ── Tenant identity ──────────────────────────────────────────────────────

add({
  group: "Tenant", title: "Full tenant identity",
  why: "All optional fields filled — GSTIN, email, phone, address. Baseline visual.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1001",
    customerName: "Acme Corp Pvt Ltd",
    contactName: "Rajesh Kumar", contactEmail: "rajesh@acmecorp.in", contactPhone: "+91 98765 12345",
    validityDays: 30,
    lineItems: [gwStandard(25)],
    ...totalsFor({ lineItems: [gwStandard(25)] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

add({
  group: "Tenant", title: "Minimal tenant (no GSTIN, no address)",
  why: "Brand new reseller signup — only company name filled. Check graceful fallback.",
  props: {
    ...TENANT_MINIMAL,
    quoteId: "Q-2025-26-1002",
    customerName: "First Customer Inc",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 14,
    lineItems: [gwStarter(5)],
    ...totalsFor({ lineItems: [gwStarter(5)] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

add({
  group: "Tenant", title: "Long tenant name + long address",
  why: "Text wrapping in brand header. Header shouldn't break layout.",
  props: {
    ...TENANT_LONG,
    quoteId: "Q-2025-26-1003",
    customerName: "BigCo Industries",
    contactName: "Procurement Head", contactEmail: "procurement@bigco.in", contactPhone: "+91 98765 99999",
    validityDays: 45,
    lineItems: [m365Premium(50)],
    ...totalsFor({ lineItems: [m365Premium(50)] }),
    discountPct: 0, taxRate: 18, interState: true,
    notes: "",
  },
});

// ── Customer ─────────────────────────────────────────────────────────────

add({
  group: "Customer", title: "Customer with all contact info",
  why: "Contact name + email + phone — both monospace lines render?",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1010",
    customerName: "Sharma Consulting Pvt Ltd",
    contactName: "Ananya Sharma", contactEmail: "ananya@sharmaconsulting.in", contactPhone: "+91 98989 12121",
    validityDays: 30, lineItems: [gwStarter(50)],
    ...totalsFor({ lineItems: [gwStarter(50)] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

add({
  group: "Customer", title: "Anonymous customer (no contact)",
  why: "Only company name known — contact lines should be omitted, no layout gaps.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1011",
    customerName: "Unknown Buyer Inc",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 30, lineItems: [gwStarter(10)],
    ...totalsFor({ lineItems: [gwStarter(10)] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

add({
  group: "Customer", title: "Long customer name",
  why: "Wrap behavior of large customer name in 'Bill to' block.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1012",
    customerName: "Maharashtra State Industrial Development Corporation Limited",
    contactName: "MSIDC Procurement Cell", contactEmail: "tenders@msidc.gov.in", contactPhone: "+91 22 2202 6116",
    validityDays: 60, lineItems: [m365Premium(120)],
    ...totalsFor({ lineItems: [m365Premium(120)] }),
    discountPct: 5, taxRate: 18, interState: false,
    notes: "",
  },
});

// ── Line items ───────────────────────────────────────────────────────────

add({
  group: "Line items", title: "Single annual_yearly item",
  why: "Simplest case — no per-invoice math, no commitment unit suffix on totals.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1020",
    customerName: "Single Item Co",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 30, lineItems: [gwStarter(20, "annual_yearly")],
    ...totalsFor({ lineItems: [gwStarter(20, "annual_yearly")] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

const mixedLines = [
  gwStarter(20, "annual_yearly"),
  gwStandard(10, "annual_yearly"),
  m365Premium(5,  "annual_yearly"),
];
add({
  group: "Line items", title: "Multiple lines, all annual_yearly (shared billing)",
  why: "All lines agree on billing → 'Billing schedule' meta shows + grand total /yr.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1021",
    customerName: "Multi-line Industries",
    contactName: "Suresh Patel", contactEmail: "suresh@multiline.in", contactPhone: "+91 98765 33333",
    validityDays: 30, lineItems: mixedLines,
    ...totalsFor({ lineItems: mixedLines }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

const mixedCommitLines = [
  gwStarter(15, "annual_monthly"),
  gwStandard(5,  "annual_yearly"),
  zohoOne(3,    "monthly"),
];
add({
  group: "Line items", title: "Mixed commitments (monthly + yearly + monthly-flex)",
  why: "No shared billing → totals show annual grand only, per-line units differ.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1022",
    customerName: "Mixed Bag Holdings",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 30, lineItems: mixedCommitLines,
    ...totalsFor({ lineItems: mixedCommitLines }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

const manyLines = Array.from({ length: 12 }, (_, i) => ({
  ...gwStarter((i + 1) * 5),
  name: `Add-on Module ${i + 1} — extended feature pack`,
}));
add({
  group: "Line items", title: "12 line items (page-break test)",
  why: "Catalog-style large quote. PDF should not chop a row mid-cell (wrap=false on tr).",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1023",
    customerName: "Catalog Buyer Ltd",
    contactName: "Procurement Bot", contactEmail: "po@catalog.in", contactPhone: null,
    validityDays: 30, lineItems: manyLines,
    ...totalsFor({ lineItems: manyLines }),
    discountPct: 8, taxRate: 18, interState: false,
    notes: "",
  },
});

const longNameLine: QuoteLineItem = {
  id: nextId(),
  name: "Google Workspace Enterprise Standard with Identity Premium, Vault, Endpoint Management & 24/7 Phone Support",
  qty: 50, rate: 9600, cost: 7920, commitment: "annual_yearly",
};
add({
  group: "Line items", title: "Very long product name",
  why: "Description column should wrap, qty/rate/amount stay right-aligned.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1024",
    customerName: "Long Plan Co",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 30, lineItems: [longNameLine],
    ...totalsFor({ lineItems: [longNameLine] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

const bigQty = gwStarter(1000);
add({
  group: "Line items", title: "1000 seats (high qty + lakh-scale amount)",
  why: "Indian number formatting on Qty + Amount (₹16.3L). Tabular-nums alignment.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1025",
    customerName: "BigOrg Solutions",
    contactName: "IT Director", contactEmail: "it@bigorg.in", contactPhone: "+91 98765 55555",
    validityDays: 45, lineItems: [bigQty],
    ...totalsFor({ lineItems: [bigQty] }),
    discountPct: 12, taxRate: 18, interState: false,
    notes: "",
  },
});

// ── Pricing & GST ────────────────────────────────────────────────────────

add({
  group: "Pricing & GST", title: "20% discount",
  why: "Discount row appears in totals with minus + emerald accent.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1030",
    customerName: "Bargain Buyer Inc",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 14, lineItems: [gwStandard(50)],
    ...totalsFor({ lineItems: [gwStandard(50)], discountPct: 20 }),
    discountPct: 20, taxRate: 18, interState: false,
    notes: "",
  },
});

add({
  group: "Pricing & GST", title: "Inter-state (IGST 18%)",
  why: "IGST row (single) instead of CGST + SGST split. 'Place of supply' meta updates.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1031",
    customerName: "Bengaluru Customer Pvt Ltd",
    contactName: "BLR contact", contactEmail: "buyer@blrco.in", contactPhone: "+91 80 1234 5678",
    validityDays: 30, lineItems: [m365Premium(25)],
    ...totalsFor({ lineItems: [m365Premium(25)] }),
    discountPct: 0, taxRate: 18, interState: true,
    notes: "",
  },
});

add({
  group: "Pricing & GST", title: "Lower tax rate (5%) — non-standard",
  why: "GST split halves should still add up exactly (CGST 2.5 + SGST 2.5). Rounding sanity.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1032",
    customerName: "Exempt Industry Ltd",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 30, lineItems: [gwStarter(40)],
    ...totalsFor({ lineItems: [gwStarter(40)], taxRate: 5 }),
    discountPct: 0, taxRate: 5, interState: false,
    notes: "",
  },
});

const crore = zohoOne(500);
add({
  group: "Pricing & GST", title: "Crore-scale total",
  why: "₹85L+ total. Tests rupee() compact formatting + tabular layout under heavy digits.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1033",
    customerName: "Enterprise Megacorp Ltd",
    contactName: "CFO Office", contactEmail: "cfo@megacorp.in", contactPhone: "+91 22 1111 2222",
    validityDays: 60, lineItems: [crore],
    ...totalsFor({ lineItems: [crore] }),
    discountPct: 15, taxRate: 18, interState: true,
    notes: "",
  },
});

// ── Edge cases ───────────────────────────────────────────────────────────

add({
  group: "Edge cases", title: "Empty line items",
  why: "Defensive — should show 'No line items.' placeholder and skip totals block.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1040",
    customerName: "Draft Customer",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 30, lineItems: [],
    ...totalsFor({ lineItems: [] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

add({
  group: "Edge cases", title: "With long multi-paragraph notes",
  why: "Notes block renders with wrap; should not push footer off the page.",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1041",
    customerName: "Notes Heavy Buyer",
    contactName: "Detail Demander", contactEmail: "detail@notes.in", contactPhone: "+91 99999 88888",
    validityDays: 30, lineItems: [gwStandard(15)],
    ...totalsFor({ lineItems: [gwStandard(15)] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes:
      "1. Onboarding includes complete DNS / MX / SPF / DKIM / DMARC setup at no extra charge.\n" +
      "2. Two live training sessions (60 min each) for end users + one admin handover session.\n" +
      "3. Three months priority email support post go-live; phone support during business hours (10am–7pm IST, Mon–Fri).\n" +
      "4. Quote price assumes intra-state supply with full input tax credit eligibility. Any change in tax structure will be passed through.\n" +
      "5. Migration from existing email (POP/IMAP) included for up to 5 GB per mailbox. Beyond that, ₹250/GB.\n" +
      "6. Payment via Razorpay (auto), NEFT (T+1), or UPI accepted.",
  },
});

add({
  group: "Edge cases", title: "Validity 7 days (urgency)",
  why: "Short validity — date math correct (created today + 7d).",
  props: {
    ...TENANT_FULL,
    quoteId: "Q-2025-26-1042",
    customerName: "Quick Decision Inc",
    contactName: null, contactEmail: null, contactPhone: null,
    validityDays: 7, lineItems: [gwStarter(10)],
    ...totalsFor({ lineItems: [gwStarter(10)] }),
    discountPct: 0, taxRate: 18, interState: false,
    notes: "",
  },
});

// ─── Page component ───────────────────────────────────────────────────────

export default function PdfTestPage() {
  const [downloading, setDownloading] = React.useState<string | null>(null);
  const groups = ["Tenant", "Customer", "Line items", "Pricing & GST", "Edge cases"] as const;

  const handleDownload = async (fx: Fixture) => {
    setDownloading(fx.id);
    try {
      const { downloadQuotePDF } = await import("@/lib/pdf");
      await downloadQuotePDF(fx.props);
      toast.success(`Downloaded ${fx.props.quoteId}.pdf`);
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadAll = async () => {
    setDownloading("__all__");
    try {
      const { downloadQuotePDF } = await import("@/lib/pdf");
      for (const fx of fixtures) {
        await downloadQuotePDF(fx.props);
        // Small delay so the browser doesn't refuse the rapid-fire downloads
        await new Promise((r) => setTimeout(r, 250));
      }
      toast.success(`${fixtures.length} PDFs downloaded`);
    } catch (err) {
      toast.error(`Bulk failed: ${(err as Error).message}`);
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Dev tools</p>
          <h1 className="font-serif text-3xl">Quote PDF — visual catalog</h1>
          <p className="text-sm text-ink-3 mt-1">
            {fixtures.length} fixtures across {groups.length} angles. Click any
            "Download" to generate that scenario&apos;s PDF.
          </p>
        </div>
        <Button
          icon="download"
          loading={downloading === "__all__"}
          onClick={handleDownloadAll}
        >
          Download all {fixtures.length} PDFs
        </Button>
      </div>

      {/* Grouped fixtures */}
      {groups.map((g) => {
        const items = fixtures.filter((f) => f.group === g);
        if (items.length === 0) return null;
        return (
          <section key={g} className="mb-8">
            <div className="mb-3 flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-ink uppercase tracking-wider">{g}</h2>
              <span className="text-xs text-ink-3">{items.length} fixture{items.length === 1 ? "" : "s"}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((fx) => (
                <Card key={fx.id} className="p-4 flex flex-col gap-3">
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <p className="text-sm font-semibold text-ink leading-tight">{fx.title}</p>
                      <Badge kind="muted">{fx.props.quoteId.split("-").slice(-1)[0]}</Badge>
                    </div>
                    <p className="text-2xs text-ink-3 leading-snug">{fx.why}</p>
                  </div>

                  {/* Mini fact sheet */}
                  <div className="text-2xs text-ink-2 space-y-0.5 bg-paper-2 rounded-md p-2.5">
                    <FactRow label="Tenant" value={fx.props.tenantName} />
                    <FactRow label="Customer" value={fx.props.customerName} />
                    <FactRow label="Lines" value={`${fx.props.lineItems.length}`} />
                    <FactRow label="Total" value={rupee(fx.props.total)} mono />
                    <FactRow
                      label="GST"
                      value={`${fx.props.taxRate}% ${fx.props.interState ? "IGST" : "CGST+SGST"}`}
                    />
                    {fx.props.discountPct > 0 && (
                      <FactRow label="Discount" value={`${fx.props.discountPct}%`} />
                    )}
                  </div>

                  <Button
                    size="sm"
                    icon="download"
                    loading={downloading === fx.id}
                    disabled={downloading !== null && downloading !== fx.id}
                    onClick={() => handleDownload(fx)}
                  >
                    Download {fx.props.quoteId}.pdf
                  </Button>
                </Card>
              ))}
            </div>
          </section>
        );
      })}

      <div className="mt-8 p-4 bg-amber-soft border border-amber/40 rounded-md text-xs text-amber-ink flex items-start gap-2">
        <Icon name="info" size={14} className="flex-shrink-0 mt-0.5" />
        <div>
          <b>How to use this catalog:</b> Open each PDF in your viewer and compare against
          the&nbsp;<code className="font-mono">why</code> description on each card. Anything that
          looks broken or unprofessional → tell me which fixture name + what&apos;s wrong, and
          I&apos;ll fix it in <code className="font-mono">QuotePDF.tsx</code>. This page is
          dev-only (not in production builds).
        </div>
      </div>
    </div>
  );
}

function FactRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-3">{label}</span>
      <span className={mono ? "font-mono tabular-nums" : "truncate text-right"} title={value}>
        {value}
      </span>
    </div>
  );
}
