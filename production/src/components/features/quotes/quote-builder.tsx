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

import { istToday, addDaysISO } from "@/lib/dates/ist";
import * as React from "react";
import { convertRateForCommitment, isAnnualTier } from "@/lib/quotes/commitment-rate";
import { storedLineRate, quoteTotalsDivisor, lineAmountSuffix } from "@/lib/quotes/line-rate-unit";
import { perInvoiceDivisor } from "@/lib/pdf/invoice-divisor";
import { useDraftGuard } from "@/lib/hooks/useDraftGuard";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/ui/label";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { MarginPill, computeMargin } from "@/components/features/margin-pill";
import { GeminiCard } from "@/components/shared/gemini-card";
import { AddLineItemDialog } from "@/components/features/quotes/add-line-item-dialog";
import { BulkDomainsDialog } from "@/components/features/quotes/bulk-domains-dialog";
import { domainLineYears, isDomainPurchaseLine } from "@/lib/provisioning/products";
import { ViewDomainsDialog } from "@/components/features/quotes/view-domains-dialog";
import { matchLeadToCustomer, matchNote } from "@/lib/quotes/match-customer";
import { SUPPORT_TIERS, findSupportSku, isSupportSkuId } from "@/lib/support/tiers";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { useCustomers } from "@/lib/queries/customers";
import { CustomerCombobox } from "@/components/features/customers/customer-combobox";
import { AddCustomerForm } from "@/components/features/customers/add-customer-form";
import { useCreateQuote, useQuote } from "@/lib/queries/quotes";
import { useGenerateInvoice } from "@/lib/queries/invoices";
import { useUpdateLead, useLeads } from "@/lib/queries/leads";
import { stageAfterQuoteSent } from "@/lib/leads/stage-after-quote-sent";
import { useItems } from "@/lib/queries/items";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isInterStateSupply, isExportSupply } from "@/lib/gst/place-of-supply";
import { hsnSummary } from "@/lib/gst/hsn";
import { Kbd } from "@/components/ui/kbd";
import { shortcutText } from "@/lib/keyboard/shortcuts";
import { COUNTRIES } from "@/lib/gst/countries";
import { BILLING_CURRENCIES, isForeignCurrency, formatForeign } from "@/lib/currency";
import { addOrMergeLine } from "@/lib/quotes/line-items";
import { lineFromCatalog, catalogYearlyPrice } from "@/lib/quotes/catalog-line";
import { headlinePrice } from "@/lib/catalog/headline-price";
import { suggestPlanProducts, productSupportSku, supplyStateMissing } from "@/lib/quotes/quote-assist";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { rupee, formatDate, GST_STATE_BY_CODE } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { QuoteLineItem, LineCommitment, BillingCycle, Item } from "@/lib/supabase/database.types";
import {
  BILLING_CYCLE_OPTIONS, cycleInvoicesPerYear, cycleUnitLabel,
} from "@/lib/quotes/billing";
import { slabPricing, nextSlabUpsell } from "@/lib/quotes/volume-tiers";
import { leadQuoteName, PLACEHOLDER_QUOTE_NAME } from "@/lib/quotes/quote-party-name";
import { SolutionPackagePicker } from "@/components/features/quotes/solution-package-picker";
import { SupportPlanPicker } from "@/components/features/quotes/support-plan-picker";
import { canEditSupportCatalog } from "@/lib/support/catalog-row";
import { WORKSPACE_LIST_PRICE_PM, floorWorkspaceRow } from "@/lib/catalog/workspace-floor";

/** R-156: show the term picker on a domain REGISTRATION line — by its name too, so it is there
 *  before the domain is typed (isDomainPurchaseLine needs the name filled in). */
const isRegistrationLine = (l: QuoteLineItem) =>
  !l.bulk && (isDomainPurchaseLine(l) || /\b(domain|registration)\b/i.test(l.name ?? ""));

// Quote IDs are allocated at SAVE time via the central document-numbering RPC
// (see migration 0004_document_series.sql) — this guarantees sequential per-tenant
// per-fiscal-year numbering, race-safe, and no wasted numbers from abandoned drafts.
// Before save, the UI shows a placeholder.

// Plan → monthly price per seat (same map used in Add Lead form).
// Cost approximated at 70% of rate (≈30% reseller margin); user can edit per line.
const PLAN_PRICE_PER_SEAT_PM: Record<string, number> = {
  /* R-205: GW list prices come from ONE place (lib/pricing/workspace.ts) — this map used
     to carry its own ₹136 / ₹736, under cost. */
  "Google Workspace Business Starter": WORKSPACE_LIST_PRICE_PM.starter,
  "Google Workspace Standard":         WORKSPACE_LIST_PRICE_PM.standard,
  "Google Workspace Plus":             WORKSPACE_LIST_PRICE_PM.plus,
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
  const pathname     = usePathname();
  const { data: customers, isLoading: customersLoading } = useCustomers();
  // Subscription quotes only pull recurring items — one-time products live in
  // the separate Items Catalog and are quoted via project quotes.
  const { data: allCatalog } = useItems();
  /* R-205: a GW Starter/Standard/Plus row under the list price (the old ₹136 seed) is lifted
     to the list price here, so the product chips, the lead prefill and every added line quote
     ₹270 / ₹1,080 / ₹1,380 — never a loss-making price. */
  const catalog = React.useMemo(
    () => (allCatalog ?? []).filter((c) => c.item_type !== "one_time").map((c) => floorWorkspaceRow(c)),
    [allCatalog],
  );
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
  /* ── In-place edit of a DRAFT ────────────────────────────────────────────────
     Read from the path, not from a prop, because this component takes none — it
     configures itself entirely from the URL, and adding one prop for one caller would
     split that rule in half. Mounted at /quotes/<id>/edit; the pathname is matched
     exactly so mounting the builder under some other `[id]` route can never be mistaken
     for "edit this".

     Editing vs duplicating is the same prefill and a different SAVE: duplicate allocates
     a fresh quote number, edit keeps this one. The draft-only guard lives in
     lib/quotes/editable.ts and is enforced by the route before this ever renders. */
  const editOf = React.useMemo(() => {
    const m = /^\/quotes\/([^/]+)\/edit\/?$/.exec(pathname ?? "");
    return m ? decodeURIComponent(m[1]) : null;
  }, [pathname]);
  const prefillFrom = duplicateOf ?? editOf;
  const urlCustomer       = searchParams.get("customer");  // Customer 360 → "Add service"
  // Invoice mode (?invoice=1): the same builder, but on save it generates a GST
  // invoice immediately (a "direct invoice") instead of just saving a quote.
  const isInvoiceMode     = searchParams.get("invoice") === "1";
  const [invoiceRecurring, setInvoiceRecurring] = React.useState(false);
  // The route's static <title> says "New Quote"; correct it in invoice mode.
  React.useEffect(() => {
    if (isInvoiceMode) document.title = "New Invoice · ResellerOS";
  }, [isInvoiceMode]);
  const { data: sourceQuote } = useQuote(prefillFrom ?? undefined);

  // Look up the lead from the cached useLeads() query so the operator can
  // navigate to /quotes/new?lead=L-XXX with JUST the ID — we fill in the
  // rest from the lead row. This makes the URL bookmarkable / shareable
  // and unblocks the "type URL" workflow that was hitting "No customers yet".
  /**
   * Which lead this quote belongs to, however we arrived here.
   *
   * `leadId` is the URL only. On the EDIT and DUPLICATE paths there is no `?leadId=` — the
   * link lives on the quote being copied — so `leadId` was null while `isLeadMode` was true
   * (it reads sourceQuote.lead_id). Two things went wrong with that split, both found by
   * opening a lead-linked draft on 24 Aug 2026:
   *
   *   1. `leadFromQuery` was null, so the prospect Company / Contact / Phone / Email fields
   *      loaded EMPTY on a quote that had them — the operator retypes what the app already
   *      knows, or sends a quote with the contact blank. It did NOT delete anything: the
   *      contact-sync writes are gated on `isLeadMode && leadId`, and the same null `leadId`
   *      that emptied the fields also skipped the write. Worth stating plainly because the
   *      first read of this looked like silent data loss and it is not; the two bugs share a
   *      cause and cancelled each other's worst outcome.
   *   2. Duplicating a prospect quote wrote `lead_id: null` (line ~911 falls back to the
   *      source only when `editOf`), producing exactly the orphan quotes that started this
   *      whole investigation — a quote for a lead, attached to no lead.
   */
  const { data: allLeads } = useLeads();
  const linkedLeadId = leadId ?? sourceQuote?.lead_id ?? null;
  const leadFromQuery = React.useMemo(() => {
    if (!linkedLeadId || !allLeads) return null;
    return allLeads.find((l) => l.id === linkedLeadId) ?? null;
  }, [linkedLeadId, allLeads]);

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
  /* Lead contact shows as one summary card; Edit opens the fields (2 Oct 2026). */
  const [editProspect, setEditProspect] = React.useState(false);
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
  /* R-278: a lead with no company is still somebody. Company -> contact -> email -> phone,
     so the quote is saved, previewed and headed with a real name instead of "Prospect". */
  const leadDisplayName = leadQuoteName({
    company: leadCompany, contact_name: leadContact, contact_email: leadEmail, contact_phone: leadPhone,
  });

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

  /* ── A prefilled company with no leadId must still be VISIBLE ──────────────
     `?company=…` fills `leadCompany`, but that state is only rendered inside the
     "Prospect Details" card, which only appears when isLeadMode is true — and
     isLeadMode needs a leadId. So arriving from anywhere that prefills a company
     WITHOUT a lead (the Enquiries "Send quote" button, the support upsell link)
     put the name into state nothing renders: the operator saw an empty Customer
     Details card and typed it again, or sent a quote addressed to "Prospect".

     Seeding prospectName is the whole fix, because that field is already what gets
     saved as customer_name for a non-customer quote (see handleSubmit). Runs once
     via the ref so the operator can clear or change it afterwards. */
  const seededProspectRef = React.useRef(false);
  React.useEffect(() => {
    if (seededProspectRef.current) return;
    if (isLeadMode || customerId) return;          // those paths have their own field
    if (!leadCompanyInit.trim()) return;
    seededProspectRef.current = true;
    setProspectName(leadCompanyInit.trim());
    setCustMode("prospect");
  }, [isLeadMode, customerId, leadCompanyInit]);

  /* ── ARRIVING FROM A LEAD: FIND THE CUSTOMER, OR OPEN THE RIGHT TAB ─────────
     Reported as "existing customer selected nahi aata", and it was two faults with one
     symptom. The effect above returns early on `isLeadMode`, so a quote started from a
     lead left this toggle on its initial "existing" with an empty dropdown — and nothing
     ever moved it.

       • The lead IS already a customer → nothing looked it up. The operator had to find
         their own customer in a dropdown, on a page they reached FROM that customer.
       • The lead is NOT a customer → there was nothing to select. "Demo1 Company" is at
         stage `contact` and none of this tenant's four customers is it, so the form was
         sitting on a tab that could never be satisfied.

     Both are now decided once, on arrival. The matching rule and its refusals live in
     lib/quotes/match-customer.ts with tests: email is trusted, an exact name is trusted
     once, and nothing else is guessed — a wrong preselection silently addresses a quote,
     and then an invoice, to somebody else.

     Runs once via the ref so the operator can change it freely afterwards. */
  const leadMatchRef = React.useRef(false);
  const [leadMatchNote, setLeadMatchNote] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (leadMatchRef.current) return;
    if (!isLeadMode || customerId) return;
    if (customersLoading) return;                  // deciding on an empty book finds nothing
    if (!leadCompanyInit.trim() && !leadEmailInit.trim()) return;

    leadMatchRef.current = true;
    const match = matchLeadToCustomer(
      { company: leadCompanyInit, contactEmail: leadEmailInit },
      customers ?? [],
    );

    if (match.kind === "none") {
      /* No customer to pick. Open the tab that CAN be completed, with the name already in
         it, rather than leaving an empty dropdown the operator must diagnose. */
      setCustMode("prospect");
      setProspectName(leadCompanyInit.trim());
      return;
    }

    setCustomerId(match.customerId);
    setCustMode("existing");
    setLeadMatchNote(
      matchNote(match, (customers ?? []).find((c) => c.id === match.customerId)?.name),
    );
  }, [isLeadMode, customerId, customersLoading, customers, leadCompanyInit, leadEmailInit]);
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
  // R-100: validity / terms + GST show as one line; the boxes open only on "Change".
  const [termsOpen, setTermsOpen] = React.useState(false);
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
        toastError(data.error, {
          fallback: "Couldn't fetch the latest rate.",
          description: "Type the exchange rate in the rate box yourself — the quote works the same.",
        });
        return;
      }
      setExchangeRate(data.rate);
      setFxInfo({ asOf: data.asOf ?? null });
      setFxAuto(true);
      toast.success(`Latest rate: ₹${data.rate}/${c}`);
    } catch {
      toast.error("Couldn't reach the rates service.", {
        description: "Check your internet, or type the exchange rate in the rate box yourself.",
      });
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

  // No react-hook-form here, so "dirty" is defined explicitly: a line item
  // added, or a customer chosen. Deliberately NOT every keystroke — a quote
  // where somebody typed one character into a search box is not work worth
  // interrupting them to protect, and a prompt that fires when it should not
  // is one users learn to click through, including when it is right.
  useDraftGuard(lineItems.length > 0 || customerId !== "" || prospectName.trim() !== "");

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
      /* R-369: "annualRate" is the line's STORED unit — the year on an annual line, one
         month on a flex ("monthly") line. ×12 on a flex line re-priced every saved flex
         quote to twelve months the moment it was opened for editing. */
      const lineCommitment = l.commitment ?? "annual_yearly";
      let annualRate: number, annualCost: number;
      const usd = it.prices?.usd;
      if (usdMode && usdPricingBasis === "international" && usd && usd.msrp > 0) {
        annualRate = storedLineRate(usd.msrp * fx, lineCommitment);
        annualCost = storedLineRate(usd.wholesale * fx, lineCommitment);
      } else if (headlinePrice(it).unit === "yr") {
        /* A yearly-total plan (support "(Yearly)", msrp 0). msrp × 12 here re-priced it
           to ₹0 the moment this effect re-ran (2 Oct 2026). */
        const p = catalogYearlyPrice(it);
        annualRate = p.rate;
        annualCost = p.cost;
      } else {
        const tier = it.prices?.[lineCommitment === "monthly" ? "monthly" : "annual"];
        annualRate = storedLineRate(tier?.msrp ?? it.msrp, lineCommitment);
        annualCost = storedLineRate(tier?.wholesale ?? it.wholesale, lineCommitment);
      }
      /* Keep the line's discount: a package (or a rep) priced it below list, and a
         currency switch must move the list price, not erase the discount (2 Oct 2026). */
      const listBefore = l.list_rate ?? l.rate;
      const ratio = listBefore > 0 && l.rate < listBefore ? l.rate / listBefore : 1;
      const rate = Math.round(annualRate * ratio);
      return l.rate === rate && l.cost === annualCost && (l.list_rate ?? l.rate) === annualRate
        ? l
        : { ...l, rate, list_rate: annualRate, cost: annualCost };
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currency, exchangeRate, catalog, usdPricingBasis]);

  const [addOpen, setAddOpen] = React.useState(false);
  const [addCustomerOpen, setAddCustomerOpen] = React.useState(false);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [packageOpen, setPackageOpen] = React.useState(false);
  const [viewDomains, setViewDomains] = React.useState<{ name: string; domains: Array<{ domain: string; seats: number }> } | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  // Quote ID is allocated at SAVE time via the central numbering RPC.
  // null = unassigned (shown as placeholder in header until save).
  const [quoteId, setQuoteId] = React.useState<string | null>(null);

  // Today's date (IST) as YYYY-MM-DD — the default service start date for new
  // line items (operator can still change or clear it). Cheap to recompute per
  // render; not memoised on purpose so an overnight session stays correct.
  const todayISO = istToday();

  // ── Pre-fill the line items (runs once — waits for catalog so we use real prices) ──
  //
  // Guarded on `leadCompany` ALONE, not on isLeadMode. The plan and seat count arrive
  // in the same URL as the company (?plan=&seats=), and requiring a leadId meant every
  // caller without one — the Enquiries "Send quote" button, the support upsell link —
  // had its product and quantity silently dropped along with the company name.
  // Whether the quote is linked to a lead is a separate question, answered by
  // isLeadMode where it matters: on save.
  const prefilledRef = React.useRef(false);
  React.useEffect(() => {
    if (prefilledRef.current) return;
    if (!leadCompany) return;
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
    let bandLabel: string | null = null;

    if (catalogItem) {
      /* Seat-slab volume pricing when the item has a band table, flat pricing when
         it does not — slabPricing() decides and reports which. VOLUME, not
         graduated: every seat bills at the band's rate. See lib/quotes/volume-tiers.ts. */
      const priced = slabPricing(catalogItem, seatsNum);
      if (priced.msrpPerSeatMonth > 0) {
        rate      = Math.round(priced.msrpPerSeatMonth * 12);
        cost      = Math.round(priced.wholesalePerSeatMonth * 12);
        source    = "catalog";
        bandLabel = priced.label;
      }
    }

    // 2. Fallback to the hardcoded plan map — tries exact then substring match too.
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
        rate = monthlyPPS * 12;
        /* Cost stays 0 — DELIBERATELY, and this is the important line in the block.
           It used to be `Math.round(rate * 0.7)`, a guess that manufactured a 30%
           margin out of nothing and displayed it in the same pill as a real one. A
           rep discounting against that number was negotiating against fiction.
           There is no catalogue row here, so the vendor cost is genuinely unknown;
           0 makes the quote's margin visibly wrong (100%) instead of plausibly
           wrong, and `costMissing` below turns that into a banner naming the fix. */
        cost   = 0;
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
      if (source === "catalog") {
        toast.success(
          `Pre-filled from catalog: ${seatsNum} × ${leadPlan} @ ₹${rate}/seat/yr`,
          bandLabel ? { description: `Volume band applied: ${bandLabel}.` } : undefined,
        );
      } else {
        /* §24 — say what happened, why, and where to fix it. The old copy said
           "using fallback", which reads as "handled" rather than "your margin is
           not real". */
        toast.warning(`${leadPlan} is not in your catalogue — cost is unknown`, {
          description: `Priced at the standard ₹${rate}/seat/yr, but margin cannot be worked out until this plan has a catalogue row. Add it, or type the cost on the line.`,
          action: { label: "Open catalogue", onClick: () => router.push("/items" as any) },
          duration: 10_000,
        });
      }
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

  // ── Pre-fill from existing quote (Duplicate / Revise & resend / in-place Edit) ──
  const duplicatedRef = React.useRef(false);
  React.useEffect(() => {
    if (duplicatedRef.current) return;
    if (!prefillFrom || !sourceQuote) return;

    duplicatedRef.current = true;

    /* Editing keeps the quote's own number. handleSubmit reuses `quoteId` when it is
       already set instead of calling next_document_number, and useCreateQuote turns an
       insert that hits the existing primary key into an update of that row — the path it
       already used for "Save as draft, then Send". So seeding this one value is what makes
       edit an edit rather than a second quote. */
    if (editOf) setQuoteId(editOf);

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

    /* ── The fields this effect used to leave behind ─────────────────────────────
       Harmless while this only ever DUPLICATED (a fresh quote starting at INR and a
       blank place-of-supply is merely inconvenient). Not harmless once the same effect
       feeds an in-place EDIT: whatever it fails to load is written back as its default,
       so an untouched Save would quietly reset it. A ₹-only reset on a USD quote and a
       blanked prospect state are both money bugs — the second one decides IGST versus
       CGST+SGST on the tax invoice.
       Copying them is right for a duplicate too: a copy of a USD quote should be USD. */
    if (sourceQuote.currency)             setCurrency(sourceQuote.currency);
    if (sourceQuote.exchange_rate != null && sourceQuote.exchange_rate > 0) {
      setExchangeRate(sourceQuote.exchange_rate);
    }
    if (sourceQuote.prospect_state_code)  setProspectStateCode(sourceQuote.prospect_state_code);
    if (sourceQuote.prospect_country)     setProspectCountry(sourceQuote.prospect_country);
    /* Typed-prospect name — only when there is no customer record to name it instead,
       otherwise the customer's own name wins downstream and this would be dead state. */
    if (!sourceQuote.customer_id && sourceQuote.customer_name) {
      setProspectName(sourceQuote.customer_name);
    }

    toast.success(
      editOf
        ? `Editing draft ${sourceQuote.id} — changes replace this quote`
        : `Revising ${sourceQuote.id} — edit anything, then Save & send`,
    );
  }, [prefillFrom, editOf, sourceQuote]);

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
    /* A customer's GSTIN proves their state — 36 of 41 GSTIN customers had no
       state_code on file, so the GSTIN prefix is the fallback (2 Oct 2026). */
    : (customerId ? (customer?.state_code || stateCodeFromGstin(customer?.gstin) || null) : (prospectStateCode || null));
  const interState = isInterStateSupply(buyerStateCode, currentUser?.tenantStateCode, { customerGstin: customerId ? customer?.gstin : null, sellerGstin: currentUser?.tenantGstin });

  // Selling gross = the (negotiated) rate × qty. This is the actual revenue and
  // what gets billed / drives MRR — so it stays the subtotal.
  const grossSubtotal     = lineItems.reduce((s, it) => s + it.qty * it.rate, 0);
  // Legacy per-line discount (UI removed; still honoured for old/imported quotes).
  const lineDiscountTotal = lineItems.reduce((s, it) => s + Math.round(it.qty * it.rate * ((it.discount_pct ?? 0) / 100)), 0);
  const subtotal          = grossSubtotal - lineDiscountTotal;
  const totalCost         = lineItems.reduce((s, it) => s + it.qty * it.cost, 0);
  /* Lines that are actually being SOLD but whose cost nobody knows. A ₹0 line is
     excluded — a free line legitimately costs nothing, and flagging it would train
     people to dismiss the banner. A support plan is excluded too: it is our own
     service, so ₹0 is its real cost. */
  const costUnknown       = (it: { cost: number; rate: number; item_id?: string | null }) =>
    it.cost <= 0 && it.rate > 0 && !isSupportSkuId(it.item_id);
  const costlessLines     = lineItems.filter(costUnknown);
  /* One-tap product chips for an empty quote, from the lead's interest. */
  const planChips         = suggestPlanProducts(catalog, leadPlan);
  const chipSeats         = leadSeats && parseInt(leadSeats, 10) > 0 ? parseInt(leadSeats, 10) : null;
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
  /* Short name for the one-line summary under the totals (R-100). */
  const cycleLabel = ({ yearly: "Billed yearly", half_yearly: "Billed half-yearly", quarterly: "Billed quarterly", monthly: "Billed monthly" } as Record<string, string>)[effectiveCycle] ?? "Billed yearly";
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
  /* R-369: what the stored totals are divided by for one invoice — the PDF's own rule
     (first line's commitment). An annual quote billed monthly stores the YEAR (÷12); a
     flex quote stores one MONTH (÷1). Dividing a flex total by 12 showed a twelfth. */
  const totalsDiv   = quoteTotalsDivisor(billingN, lineItems);
  const totalsYear  = (stored: number) => stored * (billingN / totalsDiv);
  // Per-invoice-aware formatter for a DISPLAY-currency STORED figure.
  const fmtTotalC = (annualDisp: number) =>
    showPerInvoice ? `${fmtDispC(dRound(annualDisp / totalsDiv))}${billingUnit}` : fmtDispC(annualDisp);
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
  /** Add several lines at once (solution package), reusing the merge rule per line. */
  const addLines = (incoming: QuoteLineItem[]) => {
    setLineItems((current) =>
      incoming.reduce((acc, line) => {
        const withList: QuoteLineItem = { ...line, list_rate: line.list_rate ?? line.rate, start_date: line.start_date ?? todayISO };
        return addOrMergeLine(acc, withList).lines;
      }, current),
    );
  };

  const updateQty = (id: string, qty: number) => {
    const nextQty = Math.max(1, qty);
    setLineItems((s) => s.map((l) => {
      if (l.id !== id) return l;

      /* Volume bands: crossing from 10 seats to 11 changes the price of EVERY seat,
         so the rate has to follow the quantity or the quote quietly bills the old
         band. Only lines still sitting on their catalogue price are re-priced — if
         the rep has typed a negotiated rate, that is the deal, and overwriting it
         because they added a seat would undo a decision they made on a call. */
      const item = l.item_id ? catalog.find((c) => c.id === l.item_id) : undefined;
      if (!item) return { ...l, qty: nextQty };
      /* Seat bands price the ANNUAL tier, in ₹/seat/YEAR. A flex line is per MONTH
         (R-369) and has no band table of its own — never re-price it from one. */
      if (!isAnnualTier(l.commitment)) return { ...l, qty: nextQty };

      const atOldQty = slabPricing(item, l.qty);
      const untouched = Math.round(atOldQty.msrpPerSeatMonth * 12) === l.rate;
      if (!untouched) return { ...l, qty: nextQty };

      const atNewQty = slabPricing(item, nextQty);
      const newRate = Math.round(atNewQty.msrpPerSeatMonth * 12);
      if (newRate === l.rate) return { ...l, qty: nextQty };

      toast.info(
        `${l.name}: ${nextQty} seats moves into the ${atNewQty.label ?? "standard"} band`,
        { description: `₹${l.rate}/seat/yr → ₹${newRate}/seat/yr, on every seat.` },
      );
      return {
        ...l,
        qty: nextQty,
        rate: newRate,
        list_rate: newRate,
        cost: Math.round(atNewQty.wholesalePerSeatMonth * 12),
      };
    }));
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
  /** R-156: a domain registration line's term. The register cron registers for exactly this. */
  const updateYears = (id: string, years: number) => {
    setLineItems((s) => s.map((l) => (l.id === id ? { ...l, years: years > 1 ? years : undefined } : l)));
  };
  /** What the customer may change on the public page. See LineAdjustControls. */
  const updateAdjustable = (id: string, patch: Partial<QuoteLineItem>) => {
    setLineItems((s) => s.map((l) => (l.id === id ? { ...l, ...patch } : l)));
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
            /* R-369: the tier is ₹/seat/MONTH. An annual line stores the year (×12); a
               flex line stores the month as-is — that is what the PDF, e-mail, accept
               page and record_payment read. `tier.msrp * 12` on a flex line was a
               twelvefold overcharge ("Payable each month ₹24,072" for ₹2,040). */
            const rate = storedLineRate(tier.msrp, commitment);
            return {
              ...l,
              commitment,
              rate,
              list_rate: rate,
              cost: storedLineRate(tier.wholesale, commitment),
            };
          }
        }
        /* No catalogue link, or the item has no price tier for this commitment.
           "Keep current rate" was right within a family and WRONG across one: a
           `monthly` line's rate is per seat per MONTH, an `annual_*` line's is per seat
           per YEAR (database.types.ts:1052, and three SQL tests pin it down). Switching
           annual → monthly used to leave a per-YEAR rate on a per-MONTH line — a
           twelvefold overcharge on a quote with nothing on screen to show it.

           Live proof: Q-TEST-2026-27-0009 carries commitment "monthly" with rate 3240
           and cost 1320 against a ₹270/₹110 catalogue, and its item's `prices` is `{}`
           — it took exactly this branch.

           This converts the UNIT, it does not choose a price: a real monthly-flex tier
           usually costs more than a twelfth of the annual rate, which is why the
           catalogue path above is preferred and untouched. Right unit beats twelve times
           wrong. */
        const conv = convertRateForCommitment({
          rate: l.rate, cost: l.cost, from: l.commitment, to: commitment,
        });
        /* The frozen list price is in the same unit as the rate (R-369) — convert it too,
           or a ₹3,240/yr list beside a ₹270/month rate reads as a ₹2,970 "discount". */
        const listConv = l.list_rate == null ? null : convertRateForCommitment({
          rate: l.list_rate, cost: 0, from: l.commitment, to: commitment,
        });
        return {
          ...l, commitment, rate: conv.rate, cost: conv.cost,
          ...(listConv ? { list_rate: listConv.rate } : {}),
        };
      }),
    );
  };
  const removeLine = (id: string) => {
    setLineItems((s) => s.filter((l) => l.id !== id));
  };

  // R-315: shared by the desktop Preview button and the phone "More" menu.
  const openPreview = () => {
    if (lineItems.length === 0) {
      toast.error("Add at least one line item to preview", {
        description: "Use Add item (Alt+A) first — the preview shows the quote the customer will get.",
      });
      return;
    }
    setPreviewOpen(true);
  };
  // Same rule the three send buttons always used — named once so the menu matches them.
  const sendDisabled = !isLeadMode && !customerId && !prospectName.trim();

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
      toast.error("Pick a customer or type a new prospect name", {
        description: "A quote needs someone to send it to. Use the customer box at the top.",
      });
      return;
    }
    if (lineItems.length === 0) {
      toast.error("Add at least one line item", {
        description: "Use Add item (Alt+A) to put a product or service on the quote.",
      });
      return;
    }
    /* GST guard (2 Oct 2026). With no place of supply the quote assumes CGST+SGST; a
       draft may wait for the state, a quote that goes to the customer may not. Only for a
       lead or typed prospect, where the state field is on this screen; an existing
       customer without one keeps the amber note (their record is fixed on /customers). */
    if (status === "sent" && !customerId && supplyStateMissing({ isExport, buyerStateCode })) {
      toast.error("Pick the customer's state first", {
        description: "The state decides CGST+SGST or IGST. You can still save this as a draft without it.",
      });
      document.getElementById(isLeadMode ? "leadState" : "state")?.focus();
      return;
    }

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
          toastError(seqErr, {
            fallback: "Couldn't get a quote number.",
            description: "Nothing was saved and no number was used up. Click the button again.",
          });
          return;
        }
        idToUse = newId;
        setQuoteId(newId);
      }

      // Resolve customer_name: lead → use lead.company. Else if customerId
      // picked → use that customer's name. Else (prospect mode) → use typed
      // prospect name. Validation upstream ensures one of these is present.
      /* `?? "Prospect"` only catches null/undefined, and lead-mode's company starts as an
         EMPTY STRING when no lead was loaded from the URL — which is every in-place edit,
         because the edit route has no query string. Saving an edited draft therefore wrote
         customer_name = "" and the quote lost the buyer's name. Measured: "EDITOR TEST CO"
         became "" on the first real save through this editor.
         So: trim-and-fall-through at each step, and let the row it is editing be the last
         word before the generic placeholder. */
      const resolvedCustomerName =
        (isLeadMode
          ? leadDisplayName
          : customer
            ? customer.name
            : prospectName.trim())
        || (editOf ? (sourceQuote?.customer_name?.trim() ?? "") : "")
        || PLACEHOLDER_QUOTE_NAME;

      const quote = await createQuote.mutateAsync({
        id: idToUse,
        customer_id:   isLeadMode ? null : (customerId || null),
        customer_name: resolvedCustomerName,
        /* Keep the lead linkage when editing in place: URL first, then the row itself.
           `isLeadMode` is NOT a safe gate here, and the first version of this fix used it
           and was wrong. isLeadMode is true when the URL carries ?leadId= OR when the
           SOURCE QUOTE has a lead and no customer — a fallback written for the duplicate
           flow. On the edit route there is no query string, so isLeadMode was true because
           of the row while `leadId` was null, and `isLeadMode ? leadId : …` therefore still
           resolved to null. An untouched Save would have detached the draft from its lead.
           Found by running it, not by reading it. */
        lead_id:       linkedLeadId,
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
        expires_date:  addDaysISO(istToday(), validityDays),
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
      if (isLeadMode && linkedLeadId && status === "sent") {
        try {
          const totalSeats = lineItems.reduce((s, l) => s + l.qty, 0);
          // Forward-only, through the same rule the two server-side send paths use. This line
          // was `stage: "quote"` unconditionally — which, on an upsell quote to a WON customer,
          // dragged them back into the pipeline and restarted their stage age. The judgement
          // now lives in exactly one file (lib/leads/stage-after-quote-sent.ts) instead of
          // three, which is the actual lesson of this whole bug.
          const move = stageAfterQuoteSent(leadFromQuery?.stage);
          await updateLead.mutateAsync({
            id: linkedLeadId,
            patch: {
              ...(move.nextStage !== null && { stage: move.nextStage }),
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
      } else if (isLeadMode && linkedLeadId && status === "draft") {
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
            await updateLead.mutateAsync({ id: linkedLeadId, patch: contactPatch });
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

  /* ── Ctrl+Enter sends, Alt+A adds a line ──────────────────────────────────
     Both are MODIFIED keypresses, and that is why they are safe inside a form: a bare
     letter here would fight every field on the page. It is also why they are handled
     separately from the global single-letter shortcuts, which deliberately bail out the
     moment an input has focus — these are meant to work WHILE you are typing a rate.

     Ctrl+Enter respects the same disabled condition as the button. A shortcut that can
     send a quote the button refuses to send is a shortcut that bypasses a guard — here,
     the one stopping a quote going out with no customer on it. */
  const canSendNow = isLeadMode || !!customerId || !!prospectName.trim();
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (!canSendNow || createQuote.isPending) return;
        e.preventDefault();
        void handleSubmit("sent");
        return;
      }
      if (e.altKey && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setAddOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSendNow, createQuote.isPending]);

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
              For <b className="text-ink">{isLeadMode ? (leadDisplayName || PLACEHOLDER_QUOTE_NAME) : (customer?.name ?? prospectName.trim() ?? "—")}</b>
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

      {/* Cost-unknown guardrail. Ranks ABOVE the loss and margin warnings on purpose:
          both of those are statements about the margin number, and if a line has no
          cost then that number is not a margin at all. Telling a rep "margin 100%,
          healthy" on a line whose cost nobody knows is exactly the failure this
          codebase keeps finding — a gap rendered as a confident value. */}
      {costlessLines.length > 0 && (
        <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-amber/60 bg-amber-soft p-3.5 text-xs shadow-sm">
          <Icon name="alert" size={18} className="shrink-0 text-amber-ink" />
          <div className="min-w-0 flex-1">
            <b className="text-amber-ink">
              {costlessLines.length === 1
                ? `"${costlessLines[0].name}" has no cost, so the margin below is not real.`
                : `${costlessLines.length} lines have no cost, so the margin below is not real.`}
            </b>
            <p className="mt-0.5 text-ink-2">
              These plans have no catalogue row, so what the vendor charges is unknown — the quote is
              showing 100% margin on them. Add them to the catalogue, or type the cost on each line.
            </p>
            <button
              type="button"
              onClick={() => router.push("/items" as any)}
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-hairline bg-paper px-2.5 py-1 text-2xs font-semibold text-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              Open catalogue
            </button>
          </div>
        </div>
      )}

      {/* Loss-making quote guardrail */}
      {lineItems.length > 0 && margin.margin < 0 && (
        <div className="mb-3 p-3.5 bg-rose-soft border border-rose/60 rounded-lg text-xs font-medium text-rose-ink flex items-center gap-2.5 shadow-sm">
          <Icon name="alert" size={18} className="shrink-0 text-rose" />
          <div>
            <b>⚠️ LOSS-MAKING QUOTE WARNING:</b> Your total quote price ({fmtDispC(taxable)}) is lower than wholesale cost ({fmtDispC(totalCost)}). Net Loss: {fmtDispC(Math.abs(margin.margin))}. Please review line item pricing before sending.
          </div>
        </div>
      )}

      {/* AI margin warning */}
      {lineItems.length > 0 && margin.marginPct >= 0 && margin.marginPct < 14 && (
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

              {/* The lead already carries who this is — show it as one card, open the
                  fields only to change them (2 Oct 2026: the form pushed the line items
                  below the fold on every lead quote). */}
              {!editProspect && leadCompany.trim() && (leadEmail.trim() || leadPhone.trim()) ? (
                <div className="flex items-start justify-between gap-3 rounded-md border border-hairline bg-paper-2/40 px-3 py-2.5">
                  <div className="min-w-0 text-sm">
                    <div className="font-medium text-ink truncate">{leadCompany}</div>
                    <div className="text-2xs text-ink-3 mt-0.5 break-words">
                      {[leadContact, leadPhone, leadEmail].filter((v) => v && v.trim()).join(" · ")}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" icon="edit" onClick={() => setEditProspect(true)}>Edit</Button>
                </div>
              ) : (
              <>
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
              </>
              )}

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
                    onChange={(e) => {
                      const g = e.target.value.toUpperCase();
                      setLeadGstin(g);
                      /* A valid GSTIN proves the state — fill it if nobody has. */
                      const fromGstin = stateCodeFromGstin(g);
                      if (fromGstin && !leadStateCode) setLeadStateCode(fromGstin);
                    }}
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
                <p className="text-2xs flex items-start gap-1 -mt-1 text-indigo-ink">
                  🌍 Export ({leadCountry}) → zero-rated under LUT, no GST
                </p>
              ) : leadStateCode && (
                <p className="text-2xs flex items-center gap-1 -mt-1">
                  {interState
                    ? <span className="text-amber-ink">⚠ Inter-state → IGST {taxRate}% will apply</span>
                    : <span className="text-emerald">✓ Intra-state → CGST + SGST split</span>}
                </p>
              )}

              <div className="flex gap-2 text-2xs text-ink-3 pt-1 border-t border-hairline">
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
                  {/* Why it was preselected. An unexplained selection on a money document
                      is one the operator has to verify by hand — which costs more than the
                      preselection saved. A name match says so and asks them to check. */}
                  {leadMatchNote && customerId && (
                    <p className="mt-1 text-3xs leading-snug text-emerald">{leadMatchNote}</p>
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
                <p className="text-3xs text-ink-3 mt-1">
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
                      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">Website</div>
                      <div className="text-sm text-ink-2 font-mono truncate">{customer?.domain || "—"}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">GSTIN</div>
                      <div className="text-sm text-ink-2 font-mono truncate">{customer?.gstin || "—"}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">Place of supply</div>
                      <div className="text-sm text-ink-2 truncate">{customer?.state || "—"}</div>
                    </div>
                  </div>
                  {customer && (
                    <p className="text-2xs mt-2.5 pt-2.5 border-t border-hairline/70 flex items-center gap-1">
                      {isExport ? (
                        <span className="text-indigo-ink">🌍 Export ({customer?.country}) → zero-rated under LUT, no GST</span>
                      ) : !buyerStateCode ? (
                        /* A picked customer is not the same as a KNOWN state: 36 of 41
                           customers carrying a GSTIN have no state_code on file. Without
                           one, isInterStateSupply() falls back to intra-state as a safe
                           default, and printing "✓ Intra-state" off that guess is how the
                           wrong head reaches an invoice — invisibly, because the 18% total
                           is identical and only GSTR-1 disagrees. */
                        <span className="text-amber-ink">
                          ⚠ No state on this customer — add one to fix the GST head. The {taxRate}% total is the same either way.
                        </span>
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
                    <p className="text-2xs flex items-center gap-1">
                      {isExport ? (
                        <span className="text-indigo-ink">🌍 Export ({prospectCountry}) → zero-rated under LUT, no GST</span>
                      ) : !prospectStateCode ? (
                        <span className="text-ink-3">Pick the customer&apos;s state so GST (CGST+SGST vs IGST) is correct.</span>
                      ) : !buyerStateCode ? (
                        /* A picked customer is not the same as a KNOWN state: 36 of 41
                           customers carrying a GSTIN have no state_code on file. Without
                           one, isInterStateSupply() falls back to intra-state as a safe
                           default, and printing "✓ Intra-state" off that guess is how the
                           wrong head reaches an invoice — invisibly, because the 18% total
                           is identical and only GSTR-1 disagrees. */
                        <span className="text-amber-ink">
                          ⚠ No state on this customer — add one to fix the GST head. The {taxRate}% total is the same either way.
                        </span>
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

        {/* R-100 (1 Oct 2026, Pardeep: "ye section khatam hi karna chahta hu"): the old
            Quote / Invoice Settings card is gone. Billing cycle, validity / terms and GST
            are one line under the totals ("Change" opens them). Only an EXPORT customer
            still gets a card here — currency + rate must be set before adding items. */}
        {isExport && (
        <Card title="International billing">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4 items-start">
            {/* International billing — set the currency + rate BEFORE adding items so
                the catalog picker shows each product's real USD price (books stay ₹). */}
            {(
              <div className="lg:col-span-2 rounded-md bg-indigo-soft/40 border border-indigo/20 p-3 space-y-2">
                <p className="text-2xs font-semibold text-indigo-ink">🌍 International billing · books stay in ₹</p>
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
                  <span className="text-2xs font-medium text-indigo-ink">Pricing basis:</span>
                  <div className="inline-flex rounded-md border border-indigo/30 bg-paper p-0.5">
                    {([["international", `International ${currency}`], ["india", `India rate → ${currency}`]] as const).map(([val, label]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setUsdPricingBasis(val)}
                        className={cn(
                          "px-2.5 py-1 text-2xs rounded transition-colors",
                          usdPricingBasis === val ? "bg-indigo text-white font-medium" : "text-ink-3 hover:text-ink",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <span className="text-3xs text-ink-3">
                    {usdPricingBasis === "international"
                      ? `Each item uses its own ${currency} price when set; otherwise the ₹ price is converted.`
                      : `Every ₹ price is converted to ${currency} at this rate.`}
                  </span>
                </div>
                {fxMissing ? (
                  <p className="text-2xs text-rose font-medium">
                    ⚠ Set the exchange rate (₹ per {currency}) — it&apos;s 1 right now, so the numbers will be wrong.
                    {fxLoading ? " Fetching the latest rate…" : " Or tap “Latest”."}
                  </p>
                ) : isForeign && fxAuto ? (
                  <p className="text-2xs text-emerald">
                    ✓ Latest rate: <b>₹{exchangeRate}/{currency}</b>
                    {fxInfo?.asOf ? ` · as of ${fxInfo.asOf}` : ""} (auto — you can edit to override).
                    Books are recorded in ₹ (GST).
                  </p>
                ) : isForeign ? (
                  <p className="text-2xs text-indigo-ink">
                    All amounts are now in <b>{currency}</b> — this is what the customer sees. Books are recorded in ₹ (GST).
                    Catalog items use their own {currency} price (set it in Items); otherwise the ₹ price is converted.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </Card>
        )}

      {/* Line Items card */}
      <Card flush>
        {/* Header row */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-hairline">
          <div>
            <div className="text-sm font-semibold">Line Items</div>
            <div className="text-xs text-ink-3 mt-0.5">{lineItems.length} item{lineItems.length === 1 ? "" : "s"}</div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="default" icon="package" onClick={() => setPackageOpen(true)}>
              Package
            </Button>
            <Button size="sm" variant="default" icon="layers" onClick={() => setBulkOpen(true)}>
              Bulk / many domains
            </Button>
            {/* The keys in this title came from the registry, not from a typist. The badge
                beside the label is hidden below `sm`, so on a narrow screen the title is
                the only place the shortcut appears — and a title reading the OLD keys is
                exactly the drift the registry exists to prevent. */}
            <Button size="sm" icon="plus" onClick={() => setAddOpen(true)} title={`Add item (${shortcutText("add-quote-item")})`}>
              Add item <Kbd keys={["Alt", "A"]} className="ml-1.5 hidden sm:inline-flex" />
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
            {planChips.length > 0 ? (
              <>
                {/* One tap per product the lead is interested in — the rep used to open
                    the catalogue and search for what the lead already said (2 Oct 2026). */}
                <p className="text-sm text-ink-3 mb-3">
                  {leadPlan ? <>Interested in <b className="text-ink">{leadPlan}</b>. </> : null}
                  Tap a plan to add it{chipSeats ? ` with ${chipSeats} seats` : ""}.
                </p>
                <div className="flex flex-wrap justify-center gap-2 mb-4">
                  {planChips.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => addLine(lineFromCatalog(it, { qty: chipSeats ?? undefined }))}
                      className="inline-flex flex-col items-start rounded-lg border border-hairline bg-paper px-3 py-2 text-left hover:border-amber hover:bg-amber-soft/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                    >
                      <span className="text-sm font-medium text-ink">{it.name}</span>
                      <span className="text-2xs text-ink-3 tabular-nums">{rupee(catalogYearlyPrice(it).rate)}/seat/yr</span>
                    </button>
                  ))}
                </div>
                <Button variant="default" icon="plus" onClick={() => setAddOpen(true)}>
                  Something else
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm text-ink-3 mb-4">Add products from your catalog or enter custom items.</p>
                <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
                  Add first item
                </Button>
              </>
            )}
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
              /* R-369: a flex line already IS one month; only an annual line is divided. */
              const lineDiv     = perInvoiceDivisor(billingN, commitment);
              const displayRate = Math.round(line.rate / lineDiv);
              const displayCost = Math.round(line.cost / lineDiv);
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
                          className="mt-0.5 text-2xs text-amber-ink hover:underline inline-flex items-center gap-1"
                        >
                          ▸ {line.domains.length} domains · {line.domains.reduce((s, d) => s + d.seats, 0)} seats
                        </button>
                      )}
                    </div>
                    <IconButton icon="trash" aria-label="Remove line" size="sm" onClick={() => removeLine(line.id)} />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Qty</span>
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
                      <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Rate {isUsdBill ? "$" : "₹"}{unitLabel}</span>
                      <input
                        type="number" min={0} step={isUsdBill ? "0.01" : "1"}
                        value={isUsdBill ? Number((displayRate / fxRate).toFixed(2)) : displayRate}
                        onChange={(e) => { const v = parseFloat(e.target.value) || 0; updateRate(line.id, (isUsdBill ? Math.round(v * fxRate) : Math.round(v)) * lineDiv); }}
                        className="mt-0.5 w-full px-2 py-1.5 text-sm tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                      />
                    </label>
                    <label className="block col-span-2">
                      <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Commit</span>
                      <select
                        value={commitType}
                        onChange={(e) => updateCommitment(line.id, e.target.value === "monthly" ? "monthly" : "annual_yearly")}
                        className="mt-0.5 w-full px-2 py-1.5 text-sm border border-hairline rounded bg-paper focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                      >
                        <option value="monthly">Monthly flex</option>
                        <option value="annual">Annual (1-yr)</option>
                      </select>
                    </label>
                  </div>
                  <LineBandNote line={line} catalog={catalog} />
                  <LineSupportToggle line={line} catalog={catalog} lineItems={lineItems} onAdd={addLine} />
                  {/* The rest is set once and rarely touched — folded so qty, rate and amount
                      lead the card (2 Oct 2026). */}
                  <details className="group rounded-md border border-hairline/70 px-2.5 py-1.5">
                    <summary className="cursor-pointer list-none flex items-center justify-between gap-2 text-2xs text-ink-3">
                      <span>More · starts {line.start_date ? formatDate(line.start_date) : "on payment"} · {isSupportSkuId(line.item_id) ? "own service" : costUnknown(line) ? "margin unknown" : `margin ${lineMargin.marginPct}%`}</span>
                      <Icon name="chevron_down" size={12} className="transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="mt-2 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Starts</span>
                      <input
                        type="date" value={line.start_date ?? ""}
                        onChange={(e) => updateStartDate(line.id, e.target.value)}
                        className="mt-0.5 w-full px-2 py-1.5 text-sm border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                      />
                    </label>
                    {!line.bulk && (
                      <label className="block col-span-2">
                        <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Domain (optional)</span>
                        <input
                          type="text" value={line.domain ?? ""}
                          onChange={(e) => updateDomain(line.id, e.target.value)}
                          placeholder="acme.in — where this subscription is set up"
                          className="mt-0.5 w-full px-2 py-1.5 text-sm border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                        />
                      </label>
                    )}
                    {isRegistrationLine(line) && (
                      <label className="block col-span-2">
                        <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Register for</span>
                        <select
                          value={domainLineYears(line)}
                          onChange={(e) => updateYears(line.id, Number(e.target.value))}
                          className="mt-0.5 w-full px-2 py-1.5 text-sm border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-amber focus:border-amber"
                        >
                          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((y) => <option key={y} value={y}>{y} year{y === 1 ? "" : "s"}</option>)}
                        </select>
                        {domainLineYears(line) > 1 && <span className="text-2xs text-ink-3">Rate = the price for all {domainLineYears(line)} years</span>}
                      </label>
                    )}
                    </div>
                  <div className="text-2xs text-ink-3 inline-flex items-center gap-1 flex-wrap">
                    <span>Cost {isUsdBill ? "$" : "₹"}</span>
                    <input
                      aria-label={`Cost for ${line.name}`}
                      type="number" min={0} step={isUsdBill ? "0.01" : "1"}
                      value={isUsdBill ? Number((displayCost / fxRate).toFixed(2)) : displayCost}
                      onChange={(e) => { const v = parseFloat(e.target.value) || 0; updateCost(line.id, (isUsdBill ? Math.round(v * fxRate) : Math.round(v)) * lineDiv); }}
                      className="w-14 px-1 py-0.5 text-2xs text-right tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                    />
                    {/* "Margin unknown" beats "Margin 100%" when cost is 0 — see the
                        cost-unknown banner above for why. */}
                    <span>
                      /seat{unitLabel} ·{" "}
                      {costUnknown(line)
                        ? <span className="font-semibold text-amber-ink">Margin unknown</span>
                        : <>Margin {lineMargin.marginPct}%</>}
                    </span>
                  </div>
                  <LineAdjustControls line={line} onChange={(p) => updateAdjustable(line.id, p)} />
                    </div>
                  </details>
                  <div className="flex items-center justify-between border-t border-hairline pt-2">
                    <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Amount</span>
                    <span className="font-medium text-sm tabular-nums">{fmtDispC(dispAmt(line.rate, line.qty, line.discount_pct ?? 0))}{lineAmountSuffix(commitment, billingN)}</span>
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

                // Display unit depends on commitment + billing term (R-369): an annual
                // line stores ₹/seat/YEAR and is divided by invoices-per-year; a flex
                // ("monthly") line stores ₹/seat/MONTH, which already IS one invoice.
                const commitment  = line.commitment ?? "annual_yearly";
                const unitLabel   = billingUnit;   // quote-level frequency (0161)
                const lineDiv     = perInvoiceDivisor(billingN, commitment);
                const displayRate = Math.round(line.rate / lineDiv);
                const displayCost = Math.round(line.cost / lineDiv);
                const isPerInvoice = billingN > 1; // anything other than yearly invoice
                /* Invoices this line's stored amount covers in a year: 1 for annual, 12 for flex. */
                const yearFactor  = billingN / lineDiv;

                // When user edits, convert back to the line's storage unit
                const handleRateChange = (perInvoice: number) => updateRate(line.id, perInvoice * lineDiv);
                const handleCostChange = (perInvoice: number) => updateCost(line.id, perInvoice * lineDiv);

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
                          className="mt-1 text-2xs text-amber-ink hover:underline inline-flex items-center gap-1"
                        >
                          ▸ {line.domains.length} domains · {line.domains.reduce((s, d) => s + d.seats, 0)} seats — view
                        </button>
                      )}
                      <div className="text-2xs text-ink-3 mt-0.5 tabular-nums flex items-center gap-1.5 flex-wrap">
                        <span>Cost {isUsdBill ? "$" : "₹"}</span>
                        <input
                          aria-label={`Cost for ${line.name}`}
                          type="number"
                          min={0}
                          step={isUsdBill ? "0.01" : "1"}
                          value={isUsdBill ? Number((displayCost / fxRate).toFixed(2)) : displayCost}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value) || 0;
                            handleCostChange(isUsdBill ? Math.round(v * fxRate) : Math.round(v));
                          }}
                          className="w-16 px-1 py-0.5 text-2xs text-right tabular-nums border border-hairline rounded bg-paper focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                        />
                        <span>
                          /seat{unitLabel} ·{" "}
                          {costUnknown(line)
                            ? <span className="font-semibold text-amber-ink">Margin unknown</span>
                            : <>Margin {lineMargin.marginPct}%</>}
                        </span>
                      </div>
                      <LineBandNote line={line} catalog={catalog} />
                      <LineSupportToggle line={line} catalog={catalog} lineItems={lineItems} onAdd={addLine} />
                  <LineAdjustControls line={line} onChange={(p) => updateAdjustable(line.id, p)} />
                      {/* Discounting is quote-level only (see totals sidebar). Any
                          per-line discount stored on legacy/imported quotes is still
                          honoured in the totals below, but there is no per-line editor. */}
                      {/* Commitment selector — annual vs monthly flex. This drives
                          the PRICE tier (Google Workspace pricing depends on the
                          commitment), so it stays a per-line choice. Billing cycle
                          (how often invoiced) is set once at the quote level. */}
                      <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                        <div className="flex items-center gap-1">
                          <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Commit</span>
                          <select
                            aria-label={`Commitment for ${line.name}`}
                            value={commitType}
                            onChange={(e) => handleCommitTypeChange(e.target.value as "monthly" | "annual")}
                            className="text-2xs px-1.5 py-0.5 border border-hairline rounded bg-paper focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                          >
                            <option value="monthly">Monthly flex</option>
                            <option value="annual">Annual (1-yr)</option>
                          </select>
                        </div>
                        <div className="flex items-center gap-1">
                          <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Starts</span>
                          <input
                            aria-label={`Start date for ${line.name}`}
                            type="date"
                            value={line.start_date ?? ""}
                            onChange={(e) => updateStartDate(line.id, e.target.value)}
                            title="Service start date — leave blank to start on the payment date"
                            className="text-2xs px-1.5 py-0.5 border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                          />
                        </div>
                        {/* Per-line domain — this subscription provisions against it
                            (Google Workspace / M365 / Zoho). Optional. Bulk lines carry
                            their own per-domain list instead. */}
                        {!line.bulk && (
                          <div className="flex items-center gap-1">
                            <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Domain</span>
                            <input
                              aria-label={`Domain for ${line.name}`}
                              type="text"
                              value={line.domain ?? ""}
                              onChange={(e) => updateDomain(line.id, e.target.value)}
                              placeholder="acme.in (optional)"
                              title="Domain this subscription is set up on — optional"
                              className="text-2xs px-1.5 py-0.5 w-36 border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                            />
                          </div>
                        )}
                        {isRegistrationLine(line) && (
                          <div className="flex items-center gap-1">
                            <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Register for</span>
                            <select
                              aria-label={`Registration years for ${line.name}`}
                              value={domainLineYears(line)}
                              onChange={(e) => updateYears(line.id, Number(e.target.value))}
                              title={domainLineYears(line) > 1 ? `Rate = the price for all ${domainLineYears(line)} years` : "Registration term"}
                              className="text-2xs px-1.5 py-0.5 border border-hairline rounded bg-paper text-ink focus:outline-none focus:ring-1 focus:ring-amber focus:border-amber"
                            >
                              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((y) => <option key={y} value={y}>{y} yr{y === 1 ? "" : "s"}</option>)}
                            </select>
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
                          aria-label={`Quantity for ${line.name}`}
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
                          aria-label={`Rate for ${line.name}`}
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
                        <span className="text-3xs text-ink-3 ml-0.5">{unitLabel}</span>
                      </div>
                    </td>
                    <td className="p-3 text-right tabular-nums text-sm font-medium">
                      {isPerInvoice ? (
                        <>
                          {/* Per-invoice amount = what customer pays each billing cycle */}
                          <div>{fmtDispC(dispAmt(displayRate, line.qty, lineDiscountPct))}{unitLabel}</div>
                          <div className="text-3xs text-ink-3 font-normal">
                            = {fmtDispC(dispAmt(line.rate * yearFactor, line.qty, lineDiscountPct))}/yr
                            {lineDiscountPct > 0 && (
                              <span className="text-ink-3"> (was {fmtDispC(dispAmt(line.rate * yearFactor, line.qty))})</span>
                            )}
                          </div>
                        </>
                      ) : (
                        // Yearly bill — single annual invoice
                        <div>
                          {fmtDispC(dispAmt(line.rate, line.qty, lineDiscountPct))}
                          {lineDiscountPct > 0 && (
                            <div className="text-3xs text-ink-3 font-normal line-through">
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
              <label htmlFor="qb-notes" className="text-xs font-medium text-ink-2 block mb-1.5">Notes for customer</label>
              <Textarea
                id="qb-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={isInvoiceMode
                  ? "Appears on the invoice — e.g. what the charge is for, payment terms."
                  : "Pricing valid for 30 days. Onboarding includes DNS, MX, SPF, DKIM, DMARC setup. Free training (2 sessions)."}
                rows={6}
              />
              <p className="text-2xs text-ink-3 mt-1">Shown on customer-facing {isInvoiceMode ? "invoice" : "quote"} PDF.</p>

              {/* Terms & Conditions (Zoho-style) — document-level, separate from notes. */}
              <div className="mt-4">
                <label htmlFor="qb-terms" className="text-xs font-medium text-ink-2 block mb-1.5">Terms &amp; conditions</label>
                <Textarea
                  id="qb-terms"
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
                <div className="text-2xs text-indigo-ink flex items-start gap-1 py-1">
                  <span>🌍</span>
                  <span>Export ({customer?.country}) → <b>zero-rated under LUT</b> · no GST (CGST/SGST/IGST) applies</span>
                </div>
              ) : (
                <div className="text-2xs text-ink-3 italic flex items-center gap-1 py-1">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                  {/* "Same state" is only true if we KNOW the state. With none on file
                      isInterStateSupply() answers intra-state as a conservative default,
                      and this line was printing that guess as a fact — while the GST-rate
                      helper a few fields up correctly said the head was still unknown.
                      Two labels on one screen, one of them wrong, is worse than either
                      alone: the operator believes the confident one. */}
                  {!buyerStateCode
                    ? `Pick the customer's state to fix the GST head — the ${taxRate}% total is the same either way`
                    : interState
                      ? `Different state → IGST applicable @ ${taxRate}%`
                      : `Same state → CGST + SGST split @ ${taxRate}%`}
                </div>
              )}

              {/* Billing cycle · validity / terms · GST — one line, boxes behind "Change" (R-100). */}
              <div className="py-1">
                {/* Valid / Expires / GST — R-100 (1 Oct 2026, Pardeep: "is section ki yaha koi
                    jarurat nahi"). 30 days and 18% are what nearly every quote uses, "Valid for"
                    and "Expires on" said one thing twice, and an always-open GST box is one typo
                    from a wrong total. So: one line with the values, boxes behind "Change". */}
                {!termsOpen ? (
                  <div className="min-w-0">
                    <div className="rounded-md border border-hairline bg-paper-2/60 px-3 py-2 text-xs text-ink-2 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                      <span>{cycleLabel}</span>
                      <span className="text-ink-3" aria-hidden>·</span>
                      {isInvoiceMode ? (
                        <span>
                          {paymentTermsDays === 0 ? "Due on receipt" : `Net ${paymentTermsDays}`}
                          {" · due "}
                          <b className="tabular-nums">{formatDate(new Date(Date.now() + paymentTermsDays * 86400000))}</b>
                        </span>
                      ) : (
                        <span>
                          Valid till{" "}
                          <b className="tabular-nums">{formatDate(new Date(Date.now() + validityDays * 86400000))}</b>
                        </span>
                      )}
                      <span className="text-ink-3" aria-hidden>·</span>
                      <span>GST <b>{isExport ? "0% (export)" : `${taxRate}%`}</b></span>
                      <button
                        type="button"
                        onClick={() => setTermsOpen(true)}
                        className="ml-auto text-xs font-semibold text-amber-ink underline underline-offset-2 hover:text-amber"
                      >
                        Change
                      </button>
                    </div>
                  </div>
                ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                {/* Billing cycle — quote-level invoice FREQUENCY, independent of any
                    line's price tier (migration 0161). Always enabled (a quote-level
                    choice, not gated on line items). A flex-monthly line forces the
                    whole quote to monthly billing — a no-commitment plan can only
                    bill monthly. Per-line PRICE tier (Monthly-flex vs Annual) is a
                    separate control in the items table. */}
                <div>
                  <label htmlFor="qb-billing-cycle" className="text-xs font-medium text-ink-3 mb-1.5 block">Billing cycle</label>
                  <select
                    id="qb-billing-cycle"
                    value={effectiveCycle}
                    onChange={(e) => setBillingCycle(e.target.value as BillingCycle)}
                    disabled={hasFlexMonthly}
                    className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {BILLING_CYCLE_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-2xs text-ink-3">
                    {hasFlexMonthly
                      ? "A line is “Monthly flex” — a no-commitment plan bills monthly, so the whole invoice is monthly."
                      : <>How often invoices go out. Applies to the whole {isInvoiceMode ? "invoice" : "quote"} — separate from each line’s Monthly-flex vs Annual <b>price</b> (set in the items table).</>}
                  </p>
                </div>
                </div>
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
                    /* The smart default, SAID OUT LOUD. The rate and the SAC are filled in
                       for the operator and always were — but nothing ever showed what would
                       be printed on the document their customer's accountant reads, and a
                       default nobody can see is indistinguishable from a missing one.
    
                       `buyerStateCode` gates the head deliberately: with no state on file
                       isInterStateSupply() answers "intra-state" as a safe DEFAULT, and
                       printing "CGST + SGST" off the back of that would state a head nobody
                       knows. hsnSummary(null) says so instead. */
                    helper={isExport
                      ? "Export → zero-rated under LUT · no GST"
                      : hsnSummary(buyerStateCode ? interState : null)}
                    className={isExport ? "bg-paper-2 cursor-not-allowed" : undefined}
                  />
                </FormField>
                <button
                  type="button"
                  onClick={() => setTermsOpen(false)}
                  className="sm:col-span-2 justify-self-start text-xs font-semibold text-ink-3 underline underline-offset-2 hover:text-ink"
                >
                  Done
                </button>
                </div>
                )}
              </div>

              {/* Foreign billing SUMMARY (read-only) — the currency + rate are set once
                  up top (Settings), so here we just confirm what the customer is billed. */}
              {isForeign && (
                <div className="rounded-md bg-indigo-soft/40 border border-indigo/20 p-2.5 my-1">
                  <p className="text-2xs text-indigo-ink">
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
                        ? fmtPayableC(dRound(dispTotal / totalsDiv))
                        : fmtPayableC(dispTotal)}
                    </span>
                    {showPerInvoice && (
                      <div className="text-2xs text-ink-3 font-normal mt-0.5">
                        per invoice ({billingN}/yr) · = {fmtPayableC(dRound(totalsYear(dispTotal)))} / year
                      </div>
                    )}
                    {isForeign && (
                      <label className="mt-1 flex items-center justify-end gap-1.5 text-2xs text-ink-3 cursor-pointer select-none">
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
                      <div className="text-2xs text-emerald font-medium mt-0.5">
                        ✓ Single invoice · pay once for full year
                      </div>
                    )}
                    {isForeign && (
                      <div className="text-2xs text-indigo-ink font-medium mt-0.5">
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
              <p className="mt-1 text-3xs text-ink-3 text-right">
                Estimate — edit each line&apos;s cost to make this exact.
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* Bottom action row. On phones it sticks ABOVE the fixed bottom tab bar (56px + safe
          area): at bottom-0 the tab bar covered "Create invoice", so an invoice could not be
          made on a phone at all (found on staging, 6 Oct 2026). R-291: the height comes from
          the shared --bottom-nav-h (app layout), like the FAB and bulk bar.
          All 3 send-shaped buttons save the quote first
          (status='sent') and then signal the detail page to open the right
          dialog via a ?send= query param. "Duplicate" stays placeholder
          until we wire a real duplicate flow. */}
      {lineItems.length > 0 && (
        /* R-315 (7 Oct 2026): at 375px every button sat on its own line and the bar was
           253px tall — a third of the screen, so the line items had no room. Below md it is
           now ONE row: total + the main button + a "More" menu holding the rest (same
           handlers, nothing dropped). md and up is unchanged. Layout only — the total,
           GST and save logic are untouched. */
        <div
          data-quote-action-bar
          className="order-last sticky bottom-[calc(var(--bottom-nav-h,56px))] md:bottom-0 z-20 -mx-4 -mb-4 flex items-center justify-between gap-2 md:gap-3 flex-nowrap md:flex-wrap border-t border-hairline bg-paper px-4 py-2 md:py-3 shadow-[0_-6px_16px_-10px_rgba(0,0,0,0.25)] md:-mx-6 md:-mb-6 md:px-6 lg:-mx-8 lg:-mb-8 lg:px-8"
        >
          <div className="min-w-0 flex flex-col md:flex-row md:items-baseline md:gap-2">
            <span className="text-3xs md:text-2xs uppercase tracking-wider text-ink-3 font-semibold whitespace-nowrap">
              {!showPerInvoice && billingN === 1 ? "Total payable now" : "Total"}
            </span>
            <span className="font-serif text-xl md:text-2xl text-amber tabular-nums whitespace-nowrap leading-tight">
              {showPerInvoice ? fmtPayableC(dRound(dispTotal / totalsDiv)) : fmtPayableC(dispTotal)}
            </span>
            {showPerInvoice && (
              <span className="text-3xs md:text-2xs text-ink-3 whitespace-nowrap truncate">/invoice · {fmtPayableC(dRound(totalsYear(dispTotal)))}/yr</span>
            )}
          </div>
          {isInvoiceMode ? (
            /* Invoice mode — one-time/recurring choice + a single "Create invoice".
               On phones Preview moves into the More menu so the row stays one line. */
            <div className="flex gap-2 flex-nowrap md:flex-wrap items-center shrink-0">
              <div className="inline-flex rounded-lg border border-hairline bg-paper-2/40 p-1 text-xs">
                {[{ k: false, l: "One-time" }, { k: true, l: "Recurring" }].map((o) => (
                  <button
                    key={String(o.k)}
                    type="button"
                    onClick={() => setInvoiceRecurring(o.k)}
                    aria-pressed={invoiceRecurring === o.k}
                    className={`px-2 md:px-3 py-1.5 rounded-md transition-colors ${
                      invoiceRecurring === o.k ? "bg-paper text-ink shadow-sm font-medium" : "text-ink-3 hover:text-ink"
                    }`}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
              <Button icon="file" className="hidden md:inline-flex" onClick={openPreview}>
                Preview
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton icon="more_h" aria-label="More actions" className="md:hidden border border-hairline" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" side="top" className="min-w-[12rem]">
                  <DropdownMenuItem className="gap-2.5 py-2" onSelect={openPreview}>
                    <Icon name="file" size={15} /> Preview
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="primary"
                icon="receipt"
                onClick={() => handleSubmit("sent")}
                loading={createQuote.isPending || generateInvoice.isPending}
                disabled={!customerId && !prospectName.trim()}
              >
                <span className="md:hidden">Create</span>
                <span className="hidden md:inline">Create invoice</span>
              </Button>
            </div>
          ) : (
          <div className="flex gap-2 flex-nowrap md:flex-wrap items-center shrink-0">
          <Button variant="ghost" icon="copy" className="hidden md:inline-flex" onClick={() => handleSubmit("draft")} loading={createQuote.isPending}>
            Save draft
          </Button>
          <Button icon="file" className="hidden md:inline-flex" onClick={openPreview}>
            Preview
          </Button>
          <Button
            icon="mail"
            className="hidden md:inline-flex"
            onClick={() => handleSubmit("sent", "email")}
            loading={createQuote.isPending}
            disabled={sendDisabled}
          >
            Send via email
          </Button>
          <Button
            icon="whatsapp"
            className="hidden md:inline-flex !text-[#25D366] !border-[#25D366] hover:!bg-[#25D366]/5"
            onClick={() => handleSubmit("sent", "whatsapp")}
            loading={createQuote.isPending}
            disabled={sendDisabled}
          >
            Send via WhatsApp
          </Button>
          {/* Phone only: everything except the main button lives here. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                icon="more_h"
                aria-label="More actions"
                className="md:hidden border border-hairline"
                disabled={createQuote.isPending}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="min-w-[13rem]">
              <DropdownMenuItem className="gap-2.5 py-2" onSelect={() => handleSubmit("draft")}>
                <Icon name="copy" size={15} /> Save draft
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2.5 py-2" onSelect={openPreview}>
                <Icon name="file" size={15} /> Preview
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2"
                disabled={sendDisabled}
                onSelect={() => handleSubmit("sent", "email")}
              >
                <Icon name="mail" size={15} /> Send via email
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2"
                disabled={sendDisabled}
                onSelect={() => handleSubmit("sent", "whatsapp")}
              >
                <Icon name="whatsapp" size={15} className="text-[#25D366]" /> Send via WhatsApp
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="primary"
            icon="send"
            onClick={() => handleSubmit("sent")}
            loading={createQuote.isPending}
            disabled={sendDisabled}
          >
            <span className="md:hidden">Save &amp; send</span>
            <span className="hidden md:inline">Save &amp; send quote</span>
            <Kbd keys={["Ctrl", "Enter"]} className="ml-1.5 hidden sm:inline-flex" />
          </Button>
          </div>
          )}
        </div>
      )}

      {/* Support plan — sold with the licences, on its own monthly/yearly price.
          Inline rather than behind the Add-item modal because the yearly saving is
          only persuasive when it is on screen while the quote is being built. */}
      <Card className="mt-4">
        {(() => {
          /* Which support line, if any, is already on this quote.
             Identified by matching the line's item_id against the catalogue's support
             SKUs rather than by sniffing the NAME — a rename in the catalogue would break
             a name check silently, and the operator would see the three cards again on a
             quote that already has a plan. */
          const supportSkuIds = new Set(
            SUPPORT_TIERS.flatMap((t) =>
              (["monthly", "yearly"] as const)
                .map((c) => findSupportSku(catalog, t.id, c)?.id)
                .filter((id): id is string => !!id)),
          );
          const line = lineItems.find((l) => l.item_id && supportSkuIds.has(l.item_id));
          /* With product-wise support in the catalogue (each licence line offers its own
             "+ Add support"), the three company-wide plan cards are a second road to the
             same thing — fold them away unless one is already on the quote. */
          const hasProductSupport = catalog.some((c) => isSupportSkuId(c.id) && !supportSkuIds.has(c.id));
          const picker = (
            <SupportPlanPicker
              items={catalog}
              onAdd={addLine}
              selected={line ? {
                name: line.name,
                /* A monthly plan's rate is one month (R-369); the card states the year. */
                annualRate: isAnnualTier(line.commitment) ? line.rate : line.rate * 12,
                cycleLabel: line.commitment === "monthly" ? "per year, billed monthly" : "per year",
              } : null}
              onRemove={line ? () => removeLine(line.id) : undefined}
              /* R-364: owner/manager (who can open Catalog & Products) get "Add to catalog"
                 on a missing plan; everyone else keeps the "ask an owner" line. */
              catalogAccess={currentUser && canEditSupportCatalog(currentUser.role)
                ? { tenantId: currentUser.tenantId, tenantName: currentUser.tenantName }
                : null}
            />
          );
          if (!hasProductSupport || line) return picker;
          return (
            <details className="group">
              <summary className="cursor-pointer list-none flex items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-semibold text-ink">Company-wide support plans</span>
                  <span className="block text-2xs text-ink-3">Support for one product is on each licence line: “Add support”.</span>
                </span>
                <Icon name="chevron_down" size={14} className="text-ink-3 transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3">{picker}</div>
            </details>
          );
        })()}
      </Card>

      {/* Add item modal */}
      <AddLineItemDialog open={addOpen} onOpenChange={setAddOpen} onAdd={addLine} currency={currency} exchangeRate={exchangeRate} pricingBasis={usdPricingBasis} />

      {/* Solution packages — several catalogue products in one click */}
      <SolutionPackagePicker
        open={packageOpen}
        onOpenChange={setPackageOpen}
        catalog={catalog}
        seats={lineItems[0]?.qty ?? (leadSeats ? parseInt(leadSeats, 10) : 10)}
        onAdd={addLines}
        startDate={todayISO}
      />
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
        customerName={isLeadMode ? (leadDisplayName || PLACEHOLDER_QUOTE_NAME) : (customer?.name ?? prospectName.trim() ?? "—")}
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
// LineAdjustControls — what the CUSTOMER may change on the public quote page.
//
// Off by default, and that default is the point: a quote where the buyer can edit
// anything is an order form the seller has not seen. The reseller opts each line in,
// and the server re-checks these flags before it prices anything, because the public
// page has no session. See lib/quotes/configure.ts.
// ============================================================
function LineAdjustControls({ line, onChange }: {
  line: QuoteLineItem;
  onChange: (patch: Partial<QuoteLineItem>) => void;
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
      <span className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Customer can</span>
      <label className="inline-flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          checked={!!line.seats_adjustable}
          onChange={(e) => onChange({ seats_adjustable: e.target.checked || undefined })}
          className="h-3.5 w-3.5 accent-amber"
        />
        <span className="text-ink-2">change seats</span>
      </label>
      <label className="inline-flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          checked={!!line.optional}
          onChange={(e) => onChange({
            optional: e.target.checked || undefined,
            // Un-ticking "optional" must clear the default too, or a line that is no
            // longer optional keeps a flag that only means something for optional lines.
            included_by_default: e.target.checked ? (line.included_by_default ?? false) : undefined,
          })}
          className="h-3.5 w-3.5 accent-amber"
        />
        <span className="text-ink-2">add / remove this</span>
      </label>
      {line.optional && (
        <label className="inline-flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            checked={!!line.included_by_default}
            onChange={(e) => onChange({ included_by_default: e.target.checked || undefined })}
            className="h-3.5 w-3.5 accent-amber"
          />
          <span className="text-ink-3">ticked to start</span>
        </label>
      )}
    </div>
  );
}

// ============================================================
// LineBandNote — which volume band a line landed in, and the next one up.
//
// Two facts a rep cannot get anywhere else on this screen: WHY this seat count is
// priced the way it is, and the exact ask that would make it cheaper ("3 more seats
// and every seat drops to ₹250"). The upsell only renders when a genuinely cheaper
// band exists — an empty nudge is worse than none, and it is suppressed on a
// hand-edited rate because the negotiated price is the deal, not the band.
// ============================================================
function LineBandNote({ line, catalog }: { line: QuoteLineItem; catalog: Item[] }) {
  const item = line.item_id ? catalog.find((c) => c.id === line.item_id) : undefined;
  const slabs = item?.prices?.slabs;
  if (!item || !slabs || slabs.length === 0) return null;
  /* Bands are annual ₹/seat/YEAR; a flex line is per month (R-369) and is never banded. */
  if (!isAnnualTier(line.commitment)) return null;

  const priced = slabPricing(item, line.qty);
  if (priced.source !== "slab") return null;

  const onBandRate = Math.round(priced.msrpPerSeatMonth * 12) === line.rate;
  const upsell = onBandRate ? nextSlabUpsell(slabs, line.qty) : null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs">
      <span className="rounded bg-paper-2 px-1.5 py-px font-medium text-ink-3">
        Volume band: {priced.label}
      </span>
      {!onBandRate && (
        <span className="text-ink-3">rate edited by hand</span>
      )}
      {upsell && (
        <span className="text-emerald">
          +{upsell.seatsToAdd} {upsell.seatsToAdd === 1 ? "seat" : "seats"} → ₹{upsell.newRatePerSeatMonth}/seat/mo
          on every seat, saving {rupee(upsell.annualSaving)}/yr
        </span>
      )}
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

/**
 * "+ <product> Support" under a licence line (2 Oct 2026, Pardeep: support add-ons are
 * per product — "Google Workspace Business Starter Support"). Offers the product's own
 * support add-on on the line's cycle; once it is on the quote, says so instead.
 */
function LineSupportToggle({ line, catalog, lineItems, onAdd }: {
  line: QuoteLineItem; catalog: Item[]; lineItems: QuoteLineItem[]; onAdd: (l: QuoteLineItem) => void;
}) {
  if (!line.item_id || isSupportSkuId(line.item_id)) return null;
  const cycle = line.commitment === "monthly" ? "monthly" : "yearly";
  const sku = productSupportSku(catalog, line.item_id, cycle);
  if (!sku) return null;
  const onQuote = lineItems.some((l) => l.item_id === sku.id
    || l.item_id === productSupportSku(catalog, line.item_id, cycle === "yearly" ? "monthly" : "yearly")?.id);
  if (onQuote) {
    return <div className="mt-1 text-2xs text-emerald">✓ Support added</div>;
  }
  const price = catalogYearlyPrice(sku).rate;
  return (
    <button
      type="button"
      onClick={() => onAdd(lineFromCatalog(sku))}
      className="mt-1 inline-flex items-center gap-1 rounded-md border border-dashed border-amber/60 px-2 py-0.5 text-2xs font-medium text-amber-ink hover:bg-amber-soft/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
    >
      <Icon name="plus" size={11} /> Add support · {rupee(price)}/yr
    </button>
  );
}
