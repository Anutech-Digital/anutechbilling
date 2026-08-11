/**
 * QuoteBuilder — clean redesign matching prototype pattern.
 *
 * Layout:
 *   - Page head with quote ID + serif title + action buttons
 *   - 2-col cards: Customer Details | Quote Settings
 *   - Line Items card: header with "Add item" button → opens modal
 *     - Table: Description / HSN / Qty (inline editable) / Rate / Amount / [delete]
 *     - Totals sidebar (right) inside same card: subtotal / discount / tax / grand total
 *   - Bottom action row: Duplicate / Email / WhatsApp / Finalize
 */
"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Button, IconButton } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MarginPill, computeMargin } from "@/components/features/margin-pill";
import { GeminiCard } from "@/components/shared/gemini-card";
import { AddLineItemDialog } from "@/components/features/quotes/add-line-item-dialog";
import { BulkDomainsDialog } from "@/components/features/quotes/bulk-domains-dialog";
import { ViewDomainsDialog } from "@/components/features/quotes/view-domains-dialog";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { useCustomers } from "@/lib/queries/customers";
import { CustomerCombobox } from "@/components/features/customers/customer-combobox";
import { AddCustomerForm } from "@/components/features/customers/add-customer-form";
import { useCreateQuote, useQuote } from "@/lib/queries/quotes";
import { useGenerateInvoice } from "@/lib/queries/invoices";
import { useUpdateLead, useLeads } from "@/lib/queries/leads";
import { useItems } from "@/lib/queries/items";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isInterStateSupply, isExportSupply } from "@/lib/gst/place-of-supply";
import { COUNTRIES } from "@/lib/gst/countries";
import { BILLING_CURRENCIES, isForeignCurrency, formatForeign } from "@/lib/currency";
import { addOrMergeLine } from "@/lib/quotes/line-items";
import { rupee, formatDate, GST_STATE_BY_CODE } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { QuoteLineItem, LineCommitment, BillingCycle } from "@/lib/supabase/database.types";
import {
  BILLING_CYCLE_OPTIONS, cycleInvoicesPerYear, cycleUnitLabel,
} from "@/lib/quotes/billing";

// Quote IDs are allocated at SAVE time via the central document-numbering RPC
// (see migration 0004_document_series.sql) — this guarantees sequential per-tenant
// per-fiscal-year numbering, race-safe, and no wasted numbers from abandoned drafts.
// Before save, the UI shows a placeholder.

// Plan → monthly price per seat (same map used in Add Lead form).
// Cost approximated at 70% of rate (≈30% reseller margin); user can edit per line.
const PLAN_PRICE_PER_SEAT_PM: Record<string, number> = {
  "Google Workspace Business Starter": 136,
  "Google Workspace Standard":         736,
  "Google Workspace Plus":            1380,
  "Google Workspace Enterprise":      2000,
  "Microsoft 365 Business Basic":      145,
  "Microsoft 365 Business Standard":   735,
  "Microsoft 365 Business Premium":   1470,
  "Zoho Workplace Standard":           105,
  "Zoho Workplace Professional":       315,
  "Plus + Voice add-on":              1800,
};

export function QuoteBuilder() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const { data: customers, isLoading: customersLoading } = useCustomers();
  // Subscription quotes only pull recurring items — one-time products live in
  // the separate Items Catalog and are quoted via project quotes.
  const { data: allCatalog } = useItems();
  const catalog = React.useMemo(() => (allCatalog ?? []).filter((c) => c.item_type !== "one_time"), [allCatalog]);
  const { data: currentUser } = useCurrentUser();
  const createQuote     = useCreateQuote();
  const generateInvoice = useGenerateInvoice();
  const updateLead = useUpdateLead();

  // Lead pre-fill context (when navigated from Lead Detail → Send Quote).
  // When leadId is present, we're in "lead mode" — quote belongs to a prospect,
  // not a paying customer. Customer record will be created only after payment.
  //
  // Accept both `?lead=` (short, easier for operators to type/share) and
  // `?leadId=` (legacy, built by lead drawer Send Quote button).
  const leadId      = searchParams.get("leadId") || searchParams.get("lead");
  // The lead drawer "Send Quote" button supplies these chained params for
  // instant prefill without a network round-trip. We also support the
  // shortcut form (`?lead=L-XXX` alone) by falling back to a useLeads()
  // lookup below.
  const urlCompany  = searchParams.get("company");
  const urlPlan     = searchParams.get("plan");
  const urlSeats    = searchParams.get("seats");
  const urlContact  = searchParams.get("contact");
  const urlEmail    = searchParams.get("email");
  const urlPhone    = searchParams.get("phone");
  // Duplicate / revise an existing quote ("edit & resend" workflow)
  const duplicateOf       = searchParams.get("duplicate");
  // Edit an existing DRAFT quote in place (?edit=<id>) — distinct from
  // duplicate above: duplicate copies into a brand-new id, this reuses the
  // same id so saving updates the existing row instead of creating another
  // one (useCreateQuote already falls back to UPDATE when the id collides —
  // see its comment — so no new mutation was needed for this).
  const editOf            = searchParams.get("edit");
  const { data: editQuote } = useQuote(editOf ?? undefined);
  const urlCustomer       = searchParams.get("customer");  // Customer 360 → "Add service"
  // Invoice mode (?invoice=1): the same builder, but on save it generates a GST
  // invoice immediately (a "direct invoice") instead of just saving a quote.
  const isInvoiceMode     = searchParams.get("invoice") === "1";
  const [invoiceRecurring, setInvoiceRecurring] = React.useState(false);
  // The route's static <title> says "New Quote"; correct it in invoice mode.
  React.useEffect(() => {
    if (isInvoiceMode) document.title = "New Invoice · ResellerOS";
  }, [isInvoiceMode]);
  const { data: sourceQuote } = useQuote(duplicateOf ?? undefined);

  // Look up the lead from the cached useLeads() query so the operator can
  // navigate to /quotes/new?lead=L-XXX with JUST the ID — we fill in the
  // rest from the lead row. This makes the URL bookmarkable / shareable
  // and unblocks the "type URL" workflow that was hitting "No customers yet".
  const { data: allLeads } = useLeads();
  const leadFromQuery = React.useMemo(() => {
    if (!leadId || !allLeads) return null;
    return allLeads.find((l) => l.id === leadId) ?? null;
  }, [leadId, allLeads]);

  // Effective lead fields — URL param wins, lead row fills in the rest.
  // Stays null until the lead has loaded OR all URL params are present.
  const leadCompanyInit = urlCompany || leadFromQuery?.company || "";
  const leadPlan        = urlPlan    || leadFromQuery?.plan    || null;
  const leadSeats       = urlSeats   || (leadFromQuery?.seats != null ? String(leadFromQuery.seats) : null);
  const leadContactInit = urlContact || leadFromQuery?.contact_name  || "";
  const leadEmailInit   = urlEmail   || leadFromQuery?.contact_email || "";
  const leadPhoneInit   = urlPhone   || leadFromQuery?.contact_phone || "";

  // Editable prospect detail state — initial values from lead row; user
  // can refine inline on the quote builder, and changes flow back to the
  // lead row on save. This was previously read-only; operators repeatedly
  // hit the wall of "phone/email blank, can't fill it here" and had to
  // bounce to /leads → edit → return. Inline edit collapses that loop.
  const [leadCompany, setLeadCompany] = React.useState(leadCompanyInit);
  const [leadContact, setLeadContact] = React.useState(leadContactInit);
  const [leadPhone,   setLeadPhone]   = React.useState(leadPhoneInit);
  const [leadEmail,   setLeadEmail]   = React.useState(leadEmailInit);
  // Prospect place-of-supply (state) + optional GSTIN — drives CGST/SGST vs
  // IGST for a prospect quote (no customer record exists yet). Persisted back
  // to the lead on save so it flows to the customer on conversion.
  const leadStateInit = leadFromQuery?.state_code ?? "";
  const leadGstinInit = leadFromQuery?.gstin ?? "";
  const [leadStateCode, setLeadStateCode] = React.useState(leadStateInit);
  const [leadGstin,     setLeadGstin]     = React.useState(leadGstinInit);
  React.useEffect(() => { if (leadStateInit) setLeadStateCode(leadStateInit); }, [leadStateInit]);
  React.useEffect(() => { if (leadGstinInit) setLeadGstin(leadGstinInit); }, [leadGstinInit]);

  // Sync local state when the lead loads asynchronously (initial mount the
  // values are empty strings; once allLeads arrives they get populated).
  React.useEffect(() => { if (leadCompanyInit) setLeadCompany(leadCompanyInit); }, [leadCompanyInit]);
  React.useEffect(() => { if (leadContactInit) setLeadContact(leadContactInit); }, [leadContactInit]);
  React.useEffect(() => { if (leadPhoneInit)   setLeadPhone(leadPhoneInit);     }, [leadPhoneInit]);
  React.useEffect(() => { if (leadEmailInit)   setLeadEmail(leadEmailInit);     }, [leadEmailInit]);

  // Lead mode applies when either:
  //   - explicit leadId in URL (from Lead Detail → Send Quote OR direct URL), OR
  //   - duplicating an existing prospect-only quote (source has lead_id, no customer_id)
  const isLeadMode = Boolean(
    leadId || (sourceQuote && sourceQuote.lead_id && !sourceQuote.customer_id),
  );

  // Form state
  const [customerId, setCustomerId] = React.useState<string>("");
  // Free-text prospect name — used when the operator wants to quote a NEW
  // prospect who isn't yet in the customers table. customer_id stays null;
  // the typed name is saved as quote.customer_name. A real customer record
  // gets created later when record_payment fires (lead → customer cascade).
  // This unblocks the "no customers yet" dead-end the picker had.
  const [prospectName, setProspectName] = React.useState<string>("");
  // Customer-entry mode — a clean either/or toggle (was two inputs shown at once,
  // which read ambiguous). "existing" = pick from the book; "prospect" = type a
  // new one. The underlying resolution (customer_id vs typed name) is unchanged.
  const [custMode, setCustMode] = React.useState<"existing" | "prospect">("existing");
  // Prefill / duplicate / add-new set customerId → snap the toggle to "existing".
  React.useEffect(() => { if (customerId) setCustMode("existing"); }, [customerId]);
  // Typed-prospect country — lets a NEW international prospect (no lead, no
  // customer record) be detected as an export (zero-rated).
  const [prospectCountry, setProspectCountry] = React.useState<string>("India");
  // Place of supply for a TYPED prospect (no customer record yet) — drives the
  // GST split (CGST+SGST intra vs IGST inter). Without it an inter-state prospect
  // silently defaulted to intra-state. India only (export = zero-rated, no state).
  const [prospectStateCode, setProspectStateCode] = React.useState<string>("");
  const [validityDays, setValidityDays] = React.useState(30);
  // Invoice payment terms → net days for the due date (Due on Receipt / Net 15/30/45).
  // Drives the displayed due date + is saved so generate_invoice stamps it (0163).
  // Default 0 = Due on receipt (due date = invoice date); a customer's saved term
  // or a revised quote's term overrides via the prefill effects below.
  const [paymentTermsDays, setPaymentTermsDays] = React.useState(0);
  // Document-level terms & conditions (Zoho-style), shown on the quote/invoice PDF.
  const [termsConditions, setTermsConditions] = React.useState("");
  const [taxRate, setTaxRate] = React.useState(18);
  // Foreign currency (international clients) — books stay INR; this is the
  // billing currency + rate shown to the customer. INR = domestic.
  const [currency, setCurrency] = React.useState("INR");
  const [exchangeRate, setExchangeRate] = React.useState(1);
  // Quote-level billing cycle (invoice frequency) — INDEPENDENT of a line's
  // price-tier commitment (migration 0161). A flex-monthly line forces 'monthly'
  // (see effectiveCycle below).
  const [billingCycle, setBillingCycle] = React.useState<BillingCycle>("yearly");
  // Live FX helper — auto-fills ₹/unit from the internet so the operator never
  // hand-types a stale rate. `fxInfo` shows provenance (as-of date); `fxAuto`
  // marks the current rate as auto-fetched (an edit clears it → "manual").
  const [fxLoading, setFxLoading] = React.useState(false);
  const [fxInfo, setFxInfo] = React.useState<{ asOf: string | null } | null>(null);
  const [fxAuto, setFxAuto] = React.useState(false);
  const fetchLatestFx = React.useCallback(async (cur: string) => {
    const c = (cur ?? "").toUpperCase();
    if (!c || c === "INR") return;
    setFxLoading(true);
    try {
      const res = await fetch(`/api/fx/latest?from=${encodeURIComponent(c)}`);
      const data = await res.json();
      if (!res.ok || typeof data.rate !== "number") {
        toast.error(data.error ?? "Couldn't fetch the latest rate — enter it manually.");
        return;
      }
      setExchangeRate(data.rate);
      setFxInfo({ asOf: data.asOf ?? null });
      setFxAuto(true);
      toast.success(`Latest rate: ₹${data.rate}/${c}`);
    } catch {
      toast.error("Couldn't reach the rates service — enter it manually.");
    } finally {
      setFxLoading(false);
    }
  }, []);
  // Prospect country (lead mode) — lets a NEW international lead's quote be
  // detected as an export (zero-rated) before a customer record exists.
  const leadCountryInit = leadFromQuery?.country ?? "India";
  const [leadCountry, setLeadCountry] = React.useState(leadCountryInit);
  React.useEffect(() => { if (leadCountryInit) setLeadCountry(leadCountryInit); }, [leadCountryInit]);
  const [notes, setNotes] = React.useState("");
  const [lineItems, setLineItems] = React.useState<QuoteLineItem[]>([]);
  // For a foreign (USD) quote: which price basis to bill on when an item has BOTH
  // a ₹ price and a real foreign price. "international" = use the item's catalog
  // USD price (fall back to ₹-converted if none); "india" = always the ₹ price
  // converted at the rate. Per-quote choice; line rates stay hand-editable.
  const [usdPricingBasis, setUsdPricingBasis] = React.useState<"international" | "india">("international");
  // Round off the final foreign payable total (default on). Display-only — books stay ₹.
  const [roundTotal, setRoundTotal] = React.useState(true);

  // Re-price catalog-linked lines when the billing currency / exchange rate changes,
  // so switching to USD uses each item's REAL USD price (books stay ₹ = USD × rate),
  // and switching back to INR restores the ₹ catalog price. Custom lines (no item_id)
  // are left untouched — the operator owns those numbers.
  React.useEffect(() => {
    if (!catalog || catalog.length === 0) return;
    const usdMode = (currency ?? "INR").toUpperCase() === "USD";
    const fx = exchangeRate && exchangeRate > 0 ? exchangeRate : 1;
    setLineItems((prev) => prev.map((l) => {
      if (!l.item_id || l.bulk) return l;
      const it = catalog.find((c) => c.id === l.item_id);
      if (!it) return l;
      let annualRate: number, annualCost: number;
      const usd = it.prices?.usd;
      if (usdMode && usdPricingBasis === "international" && usd && usd.msrp > 0) {
        annualRate = Math.round(usd.msrp * 12 * fx);
        annualCost = Math.round(usd.wholesale * 12 * fx);
      } else {
        const commitment = l.commitment ?? "annual_yearly";
        const tier = it.prices?.[commitment === "monthly" ? "monthly" : "annual"];
        annualRate = (tier?.msrp ?? it.msrp) * 12;
        annualCost = (tier?.wholesale ?? it.wholesale) * 12;
      }
      return l.rate === annualRate && l.cost === annualCost ? l : { ...l, rate: annualRate, cost: annualCost };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, exchangeRate, catalog, usdPricingBasis]);

  const [addOpen, setAddOpen] = React.useState(false);
  const [addCustomerOpen, setAddCustomerOpen] = React.useState(false);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [viewDomains, setViewDomains] = React.useState<{ name: string; domains: Array<{ domain: string; seats: number }> } | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  // Quote ID is allocated at SAVE time via the central numbering RPC.
  // null = unassigned (shown as placeholder in header until save).
  const [quoteId, setQuoteId] = React.useState<string | null>(null);

  // Today's date (IST) as YYYY-MM-DD — the default service start date for new
  // line items (operator can still change or clear it). Cheap to recompute per
  // render; not memoised on purpose so an overnight session stays correct.
  const todayISO = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ── Pre-fill from lead (runs once — waits for catalog so we use real prices) ──
  const prefilledRef = React.useRef(false);
  React.useEffect(() => {
    if (prefilledRef.current) return;
    if (!isLeadMode || !leadCompany) return;
    // Wait for catalog to load — so we can use the tenant's actual prices,
    // not the hardcoded fallback map.
    if (!catalog) return;

    prefilledRef.current = true;

    const seatsNum = leadSeats ? parseInt(leadSeats, 10) : 0;

    // 1. Find the matching catalog item — tries exact / substring / tier-keyword.
    //    Normalize hyphens to spaces because lead plans coming from the buy
    //    page are stored as slugs like "google-workspace-standard" while
    //    catalog item names use spaces ("Google Workspace Standard").
    const normalize = (s: string) => s.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
    const target = leadPlan ? normalize(leadPlan) : "";

    let catalogItem = target
      ? catalog.find((c) => normalize(c.name) === target)
      : undefined;

    if (!catalogItem && target) {
      // Substring match: normalized catalog name contains the lead's plan keyword (or vice versa)
      catalogItem = catalog.find((c) => {
        const n = normalize(c.name);
        return n.includes(target) || target.includes(n);
      });
    }

    if (!catalogItem && target) {
      // Last-resort: pluck out a tier keyword ("starter" / "standard" / "plus" /
      // "enterprise") from the lead plan and find a catalog item containing it.
      // Handles slugs like "google-workspace-standard" cleanly.
      const TIER_KEYWORDS = ["enterprise", "plus", "standard", "starter"];
      const tierWord = TIER_KEYWORDS.find((k) => target.includes(k));
      if (tierWord) {
        catalogItem = catalog.find((c) => normalize(c.name).includes(tierWord));
      }
    }

    let rate = 0;
    let cost = 0;
    let source: "catalog" | "fallback" | "" = "";

    if (catalogItem) {
      // Use the actual catalog pricing — annual tier × 12 = ₹/seat/yr
      const annualPerMonth = catalogItem.prices?.annual ?? catalogItem.prices?.monthly;
      if (annualPerMonth && annualPerMonth.msrp > 0) {
        rate   = annualPerMonth.msrp * 12;
        cost   = annualPerMonth.wholesale * 12;
        source = "catalog";
      } else if (catalogItem.msrp > 0) {
        // Legacy: use msrp/wholesale columns directly (assumed ₹/seat/month)
        rate   = catalogItem.msrp * 12;
        cost   = catalogItem.wholesale * 12;
        source = "catalog";
      }
    }

    // 2. Fallback to hardcoded plan map — tries exact then substring match too.
    if (!rate && leadPlan) {
      const lpLower = leadPlan.toLowerCase();
      let monthlyPPS = PLAN_PRICE_PER_SEAT_PM[leadPlan];
      if (!monthlyPPS) {
        // Try substring match against known plan names
        const key = Object.keys(PLAN_PRICE_PER_SEAT_PM).find((k) => {
          const kl = k.toLowerCase();
          return kl.includes(lpLower) || lpLower.includes(kl);
        });
        if (key) monthlyPPS = PLAN_PRICE_PER_SEAT_PM[key];
      }
      if (monthlyPPS) {
        rate   = monthlyPPS * 12;
        cost   = Math.round(rate * 0.7);
        source = "fallback";
      }
    }

    if (leadPlan && seatsNum > 0 && rate > 0) {
      setLineItems([
        {
          id:         `line-${Date.now()}`,
          item_id:    catalogItem?.id,
          // Use the full catalog name when matched (so "Starter" → "Google Workspace Business Starter")
          name:       catalogItem?.name ?? leadPlan,
          qty:        seatsNum,
          rate,
          list_rate:  rate,
          cost,
          commitment: "annual_yearly",
          start_date: todayISO,
        },
      ]);
      toast.success(
        source === "catalog"
          ? `Pre-filled from catalog: ${seatsNum} × ${leadPlan} @ ₹${rate}/seat/yr`
          : `Pre-filled (catalog item missing — using fallback): ${seatsNum} × ${leadPlan} @ ₹${rate}/seat/yr`,
      );
    } else {
      toast.info(`Add line items for ${leadCompany}'s quote`);
    }

    // Pre-fill notes with friendly customer-facing message
    setNotes(
      `Quote for ${leadCompany}\n` +
      (leadContact ? `Attn: ${leadContact}\n` : "") +
      `\nPricing valid for 30 days. Onboarding includes DNS, MX, SPF, DKIM, DMARC setup. Free training (2 sessions).`,
    );
  }, [isLeadMode, leadCompany, leadPlan, leadSeats, leadContact, catalog]);

  // ── Pre-fill from existing quote (Duplicate / Revise & resend) ──
  const duplicatedRef = React.useRef(false);
  React.useEffect(() => {
    if (duplicatedRef.current) return;
    if (!duplicateOf || !sourceQuote) return;

    duplicatedRef.current = true;

    // Copy customer / lead linkage from source
    if (sourceQuote.customer_id) {
      setCustomerId(sourceQuote.customer_id);
    }
    // Copy line items + financial settings
    if (Array.isArray(sourceQuote.line_items)) {
      // Clone with fresh IDs so React keys stay unique if source items get edited
      const items = (sourceQuote.line_items as QuoteLineItem[]).map((l, i) => ({
        ...l,
        id: `line-${Date.now()}-${i}`,
        list_rate: l.list_rate ?? l.rate,
      }));
      setLineItems(items);
    }
    if (sourceQuote.tax_rate     != null) setTaxRate(sourceQuote.tax_rate);
    if (sourceQuote.billing_cycle)        setBillingCycle(sourceQuote.billing_cycle);
    if (sourceQuote.payment_terms_days != null) setPaymentTermsDays(sourceQuote.payment_terms_days);
    if (sourceQuote.terms_conditions)     setTermsConditions(sourceQuote.terms_conditions);
    if (sourceQuote.notes)                setNotes(sourceQuote.notes);

    toast.success(`Revising ${sourceQuote.id} — edit anything, then Save & send`);
  }, [duplicateOf, sourceQuote]);

  // ── Pre-fill for real in-place edit (?edit=<id>) — only drafts are
  // editable; a sent/accepted quote is a document that's already gone out
  // and shouldn't silently change under the customer. ──
  const editedRef = React.useRef(false);
  React.useEffect(() => {
    if (editedRef.current) return;
    if (!editOf || !editQuote) return;
    editedRef.current = true;

    if (editQuote.status !== "draft") {
      toast.error(`${editQuote.id} is ${editQuote.status}, not a draft — opening as read-only view instead.`);
      router.replace(`/quotes/${editQuote.id}` as never);
      return;
    }

    setQuoteId(editQuote.id);
    if (editQuote.customer_id) setCustomerId(editQuote.customer_id);
    if (Array.isArray(editQuote.line_items)) {
      setLineItems(editQuote.line_items as QuoteLineItem[]);
    }
    if (editQuote.tax_rate           != null) setTaxRate(editQuote.tax_rate);
    if (editQuote.billing_cycle)               setBillingCycle(editQuote.billing_cycle);
    if (editQuote.payment_terms_days != null) setPaymentTermsDays(editQuote.payment_terms_days);
    if (editQuote.terms_conditions)            setTermsConditions(editQuote.terms_conditions);
    if (editQuote.notes)                       setNotes(editQuote.notes);
    if (editQuote.currency)                    setCurrency(editQuote.currency);
    if (editQuote.exchange_rate      != null) setExchangeRate(editQuote.exchange_rate);
    if (!editQuote.customer_id && editQuote.customer_name) setProspectName(editQuote.customer_name);
    if (editQuote.prospect_state_code)         setProspectStateCode(editQuote.prospect_state_code);
    if (editQuote.prospect_country)            setProspectCountry(editQuote.prospect_country);
    if (editQuote.expires_date) {
      const days = Math.round((new Date(editQuote.expires_date).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
      if (days > 0) setValidityDays(days);
    }

    toast.success(`Editing ${editQuote.id}`);
  }, [editOf, editQuote, router]);

  // ── Pre-fill the customer from ?customer=<id> (Customer 360 → "Add service") ──
  // Mirrors the ?lead= path but for an EXISTING customer (cross-sell / new service).
  const presetCustRef = React.useRef(false);
  React.useEffect(() => {
    if (presetCustRef.current || !urlCustomer || !customers) return;
    if (customers.some((c) => c.id === urlCustomer)) {
      presetCustRef.current = true;
      setCustomerId(urlCustomer);
      setProspectName("");
    }
  }, [urlCustomer, customers]);

  // Derived customer fields
  const customer = customers?.find((c) => c.id === customerId);
  // Invoice mode: pre-fill the payment terms from the customer's default (0164).
  // Fires when a customer with a saved term is selected; a manual Terms change
  // still wins (this only re-runs if the selected customer's term changes).
  React.useEffect(() => {
    if (isInvoiceMode && customer?.payment_terms_days != null) {
      setPaymentTermsDays(customer.payment_terms_days);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customer?.payment_terms_days, isInvoiceMode]);
  // GST head: compare the customer's state vs OUR (the seller/tenant's) state.
  // Previously hardcoded a seller of "27" (Maharashtra), which was wrong for any
  // other tenant. Now derived consistently via the shared helper. (audit #18-20)
  // Buyer's place of supply: for a prospect (lead mode) there's no customer
  // record yet, so use the state captured on the quote builder; otherwise the
  // picked customer's state. Drives CGST+SGST (intra) vs IGST (inter).
  const buyerStateCode = isLeadMode
    ? (leadStateCode || null)
    : (customerId ? (customer?.state_code ?? null) : (prospectStateCode || null));
  const interState = isInterStateSupply(buyerStateCode, currentUser?.tenantStateCode);

  // Selling gross = the (negotiated) rate × qty. This is the actual revenue and
  // what gets billed / drives MRR — so it stays the subtotal.
  const grossSubtotal     = lineItems.reduce((s, it) => s + it.qty * it.rate, 0);
  // Legacy per-line discount (UI removed; still honoured for old/imported quotes).
  const lineDiscountTotal = lineItems.reduce((s, it) => s + Math.round(it.qty * it.rate * ((it.discount_pct ?? 0) / 100)), 0);
  const subtotal          = grossSubtotal - lineDiscountTotal;
  const totalCost         = lineItems.reduce((s, it) => s + it.qty * it.cost, 0);
  // Customer discount is DERIVED, not applied: it's the gap between the LIST
  // price (list_rate) and what we're actually charging (rate). The rate is
  // already the discounted price, so taxable = subtotal (no further deduction —
  // deducting again would double-count and break the billed amount / MRR).
  const listGross         = lineItems.reduce((s, it) => s + it.qty * (it.list_rate ?? it.rate), 0);
  const customerDiscount    = Math.max(0, listGross - subtotal);
  const customerDiscountPct = listGross > 0 ? Math.round((customerDiscount / listGross) * 100) : 0;
  const taxable           = subtotal;
  // Export (international) customer → the supply is zero-rated under LUT: no
  // GST is added. Detected from the customer's country (foreign = export).
  // For a prospect/lead quote (no customer record yet) export can't be inferred
  // here — mark the customer as export once created. (Phase 1c: lead country.)
  const isExport          = isExportSupply(isLeadMode ? leadCountry : (customer?.country ?? (!customerId ? prospectCountry : null)));

  // Foreign (export) customer on a NEW quote → default the billing currency to
  // USD (books still record in ₹) so the operator doesn't have to remember to
  // switch — a foreign client expects a foreign-currency invoice. One-shot, only
  // while still on the INR default: never fights a manual choice or an edited quote.
  const fxAutoDefaulted = React.useRef(false);
  React.useEffect(() => {
    if (fxAutoDefaulted.current || duplicateOf) return;
    if (!isExport || currency !== "INR") return;
    fxAutoDefaulted.current = true;
    setCurrency("USD");
    setExchangeRate(1);
    setFxAuto(false);
    void fetchLatestFx("USD");
  }, [isExport, currency, duplicateOf, fetchLatestFx]);

  const effectiveTaxRate  = isExport ? 0 : taxRate;
  const tax               = Math.round(taxable * (effectiveTaxRate / 100));
  const total             = taxable + tax;
  // Foreign-currency billing (books stay ₹). The whole builder renders in `currency`
  // via curFmt(); the stored quote.amount is always ₹ `total`.
  const isForeign         = isForeignCurrency(currency);
  const margin            = computeMargin(totalCost, taxable);

  // Billing frequency is now a single QUOTE-LEVEL choice (migration 0161),
  // independent of any line's price-tier commitment. A flex-monthly line forces
  // the whole quote to monthly billing (a no-commitment plan can only bill
  // monthly). All lines share this frequency, so totals show the per-invoice unit.
  const hasFlexMonthly     = lineItems.some((l) => (l.commitment ?? "annual_yearly") === "monthly");
  const effectiveCycle: BillingCycle = hasFlexMonthly ? "monthly" : billingCycle;
  const billingN           = cycleInvoicesPerYear(effectiveCycle);
  const billingUnit        = cycleUnitLabel(effectiveCycle);
  const showPerInvoice     = billingN > 1;
  const totalsLabel        =
    billingN === 12 ? "Subtotal (monthly recurring)" :
    billingN === 4  ? "Subtotal (quarterly)"         :
    billingN === 2  ? "Subtotal (half-yearly)"       :
    "Subtotal (annual)";
  // Foreign (USD) billing: show the WHOLE builder in the client's currency so it
  // matches the quote/invoice they receive. The books stay ₹ (canonical line.rate);
  // every displayed figure goes through the consistent helpers below. The rate
  // must be set (> 1) or the ₹ books would be wrong — fxMissing gates the flow.
  const isUsdBill = isForeign && (currency ?? "").toUpperCase() === "USD";
  const fxRate    = exchangeRate && exchangeRate > 0 ? exchangeRate : 1;
  const fxMissing = isForeign && (!exchangeRate || exchangeRate <= 1);

  // ── Display-currency figures, CONSISTENT with the per-unit rate shown ──
  // For a foreign quote we round each unit rate in the client's currency and
  // build the line amounts + totals from THAT, so qty × rate == amount and the
  // lines sum to the total (a plain ₹ ÷ rate per figure would let a rounded rate
  // disagree with the exact total, e.g. 32 × $32.00 ≠ $1,023.88). For ₹ the
  // values fall back to the canonical figures above (no rounding drift).
  const dRound = (v: number) => (isUsdBill ? Math.round(v * 100) / 100 : Math.round(v));
  const toDisp = (inr: number) => (isUsdBill ? dRound(inr / fxRate) : inr);
  const fmtDispC = (v: number) => (isUsdBill ? formatForeign(v, currency ?? "USD") : rupee(v));
  const dispAmt  = (perSeatInr: number, qty: number, discPct = 0) => dRound(qty * toDisp(perSeatInr) * (1 - discPct / 100));
  const dispGross    = isUsdBill ? dRound(lineItems.reduce((s, l) => s + dRound(l.qty * toDisp(l.rate)), 0)) : grossSubtotal;
  const dispLineDisc = isUsdBill ? dRound(lineItems.reduce((s, l) => s + dRound(l.qty * toDisp(l.rate) * ((l.discount_pct ?? 0) / 100)), 0)) : lineDiscountTotal;
  const dispSubtotal = isUsdBill ? dRound(dispGross - dispLineDisc) : subtotal;
  const dispTaxable  = dispSubtotal;
  const dispTax      = isUsdBill ? dRound(dispTaxable * (effectiveTaxRate / 100)) : tax;
  const dispTotal    = isUsdBill ? dRound(dispTaxable + dispTax) : total;
  const dispListGross = isUsdBill ? dRound(lineItems.reduce((s, l) => s + dRound(l.qty * toDisp(l.list_rate ?? l.rate)), 0)) : listGross;
  const dispCustomerDiscount = Math.max(0, dRound(dispListGross - dispSubtotal));
  // Per-invoice-aware formatter for a DISPLAY-currency ANNUAL figure.
  const fmtTotalC = (annualDisp: number) =>
    showPerInvoice ? `${fmtDispC(dRound(annualDisp / billingN))}${billingUnit}` : fmtDispC(annualDisp);
  const fmtPayableC = (annualDisp: number) =>
    isUsdBill
      ? (roundTotal ? formatForeign(Math.round(annualDisp), currency ?? "USD", 0) : formatForeign(annualDisp, currency ?? "USD"))
      : rupee(annualDisp);

  // Line item handlers
  const addLine = (line: QuoteLineItem) => {
    // Freeze the LIST price at add time (= the rate we start from). Lowering the
    // rate later surfaces the gap as the customer's discount. (see totals)
    const withList: QuoteLineItem = { ...line, list_rate: line.list_rate ?? line.rate, start_date: line.start_date ?? todayISO };
    // Merge into an economically-identical existing line instead of creating a
    // duplicate row (which silently doubles the quote total). (audit: dup-line)
    const { lines, merged, mergedQty } = addOrMergeLine(lineItems, withList);
    setLineItems(lines);
    toast.success(
      merged
        ? `${line.name} already in this quote — quantity increased to ${mergedQty}`
        : `Added ${line.name}`,
    );
  };
  const updateQty = (id: string, qty: number) => {
    setLineItems((s) => s.map((l) => (l.id === id ? { ...l, qty: Math.max(1, qty) } : l)));
  };
  const updateRate = (id: string, rate: number) => {
    setLineItems((s) => s.map((l) => (l.id === id ? { ...l, rate: Math.max(0, rate) } : l)));
  };
  const updateCost = (id: string, cost: number) => {
    setLineItems((s) => s.map((l) => (l.id === id ? { ...l, cost: Math.max(0, cost) } : l)));
  };
  const updateStartDate = (id: string, date: string) => {
    setLineItems((s) => s.map((l) => (l.id === id ? { ...l, start_date: date || undefined } : l)));
  };
  const updateDomain = (id: string, d: string) => {
    setLineItems((s) => s.map((l) => (l.id === id ? { ...l, domain: d || null } : l)));
  };
  const updateCommitment = (id: string, commitment: LineCommitment) => {
    setLineItems((s) =>
      s.map((l) => {
        if (l.id !== id) return l;

        // If this line came from the catalog, recalc rate based on new commitment tier
        if (l.item_id && catalog) {
          const item = catalog.find((c) => c.id === l.item_id);
          // Map line commitment → underlying item price tier
          // "monthly" = monthly flex tier · others = annual tier (same price, only billing differs)
          const tierKey = commitment === "monthly" ? "monthly" : "annual";
          const tier    = item?.prices?.[tierKey];
          if (tier && tier.msrp > 0) {
            return {
              ...l,
              commitment,
              rate: tier.msrp * 12,        // store as ₹/seat/year
              cost: tier.wholesale * 12,
            };
          }
        }
        // No catalog link OR tier not found — just update commitment, keep current rate
        return { ...l, commitment };
      }),
    );
  };
  const removeLine = (id: string) => {
    setLineItems((s) => s.filter((l) => l.id !== id));
  };

  // Submit
  // afterAction lets the caller request a follow-up on the detail page
  // (open the email or WhatsApp dialog as soon as we land). The detail
  // page reads `?send=whatsapp` / `?send=email` from the URL.
  const handleSubmit = async (status: "draft" | "sent", afterAction?: "email" | "whatsapp") => {
    // In lead mode, customer is NOT required (lead = potential customer).
    // A real customer record gets created only after payment.
    // In customer mode, accept EITHER an existing customer pick OR a typed
    // prospect name — prospect mode lets the operator quote a brand-new
    // company without first creating a customer record.
    if (!isLeadMode && !customerId && !prospectName.trim()) {
      toast.error("Pick a customer or type a new prospect name");
      return;
    }
    if (lineItems.length === 0) {
      toast.error("Add at least one line item");
      return;
    }

    const expiresDate = new Date();
    expiresDate.setDate(expiresDate.getDate() + validityDays);

    try {
      // Allocate the sequential quote ID via the central numbering RPC.
      // Reuse if user clicked save twice (e.g., draft → send) — don't waste numbers.
      let idToUse = quoteId;
      if (!idToUse) {
        const { createClient } = await import("@/lib/supabase/client");
        const supabase = createClient();
        const { data: newId, error: seqErr } = await supabase
          .rpc("next_document_number", { p_doc_type: "quote" });
        if (seqErr || !newId) {
          toast.error("Failed to allocate quote number — please retry");
          return;
        }
        idToUse = newId;
        setQuoteId(newId);
      }

      // Resolve customer_name: lead → use lead.company. Else if customerId
      // picked → use that customer's name. Else (prospect mode) → use typed
      // prospect name. Validation upstream ensures one of these is present.
      const resolvedCustomerName = isLeadMode
        ? (leadCompany ?? "Prospect")
        : customer
          ? customer.name
          : (prospectName.trim() || "Prospect");

      const quote = await createQuote.mutateAsync({
        id: idToUse,
        customer_id:   isLeadMode ? null : (customerId || null),
        customer_name: resolvedCustomerName,
        lead_id:       isLeadMode ? leadId : null,
        // Quote-level domain = the first line's domain (the primary subscription).
        // record_payment stamps this on the subscription it creates today; per-line
        // domains also live on each line_item for the coming multi-sub fan-out.
        domain:        (lineItems.find((l) => l.domain?.trim())?.domain ?? "").trim() || null,
        line_items:    lineItems,
        subtotal,
        total_cost:    totalCost,
        // Discount is baked into each line's rate (see totals) — nothing applied on top.
        discount_pct:  0,
        tax_rate:      effectiveTaxRate,   // 0 for an export (zero-rated) customer
        amount:        total,              // canonical ₹ (books stay INR)
        currency:      currency,
        exchange_rate: isForeign ? exchangeRate : 1,
        billing_cycle: effectiveCycle,   // quote-level invoice frequency (0161)
        // Invoice payment terms → generate_invoice stamps the due date (0163).
        payment_terms_days: isInvoiceMode ? paymentTermsDays : null,
        terms_conditions:   termsConditions.trim() || null,
        status,
        notes:         notes || null,
        expires_date:  expiresDate.toISOString().slice(0, 10),
        seats:         lineItems.reduce((s, l) => s + l.qty, 0),
        plan:          lineItems[0]?.name ?? null,
        // Direct invoice: a one-time invoice must NOT create a subscription on
        // payment; a recurring one should. Ignored for normal quotes.
        is_one_off:    isInvoiceMode ? !invoiceRecurring : false,
        // Typed-prospect place-of-supply (0167). Only meaningful when there's no
        // lead and no picked customer — those carry their own state. Persisted so
        // record_payment can stamp it on the auto-created customer → the tax
        // invoice gets the correct GST head (IGST vs CGST+SGST) instead of a
        // stateless intra-state default.
        prospect_state_code: (!isLeadMode && !customerId && prospectStateCode) ? prospectStateCode : null,
        prospect_state:      (!isLeadMode && !customerId && prospectStateCode) ? (GST_STATE_BY_CODE[prospectStateCode] ?? null) : null,
        prospect_country:    (!isLeadMode && !customerId) ? (prospectCountry.trim() || "India") : null,
      });

      // If created from a lead AND quote actually went out (not just saved as
      // draft), graduate the lead from "raw" (Leads tab) to "qualified"
      // (Deals tab) AND advance its stage to "quote". We pull plan/seats/value
      // from the just-sent quote so the lead row reflects what the customer
      // is actually being quoted — otherwise a raw lead would end up in
      // stage='quote' with plan=NULL, looking like a Quote Sent lead in the
      // Leads (raw) tab forever.
      if (isLeadMode && leadId && status === "sent") {
        try {
          const totalSeats = lineItems.reduce((s, l) => s + l.qty, 0);
          await updateLead.mutateAsync({
            id: leadId,
            patch: {
              stage: "quote",
              plan:  lineItems[0]?.name ?? null,
              seats: totalSeats > 0 ? totalSeats : null,
              value: total > 0     ? total     : null,
              // Sync the edited contact info back to the lead row — single
              // source of truth lives on the lead. company is NOT NULL on
              // the DB so we only patch when the new value is non-empty;
              // contact_* fields are nullable so we patch with null when
              // user clears them.
              ...(leadCompany !== leadCompanyInit && leadCompany.trim() && { company:       leadCompany.trim()    }),
              ...(leadContact !== leadContactInit                       && { contact_name:  leadContact || null   }),
              ...(leadPhone   !== leadPhoneInit                         && { contact_phone: leadPhone   || null   }),
              ...(leadEmail   !== leadEmailInit                         && { contact_email: leadEmail   || null   }),
              ...(leadStateCode !== leadStateInit && { state_code: leadStateCode || null, state: leadStateCode ? (GST_STATE_BY_CODE[leadStateCode] ?? null) : null }),
              ...(leadGstin     !== leadGstinInit && { gstin: leadGstin.trim() || null }),
            },
          });
          toast.success(`Lead moved to "Quote Sent" · qualified`);
        } catch {
          // Don't block the redirect if stage update fails; quote is saved.
        }
      } else if (isLeadMode && leadId && status === "draft") {
        // For drafts: still persist contact-info edits to the lead so they
        // don't get lost when the user comes back. Stage stays as-is.
        const contactPatch = {
          ...(leadCompany !== leadCompanyInit && leadCompany.trim() && { company:       leadCompany.trim()  }),
          ...(leadContact !== leadContactInit                       && { contact_name:  leadContact || null }),
          ...(leadPhone   !== leadPhoneInit                         && { contact_phone: leadPhone   || null }),
          ...(leadEmail   !== leadEmailInit                         && { contact_email: leadEmail   || null }),
          ...(leadStateCode !== leadStateInit && { state_code: leadStateCode || null, state: leadStateCode ? (GST_STATE_BY_CODE[leadStateCode] ?? null) : null }),
          ...(leadGstin     !== leadGstinInit && { gstin: leadGstin.trim() || null }),
          ...(leadCountry   !== leadCountryInit && { country: leadCountry.trim() || "India" }),
        };
        if (Object.keys(contactPatch).length > 0) {
          try {
            await updateLead.mutateAsync({ id: leadId, patch: contactPatch });
          } catch {
            /* don't block redirect */
          }
        }
      }

      // Invoice mode: generate the GST invoice immediately from the just-created
      // quote, then land on the invoices list. (Reuses the tested generate_invoice.)
      if (isInvoiceMode) {
        try {
          await generateInvoice.mutateAsync(quote.id);
        } catch {
          // The quote is saved; if invoice generation failed the hook toasts —
          // fall back to the quote so nothing is lost.
          router.push(`/quotes/${quote.id}` as any);
          return;
        }
        router.push("/invoices" as any);
        return;
      }

      const suffix = afterAction ? `?send=${afterAction}` : "";
      router.push(`/quotes/${quote.id}${suffix}` as any);
    } catch {
      // toast in hook
    }
  };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto flex flex-col gap-4">
      {/* Page head */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <IconButton icon="arrow_left" aria-label="Back" onClick={() => router.back()} />
          <div>
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              {isInvoiceMode ? "Direct invoice · GST tax invoice" : "Quotation · Auto-generated"}
            </p>
            <h1 className="font-serif text-3xl md:text-4xl leading-tight">
              {isInvoiceMode
                ? "New invoice"
                : (quoteId ?? "New quotation")}
            </h1>
            <p className="text-sm text-ink-3 mt-1">
              For <b className="text-ink">{isLeadMode ? leadCompany : (customer?.name ?? prospectName.trim() ?? "—")}</b>
              {(isLeadMode || (!customer && prospectName.trim())) && (
                <span className="ml-1 text-amber-ink">(prospect)</span>
              )}
              {" · Draft"}
              {lineItems.length > 0 && (
                <> · <b className="text-ink tabular-nums">{fmtDispC(dispTotal)}</b></>
              )}
            </p>
          </div>
        </div>
        {/* Actions live in the sticky bottom bar (always visible) — no
            duplicate button row up here. */}
      </div>

      {/* AI margin warning */}
      {lineItems.length > 0 && margin.marginPct < 14 && (
        <GeminiCard title="Margin alert" compact>
          <b>Margin below 14% ({margin.marginPct}%).</b> Consider reducing discount or upselling higher-tier products.
        </GeminiCard>
      )}

      {/* Customer / prospect details — full width */}
      {isLeadMode ? (
          /* ───── Prospect Details (read-only, from lead) ───── */
          <Card title="Prospect Details">
            <div className="space-y-3">
              <div className="rounded-md bg-amber-soft border border-amber/40 px-3 py-2 text-xs text-amber-ink flex items-start gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 mt-0.5">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4M12 8h.01" />
                </svg>
                <div>
                  <b>Potential customer</b> — full customer record will be created
                  automatically once payment is received.
                </div>
              </div>

              <FormField label="Company" htmlFor="leadCompany">
                <Input
                  id="leadCompany"
                  value={leadCompany}
                  onChange={(e) => setLeadCompany(e.target.value)}
                  className="font-medium"
                  placeholder="Company name"
                />
              </FormField>

              <div className="grid grid-cols-2 gap-3">
                <FormField label="Contact name" htmlFor="leadContact">
                  <Input
                    id="leadContact"
                    value={leadContact}
                    onChange={(e) => setLeadContact(e.target.value)}
                    placeholder="Contact person"
                  />
                </FormField>
                <FormField label="Phone" htmlFor="leadPhone">
                  <Input
                    id="leadPhone"
                    value={leadPhone}
                    onChange={(e) => setLeadPhone(e.target.value)}
                    className="font-mono"
                    placeholder="e.g. +91 98765 43210"
                  />
                </FormField>
              </div>

              <FormField label="Email" htmlFor="leadEmail">
                <Input
                  id="leadEmail"
                  type="email"
                  value={leadEmail}
                  onChange={(e) => setLeadEmail(e.target.value)}
                  className="font-mono"
                  placeholder="e.g. contact@company.com"
                />
              </FormField>

              {/* Place of supply — drives correct GST for the prospect quote.
                  Without it we'd assume intra-state (CGST+SGST) for everyone. */}
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Place of supply (state)" htmlFor="leadState">
                  <select
                    id="leadState"
                    value={leadStateCode}
                    onChange={(e) => setLeadStateCode(e.target.value)}
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  >
                    <option value="">Select state (for GST)</option>
                    {Object.entries(GST_STATE_BY_CODE)
                      .sort((a, b) => a[1].localeCompare(b[1]))
                      .map(([code, name]) => (
                        <option key={code} value={code}>{name} ({code})</option>
                      ))}
                  </select>
                </FormField>
                <FormField label="GSTIN (optional)" htmlFor="leadGstin">
                  <Input
                    id="leadGstin"
                    value={leadGstin}
                    onChange={(e) => setLeadGstin(e.target.value.toUpperCase())}
                    className="font-mono"
                    placeholder="e.g. 27AABCE9876D1Z3"
                  />
                </FormField>
              </div>
              <FormField label="Country" htmlFor="leadCountry">
                <select
                  id="leadCountry"
                  value={leadCountry}
                  onChange={(e) => setLeadCountry(e.target.value)}
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                >
                  {COUNTRIES.map((ctry) => <option key={ctry} value={ctry}>{ctry}</option>)}
                </select>
              </FormField>
              {isExport ? (
                <p className="text-[11px] flex items-start gap-1 -mt-1 text-indigo-ink">
                  🌍 Export ({leadCountry}) → zero-rated under LUT, no GST
                </p>
              ) : leadStateCode && (
                <p className="text-[11px] flex items-center gap-1 -mt-1">
                  {interState
                    ? <span className="text-amber-ink">⚠ Inter-state → IGST {taxRate}% will apply</span>
                    : <span className="text-emerald">✓ Intra-state → CGST + SGST split</span>}
                </p>
              )}

              <div className="flex gap-2 text-[11px] text-ink-3 pt-1 border-t border-hairline">
                <span>Lead ID: <code className="font-mono">{leadId}</code></span>
                {leadPlan && <span>· Interested in: <b>{leadPlan}</b></span>}
                {leadSeats && <span>· {leadSeats} seats</span>}
              </div>
            </div>
          </Card>
        ) : (
          /* ───── Customer Details (existing customer OR new prospect flow) ───── */
          <Card title="Customer Details">
            <div className="space-y-3">
              {/* Either/or mode toggle — one input at a time so the active path is
                  unmistakable. Invoice mode is existing-only (a GST invoice must
                  carry a real customer, no auto-create-on-payment). */}
              {!isInvoiceMode && (
                <div className="inline-flex gap-1 bg-paper-2 rounded-md p-0.5" role="tablist" aria-label="Customer type">
                  {([["existing", "Existing customer"], ["prospect", "New prospect"]] as const).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={custMode === m}
                      onClick={() => {
                        setCustMode(m);
                        if (m === "existing") setProspectName("");
                        else setCustomerId("");
                      }}
                      className={cn(
                        "px-3 py-1 text-xs font-medium rounded transition-colors",
                        custMode === m ? "bg-paper text-ink shadow-sm" : "text-ink-3 hover:text-ink",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}

              {(isInvoiceMode || custMode === "existing") && (
                <FormField label={isInvoiceMode ? "Customer" : "Existing customer"} htmlFor="customer">
                  {customersLoading ? (
                    <Skeleton className="h-9" />
                  ) : (
                    <CustomerCombobox
                      id="customer"
                      value={customerId}
                      onChange={(v) => {
                        setCustomerId(v);
                        // Picking an existing customer clears the prospect name
                        // so there's a single source of truth.
                        if (v) setProspectName("");
                      }}
                      onCreateNew={() => setAddCustomerOpen(true)}
                    />
                  )}
                </FormField>
              )}

              {/* New-prospect entry — quote a brand-new company without creating a
                  customer record first. customer_id stays null; a real customer
                  auto-creates on first payment (record_payment RPC). */}
              {!isInvoiceMode && custMode === "prospect" && (
              <FormField label="Prospect name" required htmlFor="prospectName">
                <Input
                  id="prospectName"
                  placeholder="e.g. Acme Corp Pvt Ltd"
                  value={prospectName}
                  onChange={(e) => setProspectName(e.target.value)}
                />
                <p className="text-[10px] text-ink-3 mt-1">
                  A new prospect who hasn&apos;t paid yet — we&apos;ll auto-create the customer record when they pay.
                </p>
              </FormField>
              )}

              {/* Existing customer → a clean read-only summary of their billing
                  identity (not fake-editable grey boxes). Prospect → the editable
                  country + place-of-supply needed to get GST right. */}
              {customerId ? (
                <div className="rounded-lg border border-hairline bg-paper-2/40 px-3 py-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-3">
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5">Website</div>
                      <div className="text-sm text-ink-2 font-mono truncate">{customer?.domain || "—"}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5">GSTIN</div>
                      <div className="text-sm text-ink-2 font-mono truncate">{customer?.gstin || "—"}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-0.5">Place of supply</div>
                      <div className="text-sm text-ink-2 truncate">{customer?.state || "—"}</div>
                    </div>
                  </div>
                  {customer && (
                    <p className="text-[11px] mt-2.5 pt-2.5 border-t border-hairline/70 flex items-center gap-1">
                      {isExport ? (
                        <span className="text-indigo-ink">🌍 Export ({customer?.country}) → zero-rated under LUT, no GST</span>
                      ) : interState ? (
                        <span className="text-amber-ink">⚠ Inter-state → IGST {taxRate}% will apply</span>
                      ) : (
                        <span className="text-emerald">✓ Intra-state → CGST + SGST split @ {taxRate}%</span>
                      )}
                    </p>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <FormField label="Country" htmlFor="prospectCountry">
                    <select
                      id="prospectCountry"
                      value={prospectCountry}
                      onChange={(e) => setProspectCountry(e.target.value)}
                      className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                    >
                      {COUNTRIES.map((ctry) => <option key={ctry} value={ctry}>{ctry}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Place of supply" htmlFor="state">
                    {isExport ? (
                      <Input id="state" value="Export — zero-rated, no GST" readOnly className="bg-paper-2 cursor-default" />
                    ) : (
                      <select
                        id="state"
                        value={prospectStateCode}
                        onChange={(e) => setProspectStateCode(e.target.value)}
                        className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                      >
                        <option value="">Select state (for GST)</option>
                        {Object.entries(GST_STATE_BY_CODE)
                          .sort((a, b) => a[1].localeCompare(b[1]))
                          .map(([code, name]) => <option key={code} value={code}>{name} ({code})</option>)}
                      </select>
                    )}
                  </FormField>
                  <div className="sm:col-span-2 -mt-1">
                    <p className="text-[11px] flex items-center gap-1">
                      {isExport ? (
                        <span className="text-indigo-ink">🌍 Export ({prospectCountry}) → zero-rated under LUT, no GST</span>
                      ) : !prospectStateCode ? (
                        <span className="text-ink-3">Pick the customer&apos;s state so GST (CGST+SGST vs IGST) is correct.</span>
                      ) : interState ? (
                        <span className="text-amber-ink">⚠ Inter-state → IGST {taxRate}% will apply</span>
                      ) : (
                        <span className="text-emerald">✓ Intra-state → CGST + SGST split @ {taxRate}%</span>
                      )}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Settings sit ABOVE the line items — the currency + exchange rate + pricing
            basis + billing cycle chosen here drive how each line is priced/displayed,
            so they must be set before adding items (true for quotes AND invoices). */}
        <Card title={isInvoiceMode ? "Invoice Settings" : "Quote Settings"}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4 items-start">

            {/* Billing cycle — quote-level invoice FREQUENCY, independent of any
                line's price tier (migration 0161). Always enabled (a quote-level
                choice, not gated on line items). A flex-monthly line forces the
                whole quote to monthly billing — a no-commitment plan can only
                bill monthly. Per-line PRICE tier (Monthly-flex vs Annual) is a
                separate control in the items table. */}
            <div>
              <label className="text-xs font-medium text-ink-3 mb-1.5 block">Billing cycle</label>
              <select
                value={effectiveCycle}
                onChange={(e) => setBillingCycle(e.target.value as BillingCycle)}
                disabled={hasFlexMonthly}
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {BILLING_CYCLE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1.5 text-[11px] text-ink-3">
                {hasFlexMonthly
                  ? "A line is “Monthly flex” — a no-commitment plan bills monthly, so the whole invoice is monthly."
                  : <>How often invoices go out. Applies to the whole {isInvoiceMode ? "invoice" : "quote"} — separate from each line’s Monthly-flex vs Annual <b>price</b> (set in the items table).</>}
              </p>
            </div>

            {/* Valid / Expires / GST — 3 across, filling the right half */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 self-start">
            {isInvoiceMode ? (
              /* Zoho-style Terms → Due date. The chosen net-days are saved and
                 generate_invoice (0163) stamps the invoice due date from them. */
              <>
                <FormField label="Terms" htmlFor="terms">
                  <select
                    id="terms"
                    value={paymentTermsDays}
                    onChange={(e) => setPaymentTermsDays(parseInt(e.target.value))}
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
                  >
                    <option value={0}>Due on receipt</option>
                    <option value={15}>Net 15</option>
                    <option value={30}>Net 30</option>
                    <option value={45}>Net 45</option>
                  </select>
                </FormField>
                <FormField label="Due date" htmlFor="due">
                  <Input
                    id="due"
                    value={formatDate(new Date(Date.now() + paymentTermsDays * 86400000))}
                    readOnly
                    className="bg-paper-2 cursor-default font-mono"
                  />
                </FormField>
              </>
            ) : (
              <>
                <FormField label="Valid for (days)" htmlFor="validity">
                  <Input
                    id="validity"
                    type="number"
                    min={1}
                    max={365}
                    value={validityDays}
                    onChange={(e) => setValidityDays(parseInt(e.target.value) || 30)}
                    className="tabular-nums"
                  />
                </FormField>

                <FormField label="Expires on" htmlFor="expires">
                  <Input
                    id="expires"
                    value={formatDate(new Date(Date.now() + validityDays * 86400000))}
                    readOnly
                    className="bg-paper-2 cursor-default font-mono"
                  />
                </FormField>
              </>
            )}

            <FormField label="GST rate %" htmlFor="taxRate">
              <Input
                id="taxRate"
                type="number"
                min={0}
                max={28}
                suffix="%"
                // Export supply is zero-rated under LUT — show 0% and lock the field
                // so it never contradicts the "Export → no GST" badge above.
                value={isExport ? 0 : taxRate}
                onChange={(e) => setTaxRate(parseInt(e.target.value) || 18)}
                disabled={isExport}
                helper={isExport ? "Export → zero-rated under LUT · no GST" : "Default 18% for SaaS · HSN 998313"}
                className={isExport ? "bg-paper-2 cursor-not-allowed" : undefined}
              />
            </FormField>
            </div>

            {/* International billing — set the currency + rate BEFORE adding items so
                the catalog picker shows each product's real USD price (books stay ₹). */}
            {isExport && (
              <div className="lg:col-span-2 rounded-md bg-indigo-soft/40 border border-indigo/20 p-3 space-y-2">
                <p className="text-[11px] font-semibold text-indigo-ink">🌍 International billing · books stay in ₹</p>
                <div className="grid grid-cols-2 gap-3 max-w-sm">
                  <FormField label="Bill in currency" htmlFor="billingCurrency">
                    <select
                      id="billingCurrency"
                      value={currency}
                      onChange={(e) => {
                        const next = e.target.value;
                        setCurrency(next);
                        setFxInfo(null);
                        setFxAuto(false);
                        if (next === "INR") { setExchangeRate(1); }
                        // Auto-fetch the latest ₹/unit the moment a foreign
                        // currency is picked — no stale hand-typed number.
                        else { setExchangeRate(1); void fetchLatestFx(next); }
                      }}
                      className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber/40"
                    >
                      {BILLING_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </FormField>
                  <FormField label="Exchange rate (₹ per unit)" htmlFor="billingRate">
                    <div className="flex items-center gap-1.5">
                      <Input
                        id="billingRate"
                        type="text"
                        inputMode="decimal"
                        value={String(exchangeRate)}
                        onChange={(e) => { setExchangeRate(parseFloat(e.target.value) || 1); setFxAuto(false); }}
                        disabled={!isForeign}
                        placeholder="₹ / unit"
                      />
                      {isForeign && (
                        <Button
                          type="button"
                          size="sm"
                          variant="default"
                          icon="refresh"
                          loading={fxLoading}
                          onClick={() => void fetchLatestFx(currency)}
                          title="Fetch the latest rate from the internet"
                        >
                          Latest
                        </Button>
                      )}
                    </div>
                  </FormField>
                </div>
                {/* Which price to bill on when an item has both a ₹ and a real USD price */}
                <div className="flex items-center gap-2 flex-wrap pt-0.5">
                  <span className="text-[11px] font-medium text-indigo-ink">Pricing basis:</span>
                  <div className="inline-flex rounded-md border border-indigo/30 bg-paper p-0.5">
                    {([["international", `International ${currency}`], ["india", `India rate → ${currency}`]] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setUsdPricingBasis(val)}
                        className={cn(
                          "px-2.5 py-1 text-[11px] rounded transition-colors",
                          usdPricingBasis === val ? "bg-indigo text-white font-medium" : "text-ink-3 hover:text-ink",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="text-[10px] text-ink-3">
                    {usdPricingBasis === "international"
                      ? `Each item uses its own ${currency} price when set; otherwise the ₹ price is converted.`
                      : `Every ₹ price is converted to ${currency} at this rate.`}
                  </span>
                </div>
                {fxMissing ? (
                  <p className="text-[11px] text-rose font-medium">
                    ⚠ Set the exchange rate (₹ per {currency}) — it&apos;s 1 right now, so the numbers will be wrong.
                    {fxLoading ? " Fetching the latest rate…" : " Or tap “Latest”."}
                  </p>
                ) : isForeign && fxAuto ? (
                  <p className="text-[11px] text-emerald">
                    ✓ Latest rate: <b>₹{exchangeRate}/{currency}</b>
                    {fxInfo?.asOf ? ` · as of ${fxInfo.asOf}` : ""} (auto — you can edit to override).
                    Books are recorded in ₹ (GST).
                  </p>
                ) : isForeign ? (
                  <p className="text-[11px] text-indigo-ink">
                    All amounts are now in <b>{currency}</b> — this is what the customer sees. Books are recorded in ₹ (GST).
                    Catalog items use their own {currency} price (set it in Items); otherwise the ₹ price is converted.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </Card>

      {/* Line Items card */}
      <Card flush>
        {/* Header row */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-hairline">
          <div>
            <div className="text-sm font-semibold">Line Items</div>
            <div className="text-xs text-ink-3 mt-0.5">{lineItems.length} item{lineItems.length === 1 ? "" : "s"}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="default" icon="layers" onClick={() => setBulkOpen(true)}>
              Bulk / many domains
            </Button>
            <Button size="sm" icon="plus" onClick={() => setAddOpen(true)}>
              Add item
            </Button>
          </div>
        </div>

        {/* Table */}
        {lineItems.length === 0 ? (
          <div className="p-12 text-center">
            <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-gradient-to-br from-amber-soft to-paper-2 grid place-items-center text-amber ring-1 ring-hairline">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="m7.5 4.27 9 5.15M21 8 12 13 3 8M3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8M12 22V13" />
              </svg>
            </div>
            <div className="font-serif text-lg mb-1">No line items yet</div>
            <p className="text-sm text-ink-3 mb-4">Add products from your catalog or enter custom items.</p>
            <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
              Add first item
            </Button>
          </div>
        ) : (
          <>
          {/* Mobile: each line item as a stacked, fully-editable card. The
              table below is a wide multi-field editor that side-scrolls
              badly on phones (§20). */}
          <div className="md:hidden divide-y divide-hairline">
            {lineItems.map((line) => {
              const commitment  = line.commitment ?? "annual_yearly";
              const unitLabel   = billingUnit;   // quote-level frequency (0161)
              const displayRate = Math.round(line.rate / billingN);
              const displayCost = Math.round(line.cost / billingN);
              const commitType: "monthly" | "annual" = commitment === "monthly" ? "monthly" : "annual";
              const lineDiscountPct = line.discount_pct ?? 0;
              const netRate  = line.rate * (1 - lineDiscountPct / 100);
              const lineMargin = computeMargin(line.cost * line.qty, netRate * line.qty);
              return (
                <div key={line.id} className="p-3 space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-sm text-ink">{line.name}</div>
                      {line.bulk && line.domains && line.domains.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setViewDomains({ name: line.name, domains: line.domains! })}
                          className="mt-0.5 text-[11px] text-amber-ink hover:underline inline-flex items-center gap-1"
                        >
                          ▸ {line.domains.length} domains · {line.domains.reduce((s, d) => s + d.seats, 0)} seats
                        </button>
                      )}
                    </div>
                    <IconButton icon="trash" aria-label="Remove line" size="sm" onClick={() => removeLine(line.id)} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Qty</span>
                      {line.bulk ? (
                        <div className="mt-0.5 px-2 py-1.5 text-sm tabular-nums text-ink border border-hairline rounded bg-paper-2/40">{line.qty}</div>
                      ) : (
                        <input
                          type="number" min={1} value={line.qty}
                          onChange={(e) => updateQty(line.id, parseInt(e.target.value) || 0)}
                          className="mt-0.5 w-full px-2 py-1.5 text-sm tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                        />
                      )}
                    </label>
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Rate {isUsdBill ? "$" : "₹"}{unitLabel}</span>
                      <input
                        type="number" min={0} step={isUsdBill ? "0.01" : "1"}
                        value={isUsdBill ? Number((displayRate / fxRate).toFixed(2)) : displayRate}
                        onChange={(e) => { const v = parseFloat(e.target.value) || 0; updateRate(line.id, (isUsdBill ? Math.round(v * fxRate) : Math.round(v)) * billingN); }}
                        className="mt-0.5 w-full px-2 py-1.5 text-sm tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Commit</span>
                      <select
                        value={commitType}
                        onChange={(e) => updateCommitment(line.id, e.target.value === "monthly" ? "monthly" : "annual_yearly")}
                        className="mt-0.5 w-full px-2 py-1.5 text-sm border border-hairline rounded bg-paper focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                      >
                        <option value="monthly">Monthly flex</option>
                        <option value="annual">Annual (1-yr)</option>
                      </select>
                    </label>
                    <label className="block">
                      <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Starts</span>
                      <input
                        type="date" value={line.start_date ?? ""}
                        onChange={(e) => updateStartDate(line.id, e.target.value)}
                        className="mt-0.5 w-full px-2 py-1.5 text-sm border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                      />
                    </label>
                    {!line.bulk && (
                      <label className="block col-span-2">
                        <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Domain (optional)</span>
                        <input
                          type="text" value={line.domain ?? ""}
                          onChange={(e) => updateDomain(line.id, e.target.value)}
                          placeholder="acme.in — where this subscription is set up"
                          className="mt-0.5 w-full px-2 py-1.5 text-sm border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                        />
                      </label>
                    )}
                  </div>
                  <div className="text-[11px] text-ink-3 inline-flex items-center gap-1 flex-wrap">
                    <span>Cost {isUsdBill ? "$" : "₹"}</span>
                    <input
                      type="number" min={0} step={isUsdBill ? "0.01" : "1"}
                      value={isUsdBill ? Number((displayCost / fxRate).toFixed(2)) : displayCost}
                      onChange={(e) => { const v = parseFloat(e.target.value) || 0; updateCost(line.id, (isUsdBill ? Math.round(v * fxRate) : Math.round(v)) * billingN); }}
                      className="w-14 px-1 py-0.5 text-[11px] text-right tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                    />
                    <span>/seat{unitLabel} · Margin {lineMargin.marginPct}%</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-hairline pt-2">
                    <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Amount</span>
                    <span className="font-medium text-sm tabular-nums">{fmtDispC(dispAmt(line.rate, line.qty, line.discount_pct ?? 0))}{billingN > 1 ? " /yr" : ""}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop / tablet table */}
          <table className="hidden md:table w-full">
            <thead className="bg-paper-2 border-b border-hairline">
              <tr>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Description</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-24">HSN</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-28">Qty</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-36">Rate</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-36">Amount</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((line) => {
                // Per-line discount → effective net rate (used for actual margin)
                const lineDiscountPct = line.discount_pct ?? 0;
                const netRate         = line.rate * (1 - lineDiscountPct / 100);
                const lineMargin      = computeMargin(line.cost * line.qty, netRate * line.qty);

                // Display unit depends on commitment + billing term.
                // Storage is always ₹/seat/YEAR — divide by invoicesPerYear for display.
                const commitment  = line.commitment ?? "annual_yearly";
                const unitLabel   = billingUnit;   // quote-level frequency (0161)
                const displayRate = Math.round(line.rate / billingN);
                const displayCost = Math.round(line.cost / billingN);
                const isPerInvoice = billingN > 1; // anything other than yearly invoice

                // When user edits, convert back to annual for storage
                const handleRateChange = (raw: number) => updateRate(line.id, raw * billingN);
                const handleCostChange = (raw: number) => updateCost(line.id, raw * billingN);

                // Commitment selector: "monthly" (flex) OR "annual". Flipping to
                // flex → "monthly"; flipping to annual → default annual_yearly
                // (the quote-level picker then sets the billing frequency).
                const commitType: "monthly" | "annual" = commitment === "monthly" ? "monthly" : "annual";
                const handleCommitTypeChange = (t: "monthly" | "annual") => {
                  updateCommitment(line.id, t === "monthly" ? "monthly" : "annual_yearly");
                };

                return (
                  <tr key={line.id} className="border-b border-hairline last:border-0">
                    <td className="p-3">
                      <div className="font-medium text-sm text-ink">{line.name}</div>
                      {line.bulk && line.domains && line.domains.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setViewDomains({ name: line.name, domains: line.domains! })}
                          className="mt-1 text-[11px] text-amber-ink hover:underline inline-flex items-center gap-1"
                        >
                          ▸ {line.domains.length} domains · {line.domains.reduce((s, d) => s + d.seats, 0)} seats — view
                        </button>
                      )}
                      <div className="text-[11px] text-ink-3 mt-0.5 tabular-nums flex items-center gap-1.5 flex-wrap">
                        <span>Cost {isUsdBill ? "$" : "₹"}</span>
                        <input
                          type="number"
                          min={0}
                          step={isUsdBill ? "0.01" : "1"}
                          value={isUsdBill ? Number((displayCost / fxRate).toFixed(2)) : displayCost}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value) || 0;
                            handleCostChange(isUsdBill ? Math.round(v * fxRate) : Math.round(v));
                          }}
                          className="w-16 px-1 py-0.5 text-[11px] text-right tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                        />
                        <span>/seat{unitLabel} · Margin {lineMargin.marginPct}%</span>
                      </div>
                      {/* Discounting is quote-level only (see totals sidebar). Any
                          per-line discount stored on legacy/imported quotes is still
                          honoured in the totals below, but there is no per-line editor. */}
                      {/* Commitment selector — annual vs monthly flex. This drives
                          the PRICE tier (Google Workspace pricing depends on the
                          commitment), so it stays a per-line choice. Billing cycle
                          (how often invoiced) is set once at the quote level. */}
                      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Commit</span>
                          <select
                            value={commitType}
                            onChange={(e) => handleCommitTypeChange(e.target.value as "monthly" | "annual")}
                            className="text-[11px] px-1.5 py-0.5 border border-hairline rounded bg-paper focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                          >
                            <option value="monthly">Monthly flex</option>
                            <option value="annual">Annual (1-yr)</option>
                          </select>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Starts</span>
                          <input
                            type="date"
                            value={line.start_date ?? ""}
                            onChange={(e) => updateStartDate(line.id, e.target.value)}
                            title="Service start date — leave blank to start on the payment date"
                            className="text-[11px] px-1.5 py-0.5 border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                          />
                        </div>
                        {/* Per-line domain — this subscription provisions against it
                            (Google Workspace / M365 / Zoho). Optional. Bulk lines carry
                            their own per-domain list instead. */}
                        {!line.bulk && (
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Domain</span>
                            <input
                              type="text"
                              value={line.domain ?? ""}
                              onChange={(e) => updateDomain(line.id, e.target.value)}
                              placeholder="acme.in (optional)"
                              title="Domain this subscription is set up on — optional"
                              className="text-[11px] px-1.5 py-0.5 w-36 border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                            />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="p-3 text-xs font-mono text-ink-3">998313</td>
                    <td className="p-2 text-right">
                      {line.bulk ? (
                        // Bulk: qty = Σ domain seats (read-only — edit domains, not qty).
                        <span className="inline-block w-20 px-2 py-1 text-sm text-right tabular-nums text-ink" title="Total seats across all domains">{line.qty}</span>
                      ) : (
                        <input
                          type="number"
                          min={1}
                          value={line.qty}
                          onChange={(e) => updateQty(line.id, parseInt(e.target.value) || 0)}
                          className="w-20 px-2 py-1 text-sm text-right tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                        />
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-xs text-ink-3">{isUsdBill ? "$" : "₹"}</span>
                        <input
                          type="number"
                          min={0}
                          step={isUsdBill ? "0.01" : "1"}
                          value={isUsdBill ? Number((displayRate / fxRate).toFixed(2)) : displayRate}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value) || 0;
                            handleRateChange(isUsdBill ? Math.round(v * fxRate) : Math.round(v));
                          }}
                          className="w-24 px-2 py-1 text-sm text-right tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                        />
                        <span className="text-[10px] text-ink-3 ml-0.5">{unitLabel}</span>
                      </div>
                    </td>
                    <td className="p-3 text-right tabular-nums text-sm font-medium">
                      {isPerInvoice ? (
                        <>
                          {/* Per-invoice amount = what customer pays each billing cycle */}
                          <div>{fmtDispC(dispAmt(displayRate, line.qty, lineDiscountPct))}{unitLabel}</div>
                          <div className="text-[10px] text-ink-3 font-normal">
                            = {fmtDispC(dispAmt(line.rate, line.qty, lineDiscountPct))}/yr
                            {lineDiscountPct > 0 && (
                              <span className="text-ink-3"> (was {fmtDispC(dispAmt(line.rate, line.qty))})</span>
                            )}
                          </div>
                        </>
                      ) : (
                        // Yearly bill — single annual invoice
                        <div>
                          {fmtDispC(dispAmt(line.rate, line.qty, lineDiscountPct))}
                          {lineDiscountPct > 0 && (
                            <div className="text-[10px] text-ink-3 font-normal line-through">
                              {fmtDispC(dispAmt(line.rate, line.qty))}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <IconButton
                        icon="trash"
                        aria-label="Remove line"
                        size="sm"
                        onClick={() => removeLine(line.id)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </>
        )}

        {/* Totals + Notes — only when we have items */}
        {lineItems.length > 0 && (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 p-4 border-t border-hairline">
            {/* Notes (left) */}
            <div>
              <label className="text-xs font-medium text-ink-2 block mb-1.5">Notes for customer</label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={isInvoiceMode
                  ? "Appears on the invoice — e.g. what the charge is for, payment terms."
                  : "Pricing valid for 30 days. Onboarding includes DNS, MX, SPF, DKIM, DMARC setup. Free training (2 sessions)."}
                rows={6}
              />
              <p className="text-[11px] text-ink-3 mt-1">Shown on customer-facing {isInvoiceMode ? "invoice" : "quote"} PDF.</p>

              {/* Terms & Conditions (Zoho-style) — document-level, separate from notes. */}
              <div className="mt-4">
                <label className="text-xs font-medium text-ink-2 block mb-1.5">Terms &amp; conditions</label>
                <Textarea
                  value={termsConditions}
                  onChange={(e) => setTermsConditions(e.target.value)}
                  placeholder="Your standard terms — e.g. late-payment interest, jurisdiction, warranty. Printed at the bottom of the document."
                  rows={3}
                />
              </div>
            </div>

            {/* Totals (right) */}
            <div className="bg-paper-2 rounded-lg p-4 space-y-2.5 self-start">
              {/* Customer discount is DERIVED from the rate: whenever a line's rate
                  is below its list price, the gap shows here as ₹ + %. There is no
                  separate discount input — you discount by lowering the rate. */}
              {customerDiscount > 0 && (
                <>
                  <TotalRow label="List price" value={fmtTotalC(dispListGross)} />
                  <div className="flex items-center justify-between text-sm text-emerald">
                    <span>Quote discount ({customerDiscountPct}%)</span>
                    <span className="tabular-nums">
                      −{fmtTotalC(dispCustomerDiscount)}
                    </span>
                  </div>
                </>
              )}
              <TotalRow label={customerDiscount > 0 ? "Subtotal (after discount)" : totalsLabel} value={fmtTotalC(dispSubtotal)} />

              <TotalRow label="Taxable amount" value={fmtTotalC(dispTaxable)} />

              {isExport ? (
                <div className="text-[11px] text-indigo-ink flex items-start gap-1 py-1">
                  <span>🌍</span>
                  <span>Export ({customer?.country}) → <b>zero-rated under LUT</b> · no GST (CGST/SGST/IGST) applies</span>
                </div>
              ) : (
                <div className="text-[11px] text-ink-3 italic flex items-center gap-1 py-1">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                  {interState ? `Different state → IGST applicable` : `Same state → CGST + SGST split`} @ {taxRate}%
                </div>
              )}

              {/* Foreign billing SUMMARY (read-only) — the currency + rate are set once
                  up top (Settings), so here we just confirm what the customer is billed. */}
              {isForeign && (
                <div className="rounded-md bg-indigo-soft/40 border border-indigo/20 p-2.5 my-1">
                  <p className="text-[11px] text-indigo-ink">
                    🌍 Customer billed in <b>{currency}</b> @ ₹{exchangeRate}/{currency} · books record <b>{rupee(total)}</b> (for GST)
                  </p>
                </div>
              )}

              {isExport ? null : interState ? (
                <TotalRow label={`IGST (${taxRate}%)`} value={fmtTotalC(dispTax)} />
              ) : (
                <>
                  <TotalRow label={`CGST (${taxRate / 2}%)`} value={fmtTotalC(dRound(dispTax / 2))} />
                  <TotalRow label={`SGST (${taxRate / 2}%)`} value={fmtTotalC(dRound(dispTax - dRound(dispTax / 2)))} />
                </>
              )}

              {/* Grand total — emphasizes "Total payable now" for annual upfront */}
              <div className="border-t border-hairline-strong pt-3 mt-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
                    {/* When all lines are annual_yearly (single yearly invoice),
                        the customer pays the FULL amount upfront — Indian SME default. */}
                    {!showPerInvoice && billingN === 1
                      ? "Total payable now"
                      : "Grand total"}
                  </span>
                  <div className="text-right">
                    <span className="font-serif text-3xl text-amber tabular-nums">
                      {showPerInvoice
                        ? fmtPayableC(dRound(dispTotal / billingN))
                        : fmtPayableC(dispTotal)}
                    </span>
                    {showPerInvoice && (
                      <div className="text-[11px] text-ink-3 font-normal mt-0.5">
                        per invoice ({billingN}/yr) · = {fmtPayableC(dispTotal)} / year
                      </div>
                    )}
                    {isForeign && (
                      <label className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-ink-3 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={roundTotal}
                          onChange={(e) => setRoundTotal(e.target.checked)}
                          className="rounded border-hairline"
                        />
                        Round off total
                      </label>
                    )}
                    {!showPerInvoice && billingN === 1 && (
                      <div className="text-[11px] text-emerald font-medium mt-0.5">
                        ✓ Single invoice · pay once for full year
                      </div>
                    )}
                    {isForeign && (
                      <div className="text-[11px] text-indigo-ink font-medium mt-0.5">
                        = {rupee(total)} in books (for GST) @ ₹{exchangeRate}/{currency}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Margin pill — flagged as an ESTIMATE: line costs default to an
                  assumed ≈70% (or catalog wholesale), not your actual procurement
                  cost, so we never show a guessed margin as hard fact. */}
              <div className="pt-3 mt-2 border-t border-hairline flex items-center justify-between">
                <span className="text-xs text-ink-3 uppercase tracking-wider font-semibold">Est. margin</span>
                <MarginPill margin={margin} variant="default" period="one-time" estimated />
              </div>
              <p className="mt-1 text-[10px] text-ink-3 text-right">
                Estimate — edit each line&apos;s cost to make this exact.
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* Bottom action row — all 3 send-shaped buttons save the quote first
          (status='sent') and then signal the detail page to open the right
          dialog via a ?send= query param. "Duplicate" stays placeholder
          until we wire a real duplicate flow. */}
      {lineItems.length > 0 && (
        <div className="order-last sticky bottom-0 z-20 -mx-4 -mb-4 flex items-center justify-between gap-3 flex-wrap border-t border-hairline bg-paper px-4 py-3 shadow-[0_-6px_16px_-10px_rgba(0,0,0,0.25)] md:-mx-6 md:-mb-6 md:px-6 lg:-mx-8 lg:-mb-8 lg:px-8">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">
              {!showPerInvoice && billingN === 1 ? "Total payable now" : "Total"}
            </span>
            <span className="font-serif text-2xl text-amber tabular-nums">
              {showPerInvoice ? fmtPayableC(dRound(dispTotal / billingN)) : fmtPayableC(dispTotal)}
            </span>
            {showPerInvoice && (
              <span className="text-[11px] text-ink-3">/invoice · {fmtPayableC(dispTotal)}/yr</span>
            )}
          </div>
          {isInvoiceMode ? (
            /* Invoice mode — one-time/recurring choice + a single "Create invoice". */
            <div className="flex gap-2 flex-wrap items-center">
              <div className="inline-flex rounded-lg border border-hairline bg-paper-2/40 p-1 text-xs">
                {[{ k: false, l: "One-time" }, { k: true, l: "Recurring" }].map((o) => (
                  <button
                    key={String(o.k)}
                    type="button"
                    onClick={() => setInvoiceRecurring(o.k)}
                    className={`px-3 py-1.5 rounded-md transition-colors ${
                      invoiceRecurring === o.k ? "bg-paper text-ink shadow-sm font-medium" : "text-ink-3 hover:text-ink"
                    }`}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
              <Button
                icon="file"
                onClick={() => {
                  if (lineItems.length === 0) { toast.error("Add at least one line item to preview"); return; }
                  setPreviewOpen(true);
                }}
              >
                Preview
              </Button>
              <Button
                variant="primary"
                icon="receipt"
                onClick={() => handleSubmit("sent")}
                loading={createQuote.isPending || generateInvoice.isPending}
                disabled={!customerId && !prospectName.trim()}
              >
                Create invoice
              </Button>
            </div>
          ) : (
          <div className="flex gap-2 flex-wrap">
          <Button variant="ghost" icon="copy" onClick={() => handleSubmit("draft")} loading={createQuote.isPending}>
            Save draft
          </Button>
          <Button
            icon="file"
            onClick={() => {
              if (lineItems.length === 0) { toast.error("Add at least one line item to preview"); return; }
              setPreviewOpen(true);
            }}
          >
            Preview
          </Button>
          <Button
            icon="mail"
            onClick={() => handleSubmit("sent", "email")}
            loading={createQuote.isPending}
            disabled={!isLeadMode && !customerId && !prospectName.trim()}
          >
            Send via email
          </Button>
          <Button
            icon="whatsapp"
            className="!text-[#25D366] !border-[#25D366] hover:!bg-[#25D366]/5"
            onClick={() => handleSubmit("sent", "whatsapp")}
            loading={createQuote.isPending}
            disabled={!isLeadMode && !customerId && !prospectName.trim()}
          >
            Send via WhatsApp
          </Button>
          <Button
            variant="primary"
            icon="send"
            onClick={() => handleSubmit("sent")}
            loading={createQuote.isPending}
            disabled={!isLeadMode && !customerId && !prospectName.trim()}
          >
            Save &amp; send quote
          </Button>
          </div>
          )}
        </div>
      )}

      {/* Add item modal */}
      <AddLineItemDialog open={addOpen} onOpenChange={setAddOpen} onAdd={addLine} currency={currency} exchangeRate={exchangeRate} pricingBasis={usdPricingBasis} />
      {/* "New customer" from the picker — auto-selects the created customer. */}
      <AddCustomerForm
        open={addCustomerOpen}
        onOpenChange={setAddCustomerOpen}
        onCreated={(newId) => { setCustomerId(newId); setProspectName(""); }}
      />
      <BulkDomainsDialog open={bulkOpen} onOpenChange={setBulkOpen} catalog={catalog} customerId={customerId} onAdd={addLine} />
      <ViewDomainsDialog
        open={!!viewDomains}
        onOpenChange={(o) => { if (!o) setViewDomains(null); }}
        planName={viewDomains?.name ?? ""}
        domains={viewDomains?.domains ?? []}
      />

      {/* Customer-facing quote preview — shows placeholder ID before save */}
      <QuotePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        tenantName={currentUser?.tenantName    ?? "Workspace"}
        tenantGstin={currentUser?.tenantGstin}
        tenantEmail={currentUser?.tenantEmail}
        tenantPhone={currentUser?.tenantPhone}
        tenantAddress={currentUser?.tenantAddress}
        quoteId={quoteId ?? "(pending)"}
        customerName={isLeadMode ? (leadCompany ?? "Prospect") : (customer?.name ?? prospectName.trim() ?? "—")}
        contactName={isLeadMode ? leadContact : null}
        contactEmail={isLeadMode ? leadEmail : null}
        contactPhone={isLeadMode ? leadPhone : null}
        lineItems={lineItems}
        subtotal={subtotal}
        discountPct={0}
        discount={0}
        taxable={taxable}
        taxRate={effectiveTaxRate}
        tax={tax}
        total={total}
        interState={interState}
        isExport={isExport}
        currency={currency}
        exchangeRate={exchangeRate}
        billingCycle={effectiveCycle}
        termsConditions={termsConditions}
        validityDays={validityDays}
        notes={notes}
        isProspect={isLeadMode}
      />
    </div>
  );
}

// ============================================================
// TotalRow helper
// ============================================================
function TotalRow({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "rose" }) {
  return (
    <div className="flex justify-between items-baseline text-sm">
      <span className="text-ink-3">{label}</span>
      <span className={cn(
        "tabular-nums",
        tone === "emerald" && "text-emerald",
        tone === "rose" && "text-rose"
      )}>{value}</span>
    </div>
  );
}
