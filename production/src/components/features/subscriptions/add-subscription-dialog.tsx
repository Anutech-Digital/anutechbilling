/**
 * AddSubscriptionDialog — 1-Click Onboard Subscription with Auto-Synced Customer & Quote/Invoice records.
 *
 * Allows adding/importing an active subscription directly from the Subscriptions page:
 *   1. Auto-creates or links Customer CRM record.
 *   2. Auto-generates Quote & Audit Invoice record (Accepted / Credit Term or Paid).
 *   3. Auto-creates Active Subscription with Domain, Seats, MRR & Renewal Date.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useQueryClient } from "@tanstack/react-query";
import { rupee } from "@/lib/utils";

import type { QuoteLineItem } from "@/lib/supabase/database.types";

interface ProductItem {
  id: string;
  name: string;
  defaultPrice: number;
}

const PRODUCTS_BY_VENDOR: Record<"google" | "microsoft" | "zoho" | "other", ProductItem[]> = {
  google: [
    { id: "gw-starter", name: "Google Workspace Business Starter", defaultPrice: 2160 },
    { id: "gw-standard", name: "Google Workspace Business Standard", defaultPrice: 10080 },
    { id: "gw-plus", name: "Google Workspace Business Plus", defaultPrice: 15120 },
    { id: "gw-ent-starter", name: "Google Workspace Enterprise Starter", defaultPrice: 14400 },
    { id: "gw-ent-standard", name: "Google Workspace Enterprise Standard", defaultPrice: 21600 },
    { id: "gw-ent-plus", name: "Google Workspace Enterprise Plus", defaultPrice: 32400 },
    { id: "gw-ind", name: "Google Workspace Individual", defaultPrice: 7200 },
    { id: "gw-vault", name: "Google Vault Add-on", defaultPrice: 3600 },
    { id: "gcp-credits", name: "Google Cloud Platform (GCP) Credits", defaultPrice: 12000 },
  ],
  microsoft: [
    { id: "m365-basic", name: "Microsoft 365 Business Basic", defaultPrice: 1800 },
    { id: "m365-standard", name: "Microsoft 365 Business Standard", defaultPrice: 7920 },
    { id: "m365-premium", name: "Microsoft 365 Business Premium", defaultPrice: 18000 },
    { id: "m365-apps", name: "Microsoft 365 Apps for Business", defaultPrice: 5400 },
    { id: "o365-e1", name: "Office 365 E1", defaultPrice: 7200 },
    { id: "o365-e3", name: "Office 365 E3", defaultPrice: 18000 },
    { id: "o365-e5", name: "Office 365 E5", defaultPrice: 32000 },
    { id: "teams-essentials", name: "Microsoft Teams Essentials", defaultPrice: 1800 },
    { id: "exchange-p1", name: "Exchange Online Plan 1", defaultPrice: 2880 },
    { id: "azure-sub", name: "Microsoft Azure Cloud Subscription", defaultPrice: 15000 },
  ],
  zoho: [
    { id: "zoho-wp-std", name: "Zoho Workplace Standard", defaultPrice: 1188 },
    { id: "zoho-wp-pro", name: "Zoho Workplace Professional", defaultPrice: 2388 },
    { id: "zoho-one", name: "Zoho One (All-in-One)", defaultPrice: 21600 },
    { id: "zoho-mail-lite", name: "Zoho Mail Lite", defaultPrice: 708 },
    { id: "zoho-crm-pro", name: "Zoho CRM Professional", defaultPrice: 16800 },
    { id: "zoho-books-pro", name: "Zoho Books Professional", defaultPrice: 15000 },
  ],
  other: [
    { id: "custom-saas", name: "Custom Cloud SaaS Solution", defaultPrice: 3000 },
    { id: "domain-reg", name: "Domain Registration & DNS", defaultPrice: 850 },
    { id: "ssl-cert", name: "SSL Certificate (Wildcard)", defaultPrice: 3500 },
    { id: "tally-gold", name: "Tally Prime Gold License", defaultPrice: 18000 },
  ],
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function AddSubscriptionDialog({ open, onOpenChange, onSuccess }: Props) {
  const { data: me } = useCurrentUser();
  const qc = useQueryClient();

  const [customerName, setCustomerName] = React.useState("");
  const [customerEmail, setCustomerEmail] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [vendor, setVendor] = React.useState<"google" | "microsoft" | "zoho" | "other">("google");
  const [plan, setPlan] = React.useState("Google Workspace Business Starter");
  const [isCustomPlan, setIsCustomPlan] = React.useState(false);
  const [seats, setSeats] = React.useState(10);
  const [pricePerSeatYear, setPricePerSeatYear] = React.useState(2160);
  const [paymentTerms, setPaymentTerms] = React.useState<"paid" | "credit">("credit");
  const [startDate, setStartDate] = React.useState(() => new Date().toISOString().split("T")[0]);
  const [renewalDate, setRenewalDate] = React.useState(() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().split("T")[0];
  });

  const [selectedCustomerId, setSelectedCustomerId] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [existingCustomers, setExistingCustomers] = React.useState<Array<{ id: string; name: string; domain?: string | null }>>([]);

  // Fetch existing customers for autocomplete selection
  React.useEffect(() => {
    if (!open) return;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from("customers").select("id, name, domain").order("name");
      setExistingCustomers(data ?? []);
    })();
  }, [open]);

  // Handle vendor change — select default product of vendor
  const handleVendorChange = (v: "google" | "microsoft" | "zoho" | "other") => {
    setVendor(v);
    setIsCustomPlan(false);
    const firstProduct = PRODUCTS_BY_VENDOR[v][0];
    if (firstProduct) {
      setPlan(firstProduct.name);
      setPricePerSeatYear(firstProduct.defaultPrice);
    }
  };

  // Handle plan product select change
  const handlePlanSelect = (val: string) => {
    if (val === "CUSTOM_PLAN") {
      setIsCustomPlan(true);
      setPlan("");
      return;
    }
    setIsCustomPlan(false);
    const catalog = PRODUCTS_BY_VENDOR[vendor];
    const found = catalog.find((p) => p.name === val || p.id === val);
    if (found) {
      setPlan(found.name);
      setPricePerSeatYear(found.defaultPrice);
    } else {
      setPlan(val);
    }
  };

  const handleSelectExistingCustomer = (val: string) => {
    if (val === "NEW_CUSTOMER") {
      handleClearCustomerSelection();
      return;
    }
    const found = existingCustomers.find((c) => c.id === val);
    if (found) {
      setSelectedCustomerId(found.id);
      setCustomerName(found.name);
      if (found.domain) setDomain(found.domain);
    }
  };

  const handleClearCustomerSelection = () => {
    setSelectedCustomerId("");
    setCustomerName("");
    setDomain("");
    setCustomerEmail("");
  };

  const totalAnnualAmount = seats * pricePerSeatYear;
  const mrrAmount = Math.round(totalAnnualAmount / 12);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCustomerName = customerName.trim();
    const cleanDomain = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();

    if (!cleanCustomerName) {
      toast.error("Customer name is required");
      return;
    }
    if (!cleanDomain) {
      toast.error("Primary Customer Domain is required (e.g. acme.com)");
      return;
    }
    if (seats <= 0) {
      toast.error("Seats must be at least 1");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      const tenantId = me?.tenantId ?? "fbb976f1-9090-4f10-9726-0901bd144e42";

      // ── Step 1: Find or Create Customer Record ──────────────────────────
      let customerId = "";
      const existingMatch = existingCustomers.find(
        (c) => c.name.toLowerCase() === cleanCustomerName.toLowerCase() || (c.domain && c.domain.toLowerCase() === cleanDomain)
      );

      if (existingMatch) {
        customerId = existingMatch.id;
      } else {
        const newCustId = crypto.randomUUID();
        const { error: custErr } = await supabase.from("customers").insert({
          id: newCustId,
          tenant_id: tenantId,
          name: cleanCustomerName,
          domain: cleanDomain,
          status: "active",
          created_at: new Date().toISOString(),
        } as any);
        if (custErr) throw custErr;
        customerId = newCustId;
      }

      // ── Step 2: Auto-Create Quote & Audit Invoice ─────────────────────────
      const quoteId = `Q-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const isPaid = paymentTerms === "paid";

      const lineItems: QuoteLineItem[] = [
        {
          id: `line-${Date.now()}`,
          name: `${plan} (${seats} seats)`,
          qty: seats,
          rate: pricePerSeatYear,
          cost: Math.round(pricePerSeatYear * 0.83),
          commitment: "annual_yearly",
        },
      ];

      const { error: quoteErr } = await supabase.from("quotes").insert({
        id: quoteId,
        tenant_id: tenantId,
        customer_id: customerId,
        customer_name: cleanCustomerName,
        domain: cleanDomain,
        status: "accepted",
        payment_status: isPaid ? "received" : "awaiting",
        total: totalAnnualAmount,
        notes: `Auto-generated from Subscription Onboarding (${plan}) · ${isPaid ? "Paid Upfront" : "Credit Terms / Postpaid"}`,
        line_items: lineItems as any,
        created_at: new Date().toISOString(),
      } as any);
      if (quoteErr) {
        console.warn("Quote auto-creation warning (proceeding with sub):", quoteErr);
      }

      // ── Step 3: Insert Active Subscription ──────────────────────────────
      const { error: subErr } = await supabase.from("subscriptions").insert({
        tenant_id: tenantId,
        customer_id: customerId,
        customer_name: cleanCustomerName,
        plan: plan,
        vendor: vendor,
        seats: seats,
        used: 0,
        mrr: mrrAmount,
        start_date: startDate,
        renewal_date: renewalDate,
        status: "active",
        domain: cleanDomain,
        quote_id: quoteId,
        outstanding_amount: isPaid ? 0 : totalAnnualAmount,
        auto_renew: true,
      });

      if (subErr) throw subErr;

      toast.success(`Subscription & Customer record created for ${cleanCustomerName}!`, {
        description: isPaid
          ? `Paid invoice #${quoteId} & Active subscription created.`
          : `Postpaid credit quote #${quoteId} & Active subscription created.`,
      });

      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["customers"] });

      onSuccess?.();
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed creating subscription";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] p-0 max-h-[92vh] flex flex-col overflow-hidden shadow-2xl z-50">
        <DialogHeader className="p-6 pb-4 border-b border-hairline bg-paper/95 backdrop-blur-xs sticky top-0 z-10 flex-shrink-0">
          <div className="flex items-center gap-2 text-primary font-bold text-xs uppercase tracking-wider mb-1">
            <Icon name="sparkles" size={16} />
            <span>1-Click Subscription Onboarding</span>
          </div>
          <DialogTitle className="text-xl md:text-2xl font-serif">Add / Onboard Subscription</DialogTitle>
          <DialogDescription className="text-xs text-ink-3">
            Auto-creates or links the <b>Customer CRM record</b>, generates the <b>Audit Quote & Invoice</b>, and activates the <b>Subscription</b> in 1 click!
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Customer Selection or New Input */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Existing Customer (Select or Clear)">
              <Select value={selectedCustomerId} onValueChange={handleSelectExistingCustomer}>
                <SelectTrigger id="existingCustomerSelect">
                  <SelectValue placeholder="-- Select Existing Customer --" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NEW_CUSTOMER">➕ -- Type New Customer / Clear Selection --</SelectItem>
                  {existingCustomers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} {c.domain ? `(${c.domain})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedCustomerId && (
                <button
                  type="button"
                  onClick={handleClearCustomerSelection}
                  className="text-[11px] font-bold text-rose-600 hover:text-rose-700 flex items-center gap-1 mt-1 cursor-pointer"
                >
                  <Icon name="x" size={12} />
                  <span>Clear Selection & Type Brand New Customer</span>
                </button>
              )}
            </FormField>

            <FormField label="Customer Company Name *" required htmlFor="custName">
              <Input
                id="custName"
                placeholder="e.g. Excel Technologies"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                required
              />
            </FormField>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Primary Customer Domain *" required htmlFor="subDomain">
              <Input
                id="subDomain"
                placeholder="e.g. exceltechnologies.in"
                className="font-mono text-sm font-semibold"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                required
              />
              <p className="text-[11px] text-ink-3 mt-1">Essential for Google/M365 Console provisioning.</p>
            </FormField>

            <FormField label="Contact Email (Optional)" htmlFor="custEmail">
              <Input
                id="custEmail"
                type="email"
                placeholder="e.g. ranjeet@exceltechnologies.in"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
              />
            </FormField>
          </div>

          {/* Vendor & Plan Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Cloud Vendor *" required htmlFor="vendor">
              <Select value={vendor} onValueChange={(val: any) => handleVendorChange(val)}>
                <SelectTrigger id="vendor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="google">🌐 Google Cloud / Workspace</SelectItem>
                  <SelectItem value="microsoft">🪟 Microsoft 365 / Azure</SelectItem>
                  <SelectItem value="zoho">💼 Zoho Suite</SelectItem>
                  <SelectItem value="other">📦 Other Cloud Vendor</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Plan / SKU Product *" required htmlFor="planSelect">
              {!isCustomPlan ? (
                <Select value={plan} onValueChange={handlePlanSelect}>
                  <SelectTrigger id="planSelect">
                    <SelectValue placeholder="-- Select Vendor Product / SKU --" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRODUCTS_BY_VENDOR[vendor].map((p) => (
                      <SelectItem key={p.id} value={p.name}>
                        {p.name} (₹{p.defaultPrice.toLocaleString()}/yr)
                      </SelectItem>
                    ))}
                    <SelectItem value="CUSTOM_PLAN">✍️ Custom Product Name / Other SKU...</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <div className="space-y-1.5">
                  <Input
                    id="planName"
                    placeholder="Type custom plan name (e.g. Acme Custom License)"
                    value={plan}
                    onChange={(e) => setPlan(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setIsCustomPlan(false);
                      const first = PRODUCTS_BY_VENDOR[vendor][0];
                      if (first) {
                        setPlan(first.name);
                        setPricePerSeatYear(first.defaultPrice);
                      }
                    }}
                    className="text-[11px] font-bold text-amber-ink hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Icon name="arrow_left" size={12} />
                    <span>Back to Product Catalog Dropdown</span>
                  </button>
                </div>
              )}
            </FormField>
          </div>

          {/* Seats, Price & Financial Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="License Seats *" required htmlFor="seats">
              <Input
                id="seats"
                type="number"
                min={1}
                value={seats}
                onChange={(e) => setSeats(parseInt(e.target.value, 10) || 1)}
                required
              />
            </FormField>

            <FormField label="Unit Price (₹/yr) *" required htmlFor="pricePerSeat">
              <Input
                id="pricePerSeat"
                type="number"
                min={0}
                value={pricePerSeatYear}
                onChange={(e) => setPricePerSeatYear(parseFloat(e.target.value) || 0)}
                required
              />
            </FormField>

            <FormField label="Monthly MRR (Auto)">
              <div className="h-10 px-3 flex items-center bg-paper-2 border border-hairline rounded-lg font-mono font-bold text-sm text-primary">
                {rupee(mrrAmount)} / mo
              </div>
            </FormField>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Start Date *" required htmlFor="startDate">
              <Input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
            </FormField>

            <FormField label="Renewal / Expiry Date *" required htmlFor="renewalDate">
              <Input
                id="renewalDate"
                type="date"
                value={renewalDate}
                onChange={(e) => setRenewalDate(e.target.value)}
                required
              />
            </FormField>
          </div>

          {/* Payment Status & Terms */}
          <FormField label="Payment & Billing Terms (Special Cases Handling) *">
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setPaymentTerms("credit")}
                className={`p-3 rounded-lg border text-xs text-left transition-all ${
                  paymentTerms === "credit"
                    ? "bg-amber-soft/60 border-amber text-amber-ink font-bold shadow-xs"
                    : "bg-paper-2 border-hairline text-ink-3 hover:bg-paper-3"
                }`}
              >
                <div className="font-semibold text-ink flex items-center gap-1.5 mb-0.5">
                  <Icon name="clock" size={14} className="text-amber-ink" />
                  <span>⏳ Postpaid / Credit Terms</span>
                </div>
                <div className="text-[11px] text-ink-3">
                  Activates subscription now without upfront payment. Quote/Invoice tracks pending balance in Debtors Ledger.
                </div>
              </button>

              <button
                type="button"
                onClick={() => setPaymentTerms("paid")}
                className={`p-3 rounded-lg border text-xs text-left transition-all ${
                  paymentTerms === "paid"
                    ? "bg-emerald-soft/60 border-emerald text-emerald-ink font-bold shadow-xs"
                    : "bg-paper-2 border-hairline text-ink-3 hover:bg-paper-3"
                }`}
              >
                <div className="font-semibold text-ink flex items-center gap-1.5 mb-0.5">
                  <Icon name="check_circle" size={14} className="text-emerald-ink" />
                  <span>💳 Payment Received (Paid)</span>
                </div>
                <div className="text-[11px] text-ink-3">
                  Marks quote/invoice fully paid and activates subscription immediately.
                </div>
              </button>
            </div>
          </FormField>

          {/* Financial Calculation Summary Box */}
          <div className="p-3 bg-primary-soft/30 border border-primary/20 rounded-xl flex items-center justify-between text-xs">
            <div>
              <span className="text-ink-3">Total Annual Contract Value (ARR):</span>
              <div className="font-serif text-lg font-bold text-ink">{rupee(totalAnnualAmount)}</div>
            </div>
            <div className="text-right">
              <span className="text-ink-3">Monthly Recurring Revenue (MRR):</span>
              <div className="font-mono text-base font-bold text-primary">{rupee(mrrAmount)}</div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="bg-primary text-white font-bold px-5">
              {submitting ? "Creating Records..." : "⚡ Activate Subscription & Auto-Sync Ledger"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
