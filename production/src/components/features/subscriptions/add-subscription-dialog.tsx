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
import { GstStateSelect, EXPORT_STATE } from "@/components/shared/gst-state-select";
import { GST_STATE_BY_CODE } from "@/lib/utils";
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
import { useItems } from "@/lib/queries/items";
/* The same role vocabulary and id shape the customer's own Contacts card uses, so the
   person created here is indistinguishable from one added there. */
import { CONTACT_ROLES, type ContactRole } from "@/lib/queries/contacts";
import { attachPrimaryContact } from "@/lib/contacts/attach";
import {
  subscriptionProducts, vendorSelectOptions, productsForVendor, findProduct, judgePrice,
  billingTerms, annualise, BILLING_CHOICES,
  type CatalogProduct, type BillingChoice,
} from "@/lib/subscriptions/catalog-options";
import type { Item } from "@/lib/supabase/database.types";

/** Display names for the vendor enum. All seven — the DB has always allowed them. */
const VENDOR_LABEL: Record<Item["vendor"], string> = {
  google:    "🌐 Google Cloud / Workspace",
  microsoft: "🪟 Microsoft 365 / Azure",
  zoho:      "💼 Zoho Suite",
  hosting:   "🖥️ Hosting",
  support:   "🛠️ Support plan",
  domain:    "🔗 Domain",
  other:     "📦 Other Cloud Vendor",
};
import { useQueryClient } from "@tanstack/react-query";
import { rupee } from "@/lib/utils";

import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { grossAmount } from "@/lib/quotes/amounts";
/* The LAST COVERED DAY of the term: start 11 Sep 2026 + 12 months → 10 Sep 2027, not
   11 Sep. Abhishek, 11 Sep 2026 — the column is an expiry date, and it has to agree with
   the Google Admin console he reconciles against. Shared rather than open-coded here so
   the ±1 has exactly one home; it also carries the month clamp (31 Jan + 1 month is
   28 Feb, and JavaScript's own Date rolls it to 3 March). */
import { termEndInclusive } from "@/lib/billing/schedule";
import { findPlanProduct, type LeadPrefill } from "@/lib/subscriptions/lead-prefill";
/* The same countdown the subscriptions list and /payments render, so the hint under
   the field cannot disagree with the chip the operator sees a second later. */
import { paymentDueState, todayIST } from "@/lib/subscriptions/payment-due";

/** GST on SaaS in India — CGST 9% + SGST 9%, or IGST 18%. CLAUDE.md §13. */
const TAX_RATE_PCT = 18;

/* DEFAULT_CREDIT_DAYS and addDaysISO lived here until 11 Sep 2026, when the payment
   due date became blank-and-required. They are gone rather than left unused: a helper
   that still computes "start + 30" is an invitation to reinstate the silent default
   this change deliberately removed. */

/*
 * The hardcoded PRODUCTS_BY_VENDOR list that used to live here is GONE.
 *
 * It held 29 products with their own ids ("gw-starter") and their own prices. Two
 * things were wrong with that, and both cost money:
 *
 *  1. Its ids matched nothing in the catalog ("GW-STR-fbb"), so this dialog could not
 *     supply subscriptions.item_id and a DB trigger had to infer the link from the
 *     plan text — which only worked because a normaliser papers over the fact that the
 *     two lists disagreed on names ("Business Standard" vs "Standard").
 *  2. Its PRICES had drifted BELOW the tenant’s own vendor cost on four of the eight
 *     overlapping products. M365 Business Standard pre-filled ₹7,920/seat/year against
 *     a ₹9,840 cost — a guaranteed ₹1,920 loss per seat per year, suggested by the app,
 *     with nothing on screen to mark it. See lib/subscriptions/catalog-options.ts for
 *     the full measured table.
 *
 * Products, prices and the vendor list now all come from the catalog the operator
 * maintains at /items. There is nothing left here to drift.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  /**
   * Called instead of creating a subscription when the operator says the money has
   * been received. The caller opens Record payment with these details; `record_payment`
   * then creates the subscription, the receipt voucher and the ledger entries in one
   * transaction — see Step 3a for why this dialog must not create one itself.
   *
   * Without a handler the "Payment Received" option cannot complete, so the radio is
   * disabled and says so rather than silently doing the wrong thing.
   */
  onNeedsPayment?: (handoff: {
    quoteId: string;
    customerId: string;
    customerName: string;
    /** GST-inclusive ₹ the payment sheet should expect. */
    expectedAmount: number;
    lineItems: QuoteLineItem[];
    domain: string;
  }) => void;
  /** R-073: a won deal's details — the form opens filled in (lib/subscriptions/lead-prefill.ts). */
  prefill?: LeadPrefill | null;
}

export function AddSubscriptionDialog({ open, onOpenChange, onSuccess, onNeedsPayment, prefill = null }: Props) {
  const { data: me } = useCurrentUser();
  const qc = useQueryClient();

  const [customerName, setCustomerName] = React.useState("");
  const [domain, setDomain] = React.useState("");

  /* ── The customer's PRIMARY CONTACT — one real person ──────────────────────
     Until 11 Sep 2026 this dialog had a single "Contact Email (Optional)" box that
     was typed into state and USED NOWHERE. Not written to `contacts`, not even to the
     legacy `customers.contact_email`. So every customer born here arrived with zero
     contacts, and a postpaid subscription could carry a due date, a countdown and an
     overdue highlight with nobody to send the reminder to.

     Abhishek's design (10 Sep 2026): a customer has several contacts with roles, and at
     least one is MANDATORY. The customer page has been able to hold them since that day;
     this was the front door that was never wired up.

     ALL FOUR are required — Abhishek, 11 Sep 2026, overriding the first cut of this
     block where email and phone were optional. The email is how an invoice and a payment
     reminder actually leave the building and the phone is what the chase uses when the
     email goes unanswered, so a contact missing both satisfies the rule and still leaves
     nobody reachable. Role never needs a keystroke: it opens on "Point of contact". */
  const [contactName, setContactName] = React.useState("");
  const [contactEmail, setContactEmail] = React.useState("");
  const [contactPhone, setContactPhone] = React.useState("");
  const [contactRole, setContactRole] = React.useState<ContactRole>("poc");
  /* R-174: a new customer's place of supply (GST code, or EXPORT_STATE). Without it the
     GST invoice for this sale is refused ("no state on record"). */
  const [newCustState, setNewCustState] = React.useState("");
  /* ── Picking someone who already exists ────────────────────────────────────
     Abhishek, 18 Sep 2026: "make it searchable so if that contact available then it
     should selected". Since migration 20260918090000 a person can serve several
     customers, so the right answer to "this email already exists" is to LINK that
     person, not to refuse — which is what the pre-flight check used to do because
     linking was impossible. */
  const [contactPool, setContactPool] = React.useState<Array<{
    id: string; full_name: string | null; email: string | null; phone: string | null;
  }>>([]);
  /** Set when an EXISTING person was chosen. Null means "create a new one". */
  const [pickedContactId, setPickedContactId] = React.useState<string | null>(null);
  const [contactQueryOpen, setContactQueryOpen] = React.useState(false);
  const [vendor, setVendor] = React.useState<Item["vendor"]>("google");
  const [plan, setPlan] = React.useState("");
  const [isCustomPlan, setIsCustomPlan] = React.useState(false);
  /* ── Number fields hold RAW TEXT, not a number ────────────────────────────
     These two used to store numbers and coerce on every keystroke:

         onChange={(e) => setPricePerSeatYear(parseFloat(e.target.value) || 0)}

     Clearing the field makes `e.target.value` an empty string, `parseFloat("")`
     is NaN, and `NaN || 0` is 0 — so the box immediately re-rendered as "0"
     with the caret before it. Typing 222 over a selected "0" produced **0222**,
     and the zero could not be deleted at all. Reported 9 Sep 2026 while
     onboarding a real subscription.

     Text state fixes it — an empty box stays empty — and the derived numbers
     below keep every downstream calculation (margin verdict, total, the quote
     rows) working on real numbers exactly as before. Submit is already guarded
     by `seats <= 0`, so a momentarily empty field is safe.

     Still true after the fix: a HALF-typed decimal ("136.") reads back as "" from
     a type="number" input, because the DOM sanitises its own value. That is
     browser behaviour, not this component's. Prices here are whole rupees, so
     the alternative — type="text" + inputMode="decimal", losing min= and the
     spinner — is not worth it. See add-subscription-price-input.test.tsx. */
  const [seatsText, setSeatsText] = React.useState("10");
  const [priceText, setPriceText] = React.useState("0");
  const seats = Number.parseInt(seatsText, 10) || 0;
  /** ₹/seat in the CHOSEN unit — per month for both monthly choices, per year for
   *  yearly. `terms.unit` says which; nothing below may assume. */
  const pricePerSeat = Number.parseFloat(priceText) || 0;
  /** Yearly-with-one-invoice keeps being the default, so an operator who ignores the
   *  new dropdown gets exactly the behaviour that shipped before it existed. */
  const [billingChoice, setBillingChoice] = React.useState<BillingChoice>("annual_yearly");
  /** The catalog row being sold → subscriptions.item_id. Null on a custom plan. */
  const [itemId, setItemId] = React.useState<string | null>(null);
  const [paymentTerms, setPaymentTerms] = React.useState<"paid" | "credit">("credit");
  // R-025: `toISOString()` is UTC, so before 05:30 IST this seeded YESTERDAY — and a
  // subscription's start date is what every renewal date is then counted from.
  const [startDate, setStartDate] = React.useState(() => todayIST());
  /* Seeded from the DEFAULT term (12 months), and re-derived whenever the start date or
     the billing period moves — see changeStartDate / changeBillingChoice. It stays an
     editable field: the derived value is the sensible default, not a cage. */
  const [renewalDate, setRenewalDate] = React.useState(
    () => termEndInclusive(todayIST(), 12),        // R-025 — same UTC trap.
  );

  /**
   * Postpaid only: when the operator agreed the balance is due.
   *
   * Typed in, not derived from the customer's payment terms — Abhishek's call, 10 Sep
   * 2026 — and counted from the SUBSCRIPTION START DATE, so it follows a corrected or
   * back-dated start. Defaults to start + 30 days; the field is editable and stays
   * whatever it is set to.
   *
   * It exists because "Postpaid" activates a subscription and books the full
   * GST-inclusive balance as owed while nothing said when the money was expected. It is
   * NOT an invoice due date: this path deliberately raises no invoice, because a tax
   * invoice creates a GST liability on money that sometimes never arrives.
   */
  const [paymentDueDate, setPaymentDueDate] = React.useState("");

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
      /* Everyone already in the address book, so the contact name box can offer them.
         Capped: this is a picker, not a report, and a tenant with thousands of contacts
         should not pay for all of them to fill a dropdown. */
      const { data: people } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone")
        .order("full_name")
        .limit(500);
      setContactPool(people ?? []);
    })();
  }, [open]);

  /* ── The catalog, which is now the only source of products and prices ────────
     Loaded from /items. `subscriptionProducts` drops one-time items and converts
     ₹/seat/month to the ₹/seat/year this dialog charges in — once, in one place. */
  const { data: items, isLoading: catalogLoading } = useItems();
  const products   = React.useMemo(() => subscriptionProducts(items ?? []), [items]);
  /* Built in one place (catalog-options.ts) because it used to be built in two:
     a fallback for an empty catalogue AND a guard that appended `other`. On an empty
     catalogue both fired and this dropdown showed "Other Cloud Vendor" twice. */
  const vendorOptions = React.useMemo(() => vendorSelectOptions(products), [products]);
  const forVendor  = React.useMemo(() => productsForVendor(products, vendor), [products, vendor]);
  const selected   = itemId ? findProduct(products, itemId) : undefined;

  /* Seed from the catalog once it arrives. Deliberately does NOT reset a choice the
     operator has already made — refetches would otherwise wipe their work. */
  React.useEffect(() => {
    if (itemId || isCustomPlan || products.length === 0) return;
    const first = productsForVendor(products, vendor)[0] ?? products[0];
    if (!first) return;
    setVendor(first.vendor);
    setItemId(first.id);
    setPlan(first.name);
    setPriceText(String(billingTerms(billingChoice, first).suggestedSellPerSeat));
  }, [products, vendor, itemId, isCustomPlan, billingChoice]);

  const applyProduct = (p: CatalogProduct) => {
    setIsCustomPlan(false);
    setItemId(p.id);
    setPlan(p.name);
    setPriceText(String(billingTerms(billingChoice, p).suggestedSellPerSeat));
  };

  /**
   * Switching the billing period RE-PRICES the field, because the number in it means
   * something different afterwards. ₹3,240/yr and ₹270/mo are the same deal; leaving
   * 3240 in a box now labelled ₹/mo would quote twelve times the intended price.
   *
   * Only reaches for the catalog — it will not invent a conversion for a custom plan,
   * where the operator's own number is the only truth. There, the field is left alone
   * and the label change is the signal.
   */
  const changeBillingChoice = (next: BillingChoice) => {
    setBillingChoice(next);
    /* The TERM changes with the choice, so the expiry date has to move with it.
       Flex has no commitment — its term is one month, and leaving a year there was
       reported on 9 Sep 2026 as "date still pointing to yearly".

       Note what does NOT change: an annual commitment billed MONTHLY still expires in
       twelve months. That is the commitment ending, not the next invoice, and it looked
       like a bug precisely because the word "Monthly" is in the choice. The hint under
       the field now says which of the two it is. */
    setRenewalDate(termEndInclusive(startDate, billingTerms(next, selected).termMonths));
    if (!selected) return;
    setPriceText(String(billingTerms(next, selected).suggestedSellPerSeat));
  };

  /**
   * Moving the start date drags the expiry with it, keeping the term intact.
   *
   * Back-dating is the case that motivated this (reported 9 Sep 2026): onboarding a
   * subscription that really began in April used to leave the expiry a year from
   * TODAY, quietly selling thirteen or fourteen months of term. The two fields were
   * independent, so nothing on screen disagreed with itself.
   *
   * Still editable afterwards — a real contract sometimes has an odd end date, and the
   * derived value is a default, not a constraint.
   */
  const changeStartDate = (next: string) => {
    setStartDate(next);
    if (!next) return;
    /* billingTerms(...) rather than the `terms` further down — same value, but that one
       is declared below this handler and reading it here would rely on closure timing
       to stay out of its temporal dead zone. Not worth the puzzle. */
    setRenewalDate(termEndInclusive(next, billingTerms(billingChoice, selected).termMonths));
    /* The payment due date is NOT derived from this. It starts blank and is required
       on a credit sale (Abhishek, 11 Sep 2026) — it used to default to start + 30 and
       fall back to that when left empty, which meant a date nobody had actually agreed
       could end up driving a countdown and, later, a reminder. An explicit answer is
       worth one keystroke. */
  };

  const handleVendorChange = (v: Item["vendor"]) => {
    setVendor(v);
    setIsCustomPlan(false);
    const first = productsForVendor(products, v)[0];
    if (first) applyProduct(first);
    else {
      /* A vendor with no catalog rows leaves the fields alone rather than clearing
         them — but item_id must go, or the subscription would be linked to a product
         from the vendor they just navigated away from. */
      setItemId(null);
    }
  };

  /** Values are item IDs now, not names — two catalog rows may share a name. */
  const handlePlanSelect = (val: string) => {
    if (val === "CUSTOM_PLAN") {
      setIsCustomPlan(true);
      setItemId(null);      // nothing in the catalog to point at
      setPlan("");
      return;
    }
    const found = findProduct(products, val);
    if (found) applyProduct(found);
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
      /* An existing customer already has their people on their own page. Clearing what
         was typed keeps the block that is about to disappear from submitting anything —
         and stops a half-typed name from being written against a company whose contacts
         somebody has already curated. */
      setContactName("");
      setContactEmail("");
      setContactPhone("");
      setContactRole("poc");
    setNewCustState("");
      setNewCustState("");
    }
  };

  const handleClearCustomerSelection = () => {
    setSelectedCustomerId("");
    setCustomerName("");
    setDomain("");
    setContactName("");
    setContactEmail("");
    setContactPhone("");
    setContactRole("poc");
    setNewCustState("");
  };

  /**
   * Whether to ask for a contact person at all.
   *
   * Only when the operator is typing a NEW customer. Picking one from the dropdown means
   * the company is already on file with its own people, and re-asking for a contact
   * every time they buy a second subscription would be both annoying and a route to
   * duplicate rows. The submit path double-checks against the database anyway — see
   * savePrimaryContact — because a TYPED name can still turn out to match.
   */
  const needsContact = !selectedCustomerId;

  /**
   * People matching what has been typed into the contact name or email box.
   *
   * Matches on BOTH, because the operator may start with either — and the email is the
   * one that used to cause the collision, so typing it should surface the person who
   * already holds it before the form is ever submitted.
   */
  const contactMatches = React.useMemo(() => {
    const q = `${contactName} ${contactEmail}`.trim().toLowerCase();
    if (q.length < 2) return [];
    const terms = q.split(/\s+/).filter(Boolean);
    return contactPool
      .filter((p) => {
        const hay = `${p.full_name ?? ""} ${p.email ?? ""}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
      })
      .slice(0, 6);
  }, [contactPool, contactName, contactEmail]);

  /** Take an existing person: fill the boxes and remember we are LINKING, not creating. */
  /* ── R-073: fill the form from a won deal, once per lead, after the catalog and the
     customer list have loaded (the plan is matched to a catalog product so the price comes
     from the catalog, not from the lead's deal value). */
  const prefilledFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!open || !prefill || prefilledFor.current === prefill.leadId) return;
    if (catalogLoading) return;
    if (prefill.customerId && !existingCustomers.some((c) => c.id === prefill.customerId) && existingCustomers.length === 0) return;
    prefilledFor.current = prefill.leadId;
    const existing = prefill.customerId ? existingCustomers.find((c) => c.id === prefill.customerId) : undefined;
    if (existing) {
      handleSelectExistingCustomer(existing.id);
    } else {
      setCustomerName(prefill.customerName);
      setDomain(prefill.domain);
      setContactName(prefill.contactName);
      setContactEmail(prefill.contactEmail);
      setContactPhone(prefill.contactPhone);
    }
    if (prefill.seats) setSeatsText(String(prefill.seats));
    setBillingChoice(prefill.billingChoice);
    const product = prefill.plan ? findPlanProduct(products, prefill.plan) : undefined;
    if (product) {
      const terms = billingTerms(prefill.billingChoice, product);
      setVendor(product.vendor);
      setIsCustomPlan(false);
      setItemId(product.id);
      setPlan(product.name);
      setPriceText(String(terms.suggestedSellPerSeat));
      setRenewalDate(termEndInclusive(startDate, terms.termMonths));
    } else if (prefill.plan) {
      setIsCustomPlan(true);
      setItemId(null);
      setPlan(prefill.plan);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per lead; the setters are stable
  }, [open, prefill, catalogLoading, products, existingCustomers]);

  const pickContact = (p: { id: string; full_name: string | null; email: string | null; phone: string | null }) => {
    setPickedContactId(p.id);
    setContactName(p.full_name ?? "");
    setContactEmail(p.email ?? "");
    setContactPhone(p.phone ?? "");
    setContactQueryOpen(false);
  };

  /* ── The money, derived once from the billing choice ──────────────────────────
     `terms.periods` is the whole rule: 1 when the stored figures are one period,
     12 when a monthly-billed ANNUAL commitment must store the year so
     quoteInstalments can split it. See billingTerms() for why that is not optional. */
  const terms = billingTerms(billingChoice, selected);
  /** What ONE invoice charges, ex-GST — one month, or the year. */
  const perPeriodAmount = seats * pricePerSeat;
  /** What the QUOTE stores, ex-GST. Equals perPeriodAmount except for
   *  annual-billed-monthly, where it is the twelve months the customer committed to. */
  const storedTaxable = perPeriodAmount * terms.periods;
  /** Monthly recurring revenue. For a per-month unit that IS the per-period amount —
     dividing it by 12 was the 1 Sep 2026 defect. */
  const mrrAmount = terms.unit === "per_seat_month"
    ? perPeriodAmount
    : Math.round(perPeriodAmount / 12);
  /** ₹/seat/year on both sides, so the verdict's "per seat per year" wording is true
   *  whichever unit is on screen. */
  const annualisedSell = annualise(pricePerSeat, terms.unit);
  const annualisedCost = terms.costPerSeat === null
    ? null
    : annualise(terms.costPerSeat, terms.unit);
  /* Live check on whatever price is in the field. Every loss-making default this
     replaced was on screen for months with nothing to mark it; a margin that only
     shows up in a report arrives after the quote has gone out. */
  const verdict = judgePrice(annualisedSell, annualisedCost);

  /**
   * Find the quote this sale ALREADY has, if any — otherwise mint a fresh id.
   *
   * ─── WHY THIS ASKS THE DATABASE INSTEAD OF REMEMBERING ──────────────────────
   * The first attempt at this kept the id in a React ref keyed on a fingerprint of the
   * form. It did not work, and the reason is worth writing down: on the FIRST submit
   * Bobachee was a new customer, so `selectedCustomerId` was empty; by the second the
   * dropdown offered the customer that first submit had just created, so that one field
   * differed and the fingerprint declared it a different sale. Two identical quotes,
   * Q-2026-7395 and Q-2026-2482, 56 seconds apart — same customer_id, seats, subtotal,
   * plan, commitment and cycle. Measured 10 Sep 2026.
   *
   * A ref is the wrong instrument regardless: it dies on a page reload, and the operator
   * closing a sheet and coming back later is precisely the sequence being guarded.
   *
   * So the DATABASE is asked, because that is where the duplicate would land. A quote is
   * reusable when it is for the same customer, plan, seat count and amount, is still
   * `awaiting` payment, and has not been invoiced. Anything paid or invoiced is a real
   * separate sale and is never touched — reusing one of those would rewrite a document
   * that has already been issued.
   */
  const findOrMintQuoteId = async (
    supabase: ReturnType<typeof createClient>,
    tenantId: string, customerId: string, taxable: number,
  ): Promise<string> => {
    const { data } = await supabase
      .from("quotes")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("customer_id", customerId)
      .eq("plan", plan)
      .eq("seats", seats)
      .eq("subtotal", taxable)
      .eq("payment_status", "awaiting")
      .order("created_at", { ascending: false })
      .limit(1);
    const existing = data?.[0]?.id;
    if (existing) return existing as string;

    /* ── The number comes from the SERIES, never from Math.random() ────────────
       This line used to be:

           return `Q-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`;

       which is what put #4193, #3724, #2482 and #7395 in the books — reported by
       Abhishek 12 Sep 2026, next to the add-seats quotes numbered #0001 and #0002 by
       the proper route. CLAUDE.md §17 forbids exactly this shape.

       Two things were wrong with it, and only one is cosmetic:
         · COLLISIONS. Nine thousand possible numbers, and the id is the quotes
           PRIMARY KEY. By ~35 quotes a repeat is more likely than not, and the upsert
           this feeds would then silently overwrite somebody else's quote instead of
           inserting a new one.
         · NO SERIES. Nothing tells you which quote came first, and a gap cannot be
           explained to anyone who asks.

       next_document_number is atomic under a row lock, per tenant, per Indian
       fiscal year. Called with only p_doc_type: the function forces the caller's own
       tenant from the session and REJECTS an explicit id belonging to anyone else
       (migration 0117), so passing tenantId from the browser would add nothing.

       Allocated here, immediately before the write, so an abandoned dialog does not
       burn a number. */
    const { data: minted, error: numErr } = await supabase
      .rpc("next_document_number", { p_doc_type: "quote" });
    if (numErr || !minted) {
      /* §24: say what failed and what to do, rather than falling back to a random id.
         A fallback here would quietly reintroduce the collision this replaced. */
      throw new Error(
        numErr?.message
          ? `Could not allocate a quote number: ${numErr.message}. Try again — if it keeps failing, your document series needs setting up under Settings.`
          : "Could not allocate a quote number. Try again — if it keeps failing, your document series needs setting up under Settings.",
      );
    }
    return minted as unknown as string;
  };

  /**
   * Give the customer their PRIMARY contact — the person invoices and payment reminders
   * go to.
   *
   * ─── WHY THE WORK IS NOT HERE ───────────────────────────────────────────────
   * It used to be: sixty lines of resolve-or-create-then-link, duplicated almost exactly
   * inside useCreateCustomer on the Customers page — except the copy there never wrote
   * the link, so customers added from that page were invisible to the invoice and
   * dunning recipient lookup. Both now call `attachPrimaryContact`, so the two doors
   * into "a customer exists" cannot disagree about what a contact is.
   *
   * ─── WHY IT ASKS THE DATABASE BEFORE WRITING ────────────────────────────────
   * `customer_contacts_one_primary` is a partial UNIQUE index, so a second `is_primary`
   * row for the same customer does not merely duplicate a person — it fails the insert
   * with 23505. A customer who already has contacts has already got a primary, so the
   * right move is to leave them alone: their people were curated on their own page and
   * this dialog knows less about them than that page does. That check lives in
   * `attachPrimaryContact`.
   *
   * Reachable for an EXISTING customer even though the form hides the block for one: the
   * operator may type a name that turns out to match a company already on file (which is
   * exactly what produced four "Chandan Trading" rows on 10 Sep 2026). The typed contact
   * then fills a real gap if that company has nobody, and is dropped if it does.
   *
   * Returns what happened rather than throwing, because the caller is the only one that
   * knows whether the customer it is attached to was created seconds ago (and must be
   * undone) or has been on the books for a year (and must not be touched).
   */
  const savePrimaryContact = async (
    supabase: ReturnType<typeof createClient>,
    tenantId: string, customerId: string, companyName: string,
  ): Promise<{ kind: "written" | "skipped" | "linked" } | { kind: "failed"; reason: string }> => {
    const name = contactName.trim();
    if (!name) return { kind: "skipped" as const };

    const outcome = await attachPrimaryContact(supabase, {
      tenantId,
      customerId,
      name,
      email: contactEmail.trim(),
      phone: contactPhone.trim(),
      role: contactRole,
      company: companyName,
      /* The operator clicked somebody in the suggestions list. That is a decision, and
         it outranks matching on the email they happened to type. */
      contactId: pickedContactId,
    });

    /* The dialog's own vocabulary predates the shared writer and is what its tests and
       its toasts speak; translate rather than churn both. */
    if (outcome.kind === "already") return { kind: "skipped" as const };
    if (outcome.kind === "linked")  return { kind: "linked"  as const };
    if (outcome.kind === "created") return { kind: "written" as const };
    return { kind: "failed" as const, reason: outcome.reason };
  };

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
    /* ── A new customer must arrive WITH a complete person ─────────────────────
       Abhishek, 10 Sep 2026: "for a customer one contact is must". Name, email, phone
       and role all required as of 11 Sep 2026 — the first cut had email and phone
       optional, and he overrode that.

       He is right, and the reason is the reminder ladder: an email address is how an
       invoice and a payment chase actually leave the building, and a phone number is
       what the WhatsApp nudge needs. A contact with neither is a row that satisfies the
       rule and still leaves nobody reachable — which is the exact state this change
       exists to end. Collect it once, at the one moment the operator is definitely
       talking to the customer.

       Each field gets its own message, because "fill in the contact details" makes the
       operator hunt for which box is empty (§24). */
    if (needsContact && !contactName.trim()) {
      toast.error("A contact person is required for a new customer", {
        description: "Invoices and payment reminders go to this person — enter their name.",
      });
      return;
    }
    if (needsContact && !contactEmail.trim()) {
      toast.error("The contact's email is required", {
        description: "Invoices and payment reminders are sent to this address. Use the person's own, not a generic info@ if you can.",
      });
      return;
    }
    /* Shape, not validity — nobody can prove an address exists without sending to it.
       Deliberately permissive (something, an @, something): the field is type="email" so
       a real submit is already screened by the browser, and this exists to give that
       block a sentence the operator can act on instead of a browser tooltip. A stricter
       pattern would eventually reject somebody's real address, which costs a sale. */
    if (needsContact && !/^[^\s@]+@[^\s@]+$/.test(contactEmail.trim())) {
      toast.error("That email address does not look complete", {
        description: `"${contactEmail.trim()}" is missing the name or the domain — an invoice sent there will bounce.`,
      });
      return;
    }
    if (needsContact && !contactPhone.trim()) {
      toast.error("The contact's phone number is required", {
        description: "It is how you chase a payment when email goes unanswered. Landline or mobile, with the code.",
      });
      return;
    }
    /* NO format check on the phone. Indian numbers are genuinely irregular — +91 and
       bare 10-digit mobiles, landlines with a 2-to-4 digit STD code, extensions — and
       every pattern strict enough to be worth having would eventually refuse a real
       customer's real number. Required, not policed. */
    if (needsContact && !newCustState) {
      toast.error("Choose the customer's state", {
        description: "The GST invoice needs it — it decides CGST + SGST or IGST. Pick \"Outside India\" for a foreign customer.",
      });
      return;
    }
    if (needsContact && !contactRole) {
      /* Unreachable from the form: the dropdown is seeded with 'poc' and Radix cannot
         clear it. Kept so the rule is stated in code rather than resting on a default
         somebody could later remove. */
      toast.error("Pick what this person does for the customer", {
        description: "Owner, accountant, IT head or point of contact — it decides who you ask for what.",
      });
      return;
    }
    /* Postpaid REQUIRES a due date (Abhishek, 11 Sep 2026). It used to default to
       start + 30 and silently fall back to that when blank — so a countdown, and later
       a payment reminder, could run toward a date nobody had agreed. §24: name the
       field and say what to do, rather than letting the browser's own "please fill out
       this field" tooltip be the whole explanation. */
    if (paymentTerms === "credit" && !paymentDueDate) {
      toast.error("Payment due date is required for postpaid", {
        description: "Enter the date you agreed the balance is due — it drives the countdown and the overdue highlight.",
      });
      return;
    }
    if (seats <= 0) {
      toast.error("Seats must be at least 1");
      return;
    }

    setSubmitting(true);
    try {
      const supabase = createClient();
      // No hardcoded fallback tenant. It used to default to Anutech Digital's id,
      // so a user from another tenant whose profile hadn't loaded would try to
      // write a subscription into someone else's books. RLS would reject it
      // (`WITH CHECK tenant_id = current_tenant_id()`), but the right answer is to
      // not attempt it — and to say why. Removed 2026-08-13.
      const tenantId = me?.tenantId;
      if (!tenantId) throw new Error("Your workspace is still loading — reopen this dialog and try again.");

      /* ── Step 1: Find or Create Customer Record ─────────────────────────────
         The match asks the DATABASE, not the in-memory list.
         `existingCustomers` is loaded when the dialog OPENS, so it cannot contain a
         customer that a previous submit created moments ago — and that is exactly the
         sequence here: onboard, the handoff or a failure interrupts, try again. Each
         attempt missed its own predecessor and inserted another customer.

         Measured 10 Sep 2026: FOUR "Chandan Trading" rows (09:43:27, 09:43:36,
         09:59:23, 10:12:01) and four identical quotes at ₹26,168 — one per attempt.
         The quotes were the visible symptom, but they were not the bug: each carried a
         different customer_id, so findOrMintQuoteId correctly found nothing to reuse
         and minted a new one every time. Fixing it there would have papered over
         duplicate CUSTOMER records, which are worse — they split one company's
         history, subscriptions and receivables across four profiles.

         Domain first, name second: the domain is the provisioning key and the thing a
         reseller cannot get wrong twice, while names get typed differently. */
      let customerId = "";
      const { data: liveMatches } = await supabase
        .from("customers")
        .select("id, name, domain")
        .eq("tenant_id", tenantId)
        .or(`domain.ilike.${cleanDomain},name.ilike.${cleanCustomerName}`)
        .limit(5);
      const existingMatch =
        liveMatches?.find((c) => (c.domain ?? "").toLowerCase() === cleanDomain)
        ?? liveMatches?.find((c) => c.name.toLowerCase() === cleanCustomerName.toLowerCase())
        /* Last resort: the list the dialog opened with. Only reachable if the lookup
           above errored, and a stale hit still beats a duplicate. */
        ?? existingCustomers.find(
             (c) => c.name.toLowerCase() === cleanCustomerName.toLowerCase()
               || (c.domain && c.domain.toLowerCase() === cleanDomain));

      /* ── THE REAL GUARD: a customer about to be CREATED must have a person ──
         The checks at the top of this handler use `needsContact`, which is a UI flag —
         "did the operator pick from the dropdown". That is not the same question as
         "is a new customer about to exist", and on 17 Sep 2026 the two came apart:
         picking a customer and then typing a different name and domain left the flag
         saying "existing", hid the contact block, and created FF Impex with no contact
         at all. The UI now detaches the selection when either field is edited, but the
         invariant belongs HERE — next to the insert it protects, where it cannot be
         bypassed by any future change to the form.

         Nothing has been written at this point: the lookup above is a read. So this
         refuses the whole sale rather than leaving a customer with nobody on it. */
      if (!existingMatch && !contactName.trim()) {
        toast.error("This is a new customer — add a contact person first", {
          description: `No customer matches ${cleanDomain}, so one will be created. Clear the "Existing Customer" box at the top to enter their contact details.`,
        });
        return;
      }

      /* ── A MATCHING EMAIL IS NO LONGER AN ERROR ──────────────────────────
         Between 18 Sep morning and afternoon this block REFUSED the sale when the email
         already belonged to somebody, because `contacts.customer_id` allowed a person
         exactly one customer and the unique email index would have rejected the insert.
         That refusal was the right answer to the wrong model.

         With customer_contacts (migration 20260918090000) the same person simply gets
         linked to this customer as well, which is what Abhishek asked for and what the
         suggestions list under the contact name now makes visible BEFORE submitting.
         savePrimaryContact does the matching; there is nothing to refuse here.

         What remains refused, further up: a new customer with no contact person at all. */

      /* Tracked so the contact step below can UNDO this insert. Not the same question as
         `!existingMatch`, which says what we found — this says what we wrote. */
      let createdCustomerId: string | null = null;
      if (existingMatch) {
        customerId = existingMatch.id;
      } else {
        const newCustId = crypto.randomUUID();
        const { error: custErr } = await supabase.from("customers").insert({
          id: newCustId,
          tenant_id: tenantId,
          name: cleanCustomerName,
          domain: cleanDomain,
          created_at: new Date().toISOString(),
          // R-174: place of supply — generate_invoice reads state_code.
          ...(newCustState === EXPORT_STATE
            ? { country: "Outside India" }
            : newCustState ? { state_code: newCustState, state: GST_STATE_BY_CODE[newCustState] ?? null } : {}),
        } as any);
        if (custErr) throw custErr;
        customerId = newCustId;
        createdCustomerId = newCustId;
      }

      /* ── Step 1b: the customer's primary contact ────────────────────────────
         Before the paths diverge, deliberately: the PAID path returns at Step 3a to hand
         off to Record payment, so a contact written after that point would exist for
         postpaid sales only — and the paid path is the one that raises a GST invoice
         somebody has to receive. */
      const contactOutcome = await savePrimaryContact(
        supabase, tenantId, customerId, cleanCustomerName);
      if (contactOutcome.kind === "failed") {
        /* ── UNDO THE CUSTOMER ───────────────────────────────────────────────
           Abhishek's rule, 18 Sep 2026: "without contact customer not created". The
           browser cannot open a transaction across these inserts, so the guarantee is
           kept by compensating: the customer row was created moments ago by this very
           submit, nothing references it yet — no quote, no subscription, no invoice, and
           no contact, which is the whole problem — so removing it leaves the books
           exactly as they were before the button was pressed.

           Only `createdCustomerId` is ever deleted. A customer that already existed is
           never touched, however badly the contact step went: it has history.

           A delete that itself fails is reported rather than swallowed, because then a
           contactless customer really is on the books and the operator has to know which
           one to go and fix. */
        let orphanNote = "";
        if (createdCustomerId) {
          const { error: undoErr } = await supabase
            .from("customers").delete().eq("id", createdCustomerId);
          orphanNote = undoErr
            ? ` The customer "${cleanCustomerName}" was created and could not be removed — it has no contact, so open it and add one.`
            : ` The customer "${cleanCustomerName}" was removed, so nothing at all was created.`;
        }
        toast.error("The contact could not be saved — nothing was created", {
          description: `${contactOutcome.reason} No quote and no subscription were created.${orphanNote} Fix the problem above and submit again.`,
          duration: 12000,
        });
        return;
      }

      /* ── NO CUSTOMER, NO SUBSCRIPTION ──────────────────────────────────────
         The second half of the same rule. Everything below — the quote, the invoice, the
         subscription — hangs off `customerId`, and a blank one would either be refused by
         the foreign key deep inside step 3 (after a quote had already been minted) or,
         worse, written as an orphan. Asserted here, once, before anything is billed. */
      if (!customerId) {
        toast.error("No customer to attach this subscription to", {
          description: "The customer could not be found or created, so nothing was billed. Check the customer name and domain, then submit again.",
        });
        return;
      }

      // ── Step 2: Auto-Create Quote & Audit Invoice ─────────────────────────
      /* ── One quote per SALE, not one per button press ───────────────────────
         Reported 9 Sep 2026: "why quote keep generating again and again". The paid path
         hands off to Record payment, and if that sheet is closed without saving the
         operator comes back and presses the button again — and every press used to mint
         a fresh id and insert another quote. Six ended up in the books this way, four of
         them identical at ₹18,691.

         findOrMintQuoteId reuses the unpaid quote this sale already has, so the write
         below corrects that row instead of adding a sibling. Paid and invoiced quotes
         are never reused — see its comment. */
      const quoteId = await findOrMintQuoteId(supabase, tenantId, customerId, storedTaxable);
      const isPaid = paymentTerms === "paid";

      const lineItems: QuoteLineItem[] = [
        {
          id: `line-${Date.now()}`,
          name: `${plan} (${seats} seats)`,
          qty: seats,
          /* rate × qty must equal what the quote stores, so the rate carries the same
             `periods` multiplier the total does. On annual-billed-monthly that makes
             this the ₹/seat/YEAR the customer committed to, which is what a line under
             commitment 'annual_yearly' is required to mean. */
          rate: pricePerSeat * terms.periods,
          /* The real catalog cost when we have it, in the same unit as the rate.
             `× 0.83` — a flat 17% — survives only for a custom plan that has no
             catalog row, and it is the last of the three places that guess used to live. */
          cost: terms.costPerSeat !== null
            ? terms.costPerSeat * terms.periods
            : Math.round(pricePerSeat * terms.periods * 0.83),
          commitment: terms.commitment,
        },
      ];

      /* `amount`, NOT `total` — `quotes` has no `total` column (it has amount,
         subtotal and total_cost; amount is the canonical ₹, see quote-builder.tsx).
         The old key silently failed the insert, and because the failure was only
         console.warn'ed the code carried on and stamped quote_id onto the
         subscription, which then died on subscriptions_quote_id_fkey. The user saw
         "Failed creating subscription" — two steps downstream of the real cause. */
      /* UPSERT, not insert. A retry of the same sale reuses the id (see reuseQuoteId),
         so a plain insert would collide on the primary key and fail with 23505 —
         turning "press it again" from a duplicate into an error. Correcting the row is
         what the operator means by retrying. */
      const { error: quoteErr } = await supabase.from("quotes").upsert({
        id: quoteId,
        tenant_id: tenantId,
        customer_id: customerId,
        customer_name: cleanCustomerName,
        domain: cleanDomain,
        status: "accepted",
        /* ALWAYS `awaiting`. It used to be `received` when the operator picked "Payment
           Received", which set the balance to zero without a payment row, a receipt
           voucher or a bank entry anywhere — a quote that claimed to be paid with no
           record of how. That option now routes through Record payment, and the quote
           stays awaiting until the money is genuinely recorded. */
        payment_status: "awaiting",
        /* `amount` is the GST-INCLUSIVE figure — what the customer actually owes and
           what record_payment treats as "expected". This used to be the ex-GST
           total, so every subscription created here produced a quote whose own tax
           line said "GST 18% ₹4,320" while its TOTAL said ₹24,000.

           That was not a display bug. `amount` drives outstanding_amount, and the
           public pay route charges exactly it — so Razorpay collected ₹24,000 on a
           ₹28,320 debt and record_payment then settled the quote in full. Every
           subscription onboarded this way under-collected the entire GST. */
        amount: grossAmount(storedTaxable, TAX_RATE_PCT),
        subtotal: storedTaxable,
        tax_rate: TAX_RATE_PCT,
        /* Written explicitly now. It defaulted to 'yearly' in the DB while this dialog
           had no way to say otherwise, so every quote it ever made claimed one invoice
           a year — and quoteInstalments, which reads this column to split the term,
           had nothing else to go on. */
        billing_cycle: terms.billingCycle,
        /* total_cost was omitted here, so it defaulted to 0 while the line items
           carried the real cost — and every margin read off the column reported 100%
           on a 17.5% deal (Q-2026-9778: column 0, lines ₹19,800). The displays now
           derive margin from the lines, which is the durable fix; writing the column
           too keeps the stored row honest for anything that reads it later. */
        total_cost: lineItems.reduce((s, l) => s + l.qty * l.cost, 0),
        seats,
        plan,
        notes: `Auto-generated from Subscription Onboarding (${plan}) · ${isPaid ? "Paid Upfront" : "Credit Terms / Postpaid"}`,
        line_items: lineItems as unknown as QuoteLineItem[],
      });
      /* THROW, do not warn. The subscription references this quote by foreign key,
         so "proceed without it" was never an option — it just moved the failure
         somewhere it could not be explained. */
      if (quoteErr) throw quoteErr;

      /* ── Step 3a: PAID — hand off to Record payment, and create NOTHING else ──
         `record_payment` creates the subscription itself. That is the money spine:
         paid quote → customer → subscription → renewal date, in one transaction.
         So this path must NOT insert one, or the same sale gets TWO subscriptions and
         the renewal cron bills the customer twice a year for one service.

         The guard that would normally stop a duplicate does not apply here:
         record_payment skips creation only for a RENEWAL quote, which it detects by a
         subscription whose `renewal_quote_id` points at the quote — and this dialog
         sets `quote_id`, not that. Nothing would have caught it.

         What the operator gets instead of a silently-zeroed balance: a real payment
         row, a GST receipt voucher under §31(3)(d), the ledger and bank entries, and a
         clean undo (deleting the payment unwinds the customer and subscription). The
         invoice is raised by the caller once the money is actually recorded.

         The quote is left `awaiting` on purpose — it has not been paid yet. Marking it
         received here and then asking for the payment would be the app lying about
         money for as long as the sheet stayed open. */
      if (isPaid) {
        qc.invalidateQueries({ queryKey: ["quotes"] });
        qc.invalidateQueries({ queryKey: ["customers"] });
        /* The contact written at Step 1b — otherwise the customer's page still shows
           "This customer has no contact" until a manual refresh. */
        qc.invalidateQueries({ queryKey: ["contacts"] });
        onNeedsPayment?.({
          quoteId,
          customerId,
          customerName: cleanCustomerName,
          expectedAmount: grossAmount(storedTaxable, TAX_RATE_PCT),
          lineItems,
          domain: cleanDomain,
        });
        onOpenChange(false);
        return;
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
        /* Both columns existed from the start and this dialog wrote neither, so all
           five rows in the database carry the DB defaults ('yearly', 12) whatever was
           actually sold. term_months is 1 for flex: there is no commitment to spread. */
        billing_cycle: terms.billingCycle,
        term_months: terms.termMonths,
        start_date: startDate,
        renewal_date: renewalDate,
        /* ── A postpaid subscription ALWAYS gets a due date ──────────────────
           Guaranteed by the guard at the top of this handler, not by a fallback. The
           first version defaulted an empty box to start + 30; Abhishek changed it on
           11 Sep 2026 to blank-and-required, which is stricter and more honest — a
           countdown should only ever count toward a date somebody actually agreed.

           Null still reaches this column from other paths — prepaid, and every row
           created before 10 Sep 2026 — and those correctly show nothing. */
        payment_due_date: paymentDueDate,
        status: "active",
        domain: cleanDomain,
        quote_id: quoteId,
        /* The catalog link, supplied directly now instead of being inferred from the
           plan text by trg_subscriptions_resolve_item (migration 0248). The trigger
           stays as the safety net for the other five write paths. */
        item_id: itemId,
        /* Also GST-inclusive: this is money owed, not revenue recognised. It has to
           match the quote's `amount` or the subscription and the quote disagree
           about the same debt. */
        /* Only the POSTPAID path reaches this line now — the paid path returned at
           Step 3a — so the balance is always the full GST-inclusive debt. */
        outstanding_amount: grossAmount(storedTaxable, TAX_RATE_PCT),
        auto_renew: true,
      });

      if (subErr) throw subErr;

      toast.success(`Subscription & Customer record created for ${cleanCustomerName}!`, {
        description: `Postpaid credit quote #${quoteId} & Active subscription created.`,
      });

      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["contacts"] });

      onSuccess?.();
      onOpenChange(false);
    } catch (err: unknown) {
      /* Supabase errors are PLAIN OBJECTS, not Error instances. `err instanceof
         Error` was therefore false for every database failure here, so the real
         message was thrown away and replaced with "Failed creating subscription" —
         a sentence that tells the operator nothing and cost this bug a debugging
         session. Read the shape Supabase actually returns, and show its code.  */
      const e = err as { message?: string; details?: string; hint?: string; code?: string } | null;
      const detail = e?.message || e?.details || (err instanceof Error ? err.message : "");
      toast.error(detail || "Failed creating subscription", {
        description: [e?.code && `code ${e.code}`, e?.hint].filter(Boolean).join(" · ") || undefined,
      });
      console.error("[add-subscription] failed:", err);
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
          {/* This claimed "generates the Audit Quote & Invoice" and NO invoice was ever
              created — a GST document the operator believed existed. Corrected 9 Sep
              2026: it now names the two paths, and only the paid one raises an invoice
              (via generate_invoice, after the payment is recorded). */}
          <DialogDescription className="text-xs text-ink-3">
            Auto-creates or links the <b>Customer CRM record</b>, raises an accepted{" "}
            <b>Quote</b>, and activates the <b>Subscription</b>.{" "}
            {paymentTerms === "paid"
              ? "Payment is recorded next, and the GST invoice is raised from it."
              : "No GST invoice yet — postpaid tracks the balance until payment."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-4">
          {/* Customer Selection or New Input */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Existing Customer (Select or Clear)" htmlFor="existingCustomerSelect">
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
                  className="text-2xs font-bold text-rose-600 hover:text-rose-700 flex items-center gap-1 mt-1 cursor-pointer"
                >
                  <Icon name="x" size={12} />
                  <span>Clear Selection & Type Brand New Customer</span>
                </button>
              )}
            </FormField>

            <FormField label="Customer Company Name *" required htmlFor="custName">
              <Input
                id="custName"
                placeholder="e.g. Sharma Cloud Solutions"
                value={customerName}
                /* Typing over the name DETACHES the dropdown selection. Without this,
                   picking "Acme" and then typing "FF Impex" left selectedCustomerId
                   pointing at Acme — so the form still believed it was an existing
                   customer, hid the contact block, and created FF Impex with nobody on
                   it. Reported 17 Sep 2026; that is exactly how it happened. */
                onChange={(e) => { setCustomerName(e.target.value); setSelectedCustomerId(""); }}
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
                /* Same reason as the name above — the domain is the stronger identity
                   of the two, so editing it certainly means a different customer. */
                onChange={(e) => { setDomain(e.target.value); setSelectedCustomerId(""); }}
                required
              />
              <p className="text-2xs text-ink-3 mt-1">Essential for Google/M365 Console provisioning.</p>
            </FormField>

            {/* Kept in this grid so the row stays balanced — and it is the field the
                operator reaches for straight after the domain. */}
            {needsContact && (
              <FormField label="Contact Person" required htmlFor="contactName">
                <Input
                  id="contactName"
                  placeholder="e.g. Ranjeet Kumar — or search existing"
                  value={contactName}
                  /* Typing means "not the person I picked" until they pick again. */
                  onChange={(e) => { setContactName(e.target.value); setPickedContactId(null); setContactQueryOpen(true); }}
                  onFocus={() => setContactQueryOpen(true)}
                  required
                />

                {/* ── People already on file ───────────────────────────────────
                    The fix for the collision Abhishek hit: the person holding that email
                    appears HERE, before the form is submitted, so he attaches them
                    instead of discovering at the end that the address is taken. */}
                {contactQueryOpen && contactMatches.length > 0 && !pickedContactId && (
                  <ul className="mt-1 rounded-lg border border-hairline bg-paper shadow-sm overflow-hidden">
                    <li className="px-2.5 py-1 text-3xs uppercase tracking-wider text-ink-3 bg-paper-2">
                      Already in your contacts — click to use
                    </li>
                    {contactMatches.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => pickContact(p)}
                          className="w-full text-left px-2.5 py-1.5 hover:bg-paper-2/70 transition-colors"
                        >
                          <span className="text-sm text-ink">{p.full_name || "(no name)"}</span>
                          {p.email && <span className="ml-1.5 text-2xs text-ink-3">{p.email}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {pickedContactId ? (
                  <p className="text-2xs text-emerald mt-1 flex items-center gap-1">
                    <Icon name="check_circle" size={12} />
                    Using an existing contact — they will be added to this customer too.
                  </p>
                ) : (
                  <p className="text-2xs text-ink-3 mt-1">
                    Gets the invoices and payment reminders. Start typing to reuse someone
                    already in your contacts.
                  </p>
                )}
              </FormField>
            )}
          </div>

          {/* ── The rest of that person — all of it required ──────────────────────
              Email and phone were optional in the first cut of this block and Abhishek
              made them mandatory the same day. The email is how an invoice and a payment
              reminder leave the building and the phone is what the chase uses when the
              email goes unanswered, so a contact missing both satisfies the "one contact
              is must" rule while still leaving nobody reachable. */}
          {needsContact && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 rounded-xl border border-hairline bg-paper-2 p-3">
              <FormField label="Contact Email" required htmlFor="contactEmail">
                <Input
                  id="contactEmail"
                  type="email"
                  placeholder="e.g. ranjeet@exceltechnologies.in"
                  value={contactEmail}
                  onChange={(e) => { setContactEmail(e.target.value); setPickedContactId(null); setContactQueryOpen(true); }}
                  required
                />
              </FormField>
              <FormField label="Customer's state (GST)" required htmlFor="newCustState">
                <GstStateSelect id="newCustState" value={newCustState} onChange={setNewCustState} allowExport />
              </FormField>
              <FormField label="Contact Phone" required htmlFor="contactPhone">
                <Input
                  id="contactPhone"
                  type="tel"
                  placeholder="+91 98765 43210"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  required
                />
              </FormField>
              {/* Required, and already satisfied: the dropdown opens on "Point of
                  contact" and Radix offers no way to clear it. The asterisk is there to
                  say the field matters, not to threaten the operator with a block they
                  cannot trigger. */}
              <FormField label="Role" required htmlFor="contactRole">
                <Select
                  value={contactRole}
                  onValueChange={(val) => setContactRole(val as ContactRole)}
                >
                  <SelectTrigger id="contactRole">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONTACT_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            </div>
          )}

          {/* Vendor & Plan Selection */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Cloud Vendor *" required htmlFor="vendor">
              <Select value={vendor} onValueChange={(val: any) => handleVendorChange(val)}>
                <SelectTrigger id="vendor">
                  <SelectValue />
                </SelectTrigger>
                {/* Vendors the tenant ACTUALLY sells, from the catalog. The old
                    hardcoded four hid `hosting`, `support` and `domain` — which the
                    DB enum has always allowed and which are 7 of this tenant's 17
                    subscription products. `other` is always offered as the home for
                    a custom plan. */}
                <SelectContent>
                  {vendorOptions.map((v) => (
                    <SelectItem key={v} value={v}>{VENDOR_LABEL[v] ?? v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            <FormField label="Plan / SKU Product *" required htmlFor="planSelect">
              {!isCustomPlan ? (
                <Select value={itemId ?? ""} onValueChange={handlePlanSelect}>
                  <SelectTrigger id="planSelect">
                    <SelectValue placeholder={
                      catalogLoading ? "Loading catalogue…"
                      : forVendor.length === 0 ? "No products for this vendor"
                      : "-- Select Vendor Product / SKU --"
                    } />
                  </SelectTrigger>
                  {/* Values are item IDs, not names: two catalog rows can share a name
                      (this tenant has "Standard" under both hosting and support), and
                      the id is what gets stored on the subscription. */}
                  <SelectContent>
                    {forVendor.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} ({rupee(p.annualSellPerSeat)}/yr)
                      </SelectItem>
                    ))}
                    <SelectItem value="CUSTOM_PLAN">✍️ Custom Product Name / Other SKU...</SelectItem>
                  </SelectContent>
                </Select>
              ) : null}

              {/* An empty catalogue used to be impossible because the list was baked in.
                  Now it is possible, so it has to say what to do — and NOT block: the
                  custom-plan path still works, it just cannot check the margin. */}
              {!catalogLoading && products.length === 0 && !isCustomPlan && (
                <p className="mt-1 text-2xs leading-snug text-ink-3">
                  Your catalogue is empty. Add products in{" "}
                  <a href="/items" className="font-semibold text-primary hover:underline">
                    Catalog &amp; Products
                  </a>{" "}
                  to get prices and margin checks, or use a custom product name.
                </p>
              )}

              {isCustomPlan && (
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
                      const first = productsForVendor(products, vendor)[0] ?? products[0];
                      if (first) applyProduct(first);
                    }}
                    className="text-2xs font-bold text-amber-ink hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <Icon name="arrow_left" size={12} />
                    <span>Back to Product Catalog Dropdown</span>
                  </button>
                </div>
              )}
            </FormField>
          </div>

          {/* Billing period — decides what the price field MEANS, so it sits above it. */}
          <FormField label="Billing Period *" required htmlFor="billingChoice">
            <Select value={billingChoice} onValueChange={(v) => changeBillingChoice(v as BillingChoice)}>
              <SelectTrigger id="billingChoice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BILLING_CHOICES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-2xs leading-snug text-ink-3">
              {BILLING_CHOICES.find((c) => c.value === billingChoice)?.hint}
            </p>
          </FormField>

          {/* Seats, Price & Financial Summary */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <FormField label="License Seats *" required htmlFor="seats">
              <Input
                id="seats"
                type="number"
                min={1}
                value={seatsText}
                onChange={(e) => setSeatsText(e.target.value)}
                required
              />
            </FormField>

            {/* The label carries the UNIT and it changes with the dropdown. A number
                whose meaning depends on another control has to say which meaning is
                live, or ₹3,240 gets read as a month. */}
            <FormField label={`Unit Price (${terms.unitLabel}) *`} required htmlFor="pricePerSeat">
              <Input
                id="pricePerSeat"
                type="number"
                min={0}
                value={priceText}
                onChange={(e) => setPriceText(e.target.value)}
                required
              />
              {/* The margin, live, next to the number being typed. The defaults this
                  replaced sat below vendor cost for months with nothing on screen to
                  say so — on M365 Business Standard, ₹7,920 against a ₹9,840 cost.
                  Costs read ANNUALISED, matching the verdict, so the "/yr" is true
                  even while the field itself is showing a monthly rate. */}
              {verdict.kind === "loss" && (
                <p className="mt-1 flex items-start gap-1 text-2xs font-semibold leading-snug text-rose">
                  <Icon name="alert" size={12} className="mt-px flex-shrink-0" />
                  <span>
                    Below cost — the vendor charges {rupee(annualisedCost!)}/yr.
                    Losing {rupee(verdict.shortfallPerSeatYear)} per seat per year.
                  </span>
                </p>
              )}
              {verdict.kind === "thin" && (
                <p className="mt-1 text-2xs font-semibold leading-snug text-amber-ink">
                  Only {verdict.marginPct.toFixed(1)}% margin — cost is{" "}
                  {rupee(annualisedCost!)}/yr.
                </p>
              )}
              {verdict.kind === "ok" && (
                <p className="mt-1 text-2xs leading-snug text-ink-3">
                  {verdict.marginPct.toFixed(1)}% margin over {rupee(annualisedCost!)}/yr cost.
                </p>
              )}
              {verdict.kind === "unknown" && selected && (
                <p className="mt-1 text-2xs leading-snug text-ink-3">
                  No vendor cost in the catalogue — margin unknown, not zero.
                </p>
              )}
              {/* Flex has its own, higher price tier. When the catalogue has none, the
                  annual rate is shown as a starting point — and SAID to be, because
                  selling cancel-any-time at the committed rate gives the flexibility
                  premium away silently. */}
              {terms.flexPriceMissing && (
                <p className="mt-1 flex items-start gap-1 text-2xs font-semibold leading-snug text-amber-ink">
                  <Icon name="alert" size={12} className="mt-px flex-shrink-0" />
                  <span>
                    No flex price in the catalogue — this is the annual-commitment rate.
                    Flex normally costs more; raise it or add a flex price at /items.
                  </span>
                </p>
              )}
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
                onChange={(e) => changeStartDate(e.target.value)}
                required
              />
              <p className="mt-1 text-2xs leading-snug text-ink-3">
                Back-dating is fine — the expiry date follows to keep the term
                {" "}{terms.termMonths === 1 ? "one month" : `${terms.termMonths} months`} long.
              </p>
            </FormField>

            <FormField label="Renewal / Expiry Date *" required htmlFor="renewalDate">
              <Input
                id="renewalDate"
                type="date"
                value={renewalDate}
                onChange={(e) => setRenewalDate(e.target.value)}
                required
              />
              {/* Says WHICH date this is. On "Monthly — annual commitment" it reads a
                  year out, which looks wrong until you know it marks the end of the
                  commitment and not the next invoice. That confusion was reported. */}
              <p className="mt-1 text-2xs leading-snug text-ink-3">
                {terms.commitment === "monthly"
                  ? "Flex renews every month — no commitment to expire."
                  : terms.billingCycle === "monthly"
                    ? "End of the 12-month commitment. Invoices still go out monthly."
                    : "End of the 12-month term, when the next yearly invoice is due."}
              </p>
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
                <div className="text-2xs text-ink-3">
                  Activates subscription now without upfront payment. Quote/Invoice tracks pending balance in Debtors Ledger.
                </div>
              </button>

              {/* Copy rewritten 9 Sep 2026. It used to say "Marks quote/invoice fully
                  paid" — which it did, by zeroing the balance with no payment row, no
                  receipt voucher and no bank entry. It now says what actually happens,
                  because the next screen is a form the operator has to fill in and
                  being surprised by it is a worse experience than being told. */}
              <button
                type="button"
                onClick={() => setPaymentTerms("paid")}
                disabled={!onNeedsPayment}
                title={onNeedsPayment ? undefined : "Not available from here"}
                className={`p-3 rounded-lg border text-xs text-left transition-all ${
                  !onNeedsPayment
                    ? "bg-paper-2 border-hairline text-ink-3 opacity-50 cursor-not-allowed"
                    : paymentTerms === "paid"
                      ? "bg-emerald-soft/60 border-emerald text-emerald-ink font-bold shadow-xs"
                      : "bg-paper-2 border-hairline text-ink-3 hover:bg-paper-3"
                }`}
              >
                <div className="font-semibold text-ink flex items-center gap-1.5 mb-0.5">
                  <Icon name="check_circle" size={14} className="text-emerald-ink" />
                  <span>💳 Payment Received (Paid)</span>
                </div>
                <div className="text-2xs text-ink-3">
                  {onNeedsPayment
                    ? "Opens Record payment next — logs the money, issues the GST receipt voucher, activates the subscription and raises the GST invoice."
                    : "Unavailable here — record the payment from the quote instead."}
                </div>
              </button>
            </div>
          </FormField>

          {/* ── Postpaid: when is the money due? ──────────────────────────────
              Only for credit terms, because it is the only path that leaves a
              balance owed. Until this existed, "Postpaid" activated a subscription
              and booked the full GST-inclusive amount as owed while nothing on any
              screen said when it was expected — and the app's reminder ladder hangs
              off an invoice this path deliberately never raises. */}
          {paymentTerms === "credit" && (
            <FormField label="Payment due date *" required htmlFor="paymentDueDate">
              {/* REQUIRED and blank by default. The earlier version pre-filled start + 30
                  and fell back to it when empty; that made it possible to activate credit
                  against a date nobody had agreed. The submit guard above is the real
                  enforcement — this attribute is for the asterisk and the semantics. */}
              <Input
                id="paymentDueDate"
                type="date"
                value={paymentDueDate}
                onChange={(e) => setPaymentDueDate(e.target.value)}
                required
              />
              <p className="mt-1 text-2xs leading-snug text-ink-3">
                {(() => {
                  if (!paymentDueDate) {
                    return "When did you agree the balance is due? This drives the countdown and the overdue highlight on Subscriptions.";
                  }
                  const s = paymentDueState(paymentDueDate, todayIST(), 1);
                  if (s.kind === "overdue") {
                    return `Already ${s.label} — this subscription will show highlighted the moment it is created.`;
                  }
                  if (s.kind === "due_today") return "Due today.";
                  return `${s.label} from today.`;
                })()}
              </p>
            </FormField>
          )}

          {/* Financial Calculation Summary Box */}
          <div className="p-3 bg-primary-soft/30 border border-primary/20 rounded-xl flex items-center justify-between text-xs">
            <div>
              {/* Two different numbers, and conflating them is the whole hazard here:
                  the CONTRACT (what the quote stores) and the FIRST INVOICE (what is
                  asked for now). They are equal on yearly, and differ 12× on an
                  annual commitment billed monthly. Both are stated. */}
              <span className="text-ink-3">
                {terms.termMonths === 12 ? "Total Annual Contract Value (ARR):" : "Monthly Contract Value:"}
              </span>
              <div className="font-serif text-lg font-bold text-ink">{rupee(storedTaxable)}</div>
              {/* ARR is the ex-GST revenue figure; the customer is billed the
                  GST-inclusive one. Showing only the first is what let a ₹4,320 gap
                  between "what this says" and "what gets charged" go unnoticed. */}
              <div className="text-2xs text-ink-3">
                Customer pays <b className="text-ink-2">{rupee(grossAmount(storedTaxable, TAX_RATE_PCT))}</b> incl. {TAX_RATE_PCT}% GST
              </div>
              {terms.periods > 1 && (
                <div className="mt-1 text-2xs font-semibold text-ink-2">
                  Invoiced monthly —{" "}
                  <b>{rupee(grossAmount(perPeriodAmount, TAX_RATE_PCT))}</b> due this month,
                  × 12 over the committed year.
                </div>
              )}
              {terms.commitment === "monthly" && (
                <div className="mt-1 text-2xs font-semibold text-ink-2">
                  Flex — billed month to month, no commitment. Cancel any time.
                </div>
              )}
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
            <Button variant="primary" type="submit" disabled={submitting} className="font-bold px-5">
              {submitting ? "Creating Records..." : "⚡ Activate Subscription & Auto-Sync Ledger"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
