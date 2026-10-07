/**
 * AddLeadForm — modal dialog to create OR edit a lead.
 *
 * - When `editingLead` is null/undefined → creates a new lead
 * - When `editingLead` is a Lead object  → pre-fills + updates that lead
 *
 * Validates via Zod + React Hook Form.
 *
 * @example
 * // create
 * <AddLeadForm open={open} onOpenChange={setOpen} />
 *
 * // edit
 * <AddLeadForm open={open} onOpenChange={setOpen} editingLead={lead} />
 */
"use client";

import * as React from "react";
import { useRouter, usePathname } from "next/navigation";
import { revealSavedLead } from "@/components/features/leads/reveal-saved-lead";
import type { Route } from "next";
import { useForm } from "react-hook-form";
import { FieldPill } from "@/components/ui/field-pill";
import { SmartPaste } from "@/components/shared/smart-paste";
import {
  liveGstin, checkGstin, livePhone, commitPhone, checkPhone, liveEmail, checkEmail,
  liveMoney, commitMoney, parseMoney, checkMoney, gstinState,
} from "@/lib/forms/poka-yoke";
import { useDraftGuard } from "@/lib/hooks/useDraftGuard";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useCreateLead, useUpdateLead, useLeadDuplicateCheck } from "@/lib/queries/leads";
import { dupCheckKeys, duplicateWarning, pickDuplicate } from "@/lib/leads/duplicate-check";
import { BILLING_CYCLE_OPTIONS, billingCycleLabel, monthlyBill, toBillingCycle } from "@/lib/leads/billing-cycle";
import { stageShownOnPage } from "@/lib/leads/page-scope";
import { PROJECT_PLAN_LABEL } from "@/lib/leads/enquiry";
import { amountInIndianWords } from "@/lib/accounting/amount-words";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { canonicalSource, sourceOptions } from "@/lib/leads/lead-sources";
import { autoDealValue, dealFormErrors, needsDealDetails, type DealFormField } from "@/lib/leads/deal-rules";
import { CustomerCombobox } from "@/components/features/customers/customer-combobox";
import { useCustomers } from "@/lib/queries/customers";
import type { Lead, LeadPriority } from "@/lib/supabase/database.types";
import { formatIstDate, istToday } from "@/lib/dates/ist";
import { WORKSPACE_LIST_PRICE_PM } from "@/lib/catalog/workspace-floor";
import { STAGE_META } from "@/lib/leads/stage-meta";
import { leadStatePatch, stateFromLeadGstin, stateLabel } from "@/lib/leads/lead-state";
import { GST_STATE_OPTIONS } from "@/lib/gst/gstin-state";

/* R-249: the same funnel order and labels as the board (lib/leads/stage-meta). */
const STAGES: { value: Lead["stage"]; label: string }[] = STAGE_META.map((s) => ({ value: s.id, label: s.label }));

// Quote-first funnel. A lead lives in the Leads inbox (pre-quote) until a
// quotation is sent; only then does it become a deal and unlock Demo/Trial/Won.
//   Pre-quote (Leads):  New, Contacted, Lost
//   Post-quote (Deals): Quote Sent, Demo Done, Trial Active, Won, Lost
const RAW_LEAD_STAGE_VALUES   = ["new", "contact", "lost"] as const;
const POST_QUOTE_STAGE_VALUES = ["quote", "demo", "trial", "won", "lost"] as const;

// Source options live in lib/leads/lead-sources.ts — their keys must match the ad-spend
// channels, so they are not a local list any more.

const PLANS = [
  "Google Workspace Business Starter",
  "Google Workspace Standard",
  "Google Workspace Plus",
  "Google Workspace Enterprise",
  "Microsoft 365 Business Basic",
  "Microsoft 365 Business Standard",
  "Microsoft 365 Business Premium",
  "Zoho Workplace Standard",
  "Zoho Workplace Professional",
  "Plus + Voice add-on",
  "Custom / Mixed",
] as const;

/**
 * Typical Indian reseller MRP per seat per month (INR).
 * Used to auto-calculate annual deal value = price × seats × 12.
 * Plans not in this map (e.g. Custom) skip auto-calculation.
 */
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

// Plan + seats + value are OPTIONAL on the lead schema.
//   • Filled → the lead enters the Deal Pipeline as a qualified deal.
//   • Empty  → the lead lives in the Lead Inbox awaiting qualification.
// This matches the conceptual split: raw inquiries (Inbox) vs qualified
// opportunities (Pipeline). Same DB table, different filter cuts.
/**
 * The three steps, and which fields each one owns.
 *
 * `STEP_FIELDS` drives per-step validation. Running the whole schema on "Next" would
 * red-flag a field two steps ahead that nobody has reached — the same "shouting at an
 * untouched field" that the validation pills exist to prevent.
 */
const STEP_LABELS = ["Contact", "Enquiry", "Review"] as const;
const STEP_FIELDS = [
  ["company", "contact_name", "contact_email", "contact_phone", "gstin", "state_code"],
  ["enquiry_type", "plan", "seats", "value", "requirement", "project_timeline", "stage", "source", "priority",
   "subscription_type", "billing_cycle", "current_provider", "follow_up_date", "expected_close_date", "owner_id", "notes"],
] as const;

/** The list price per seat per month for a plan, or undefined (Custom / Mixed, unknown). */
function listPricePerSeat(plan: string): number | undefined {
  return PLAN_PRICE_PER_SEAT_PM[plan];
}

/* ── Two kinds of enquiry ─────────────────────────────────────────────────────
   A licence enquiry is a plan × seats; a custom-software enquiry is a requirement, a
   budget and a timeline — seats mean nothing to it. The form used to force the second
   into "Custom / Mixed" with a seat count, and "Send quote" could only build a licence
   quote. The enquiry type decides which fields show and which quote it gets
   (migration 20260926110000). */
const ENQUIRY_TYPES = [
  { value: "subscription", label: "Subscription", hint: "Google / Microsoft / Zoho seats" },
  { value: "project",      label: "Custom software / project", hint: "App, ERP, website…" },
] as const;


/** A step's fields, or nothing. Kept as a component so the wrapper div is consistent. */
function Step({ show, children }: { show: boolean; children: React.ReactNode }) {
  if (!show) return null;
  return <div className="space-y-4">{children}</div>;
}

/**
 * One line on the review step.
 *
 * An unset field SAYS "not set" rather than showing a gap — a blank row reads as a
 * rendering fault, and an operator cannot tell it apart from a value that failed to load.
 */
function Review({ label, value, mono, note }: {
  label: string; value?: string | null; mono?: boolean; note?: string;
}) {
  const v = (value ?? "").trim();
  return (
    <div className="min-w-0">
      <dt className="text-3xs uppercase tracking-wider text-ink-3">{label}</dt>
      {v ? (
        <dd className={cn("break-words text-[13px] font-medium text-ink", mono && "font-mono")}>
          {v}{note && <span className="ml-1 font-sans text-xs font-normal text-ink-3">· {note}</span>}
        </dd>
      ) : (
        <dd className="text-[12px] italic text-ink-3">not set</dd>
      )}
    </div>
  );
}

const PRIORITY_OPTIONS: { value: LeadPriority; label: string; dot: string }[] = [
  { value: "low",    label: "Low",    dot: "bg-slate"   },
  { value: "medium", label: "Medium", dot: "bg-amber"   },
  { value: "high",   label: "High",   dot: "bg-rose"    },
];

// Helper: build an optional integer field that treats empty string / null /
// NaN as undefined. Raw leads leave seats / value blank; without this
// preprocess, Zod's `coerce.number()` turns "" into NaN and fails validation
// even though the field is .optional().
const optionalIntField = (max: number) =>
  z.preprocess(
    (v) => {
      if (v === "" || v === null || v === undefined) return undefined;
      if (typeof v === "number" && Number.isNaN(v)) return undefined;
      /* Commas, spaces and a rupee sign stripped before coercion. Two reasons, and the
         second is the one that bites: a value pasted straight out of a spreadsheet reads
         "₹1,76,640", and `z.coerce.number()` turns that into NaN and rejects a number the
         operator can plainly see in the box. It also lets the field format itself with
         Indian grouping on blur without the formatting breaking its own validation. */
      if (typeof v === "string") {
        const digits = v.replace(/[^0-9.-]/g, "");
        return digits === "" ? undefined : digits;
      }
      return v;
    },
    z.coerce.number().int().min(0).max(max).optional(),
  );

/* ── Contact ZAROORI, company nahi (29 Aug 2026) ─────────────────────────────
   Ye theek ulta tha: `company` min(2) maangta tha aur `contact_name` optional tha.

   Pardeep: "bina company ke lead ban sakti hai, par bina contact ke lead nahi ban sakti."
   Aur wo sirf pasand nahi hai — app khud ise sabit karti hai. Enquiry form wala inbound
   raasta `company: (p.company ?? "").toString().trim()` likhta hai
   (inbound-email/route.ts:130), yaani jisne company nahi bharee uski lead `company = ""`
   ke saath aati hai. `NOT NULL` khaali string nahi rokta.

   To ek taraf app kehti thi "company ke bina lead nahi banegi", aur doosri taraf khud
   waisi lead banati thi. Ab form wahi maangta hai jo har lead par sach me hota hai —
   aadmi ka naam. */
const schema = z.object({
  company:       z.string().optional().or(z.literal("")),
  contact_name:  z.string().min(2, "Contact name is required"),
  contact_email: z.string().email("Invalid email").optional().or(z.literal("")),
  contact_phone: z.string().optional(),
  gstin:         z.string().optional().or(z.literal("")),
  /* R-376 (a): GST state code ("06"). Optional — a valid GSTIN fills it by itself. */
  state_code:    z.string().optional().or(z.literal("")),
  enquiry_type:  z.enum(["subscription", "project"]),
  requirement:   z.string().optional().or(z.literal("")),
  project_timeline: z.string().optional().or(z.literal("")),
  plan:          z.string().optional().or(z.literal("")),
  seats:         optionalIntField(10000),
  value:         optionalIntField(100_000_000),
  stage:         z.enum(["new", "contact", "quote", "demo", "trial", "won", "lost"]),
  source:        z.string(),
  priority:      z.enum(["low", "medium", "high"]),
  follow_up_date: z.string().optional().or(z.literal("")),
  /* Plain YYYY-MM-DD (the column is `date`). Required-ness and "not in the past" depend on
     the stage and on today, so they live in lib/leads/deal-rules.ts#dealFormErrors. */
  expected_close_date: z.string().optional().or(z.literal("")),
  owner_id:     z.string().optional().or(z.literal("")),
  subscription_type: z.enum(["fresh", "switch"]).optional().or(z.literal("")),
  /* R-071: descriptive — `value` stays the ANNUAL deal value (lib/leads/billing-cycle.ts). */
  billing_cycle: z.enum(["monthly", "yearly"]).optional().or(z.literal("")),
  current_provider: z.string().max(120, "Keep it short").optional().or(z.literal("")),
  notes:         z.string().optional(),
});

type FormData = z.infer<typeof schema>;

interface AddLeadFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the form pre-fills + updates this lead instead of creating new. */
  editingLead?: Lead | null;
  /** Default stage for a NEW record. Passed as a deal stage (e.g. "quote") when
   *  invoked from the Deal Pipeline so "Add Deal" actually lands in the pipeline. */
  defaultStage?: FormData["stage"];
}

export function AddLeadForm({ open, onOpenChange, editingLead, defaultStage }: AddLeadFormProps) {
  const router    = useRouter();
  const pathname  = usePathname();
  const createLead = useCreateLead();
  /* An existing customer's new need — more seats, another product, a software project
     (migration 20260926250000). Picking the customer fills the contact fields from it and
     links the lead, so an upsell is not re-keyed as a stranger. */
  const { data: customerList } = useCustomers();
  const [forCustomer, setForCustomer] = React.useState<boolean>(Boolean(editingLead?.customer_id));
  const [customerId, setCustomerId] = React.useState<string>(editingLead?.customer_id ?? "");
  const updateLead = useUpdateLead();
  const isEditing  = !!editingLead;
  const { data: me } = useCurrentUser();

  // Active users in the current tenant — drives the Owner dropdown so sales
  // teams can hand off / claim leads. RLS scopes to caller's tenant.
  const { data: tenantUsers } = useQuery({
    enabled: open,
    queryKey: ["tenant", "active-users", me?.tenantId],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, email, role")
        .eq("is_active", true)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const [stage, setStage] = React.useState<FormData["stage"]>(
    (editingLead?.stage as FormData["stage"]) ?? "new",
  );
  const [source, setSource]     = React.useState<string>(canonicalSource(editingLead?.source) || "manual");
  const [plan, setPlan]         = React.useState<string>(editingLead?.plan ?? "");
  const [priority, setPriority] = React.useState<LeadPriority>((editingLead?.priority as LeadPriority) ?? "medium");
  const [ownerId, setOwnerId]   = React.useState<string>(editingLead?.owner_id ?? "");
  const [enquiry, setEnquiry]   = React.useState<FormData["enquiry_type"]>(editingLead?.enquiry_type ?? "subscription");
  const isProject = enquiry === "project";

  // Contacts Picker API support detection. Currently Android Chrome / Edge
  // mobile only; iOS Safari + Firefox + desktop all fall back to manual.
  // Spec: https://w3c.github.io/contact-picker/
  const [contactsApiAvailable, setContactsApiAvailable] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    setContactsApiAvailable(
      // @ts-expect-error — Contacts Picker not in lib.dom.d.ts yet
      Boolean(navigator.contacts && typeof navigator.contacts.select === "function" && window.ContactsManager),
    );
  }, []);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    getValues,
    getFieldState,
    trigger,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: editingLead
      ? {
          company:        editingLead.company,
          contact_name:   editingLead.contact_name  ?? "",
          contact_email:  editingLead.contact_email ?? "",
          contact_phone:  editingLead.contact_phone ?? "",
          gstin:          editingLead.gstin         ?? "",
          state_code:     editingLead.state_code    ?? "",
          enquiry_type:   editingLead.enquiry_type  ?? "subscription",
          requirement:    editingLead.requirement   ?? "",
          project_timeline: editingLead.project_timeline ?? "",
          plan:           editingLead.plan          ?? "",
          // Display null seats/value as blank (not 1/0) so raw leads being
          // edited don't suddenly look like real deals with phantom numbers.
          seats:          editingLead.seats         ?? undefined,
          value:          editingLead.value         ?? undefined,
          stage:         (editingLead.stage  as FormData["stage"]) ?? "new",
          source:         canonicalSource(editingLead.source) || "manual",
          priority:      (editingLead.priority as LeadPriority) ?? "medium",
          follow_up_date: editingLead.follow_up_date ?? "",
          expected_close_date: editingLead.expected_close_date ?? "",
          owner_id:       editingLead.owner_id      ?? "",
          subscription_type: editingLead.subscription_type ?? "",
          billing_cycle:  editingLead.billing_cycle ?? "",
          current_provider: editingLead.current_provider ?? "",
          notes:          editingLead.notes         ?? "",
        }
      : {
          enquiry_type: "subscription",
          stage:    defaultStage ?? "new",
          source:   "manual",
          priority: "medium",
          // Seats/value intentionally left blank for raw leads. They get
          // pre-filled with sensible defaults (10 seats + auto-calc) only
          // when the user picks a plan — see the useEffect below.
        },
  });

  // Flags the workspace tab while this form holds unsaved input, so closing
  // it asks first and the 8-tab limit cannot evict it silently. isDirty is
  // React Hook Form's own comparison against defaultValues, so re-typing the
  // original value correctly counts as clean.
  useDraftGuard(isDirty && !isSubmitting);

  /* ── Progressive disclosure ──────────────────────────────────────────────
     Steps are for CREATING a lead only. Somebody who opened this sheet to correct one
     phone number should not be walked through a wizard to reach it, so an edit keeps
     the single long form it has always had. */
  const useSteps = !isEditing;
  const [step, setStep] = React.useState(1);
  React.useEffect(() => { if (open) setStep(1); }, [open]);

  const watchedSeats = watch("seats");

  /* The money box's DISPLAY string, kept apart from the form's numeric value — see the
     comment on the field itself. Seeded from the form so an edit opens with the existing
     amount already grouped, and re-seeded whenever the auto-calculation writes one. */
  const watchedValue = watch("value");
  const [valueText, setValueText] = React.useState("");
  React.useEffect(() => {
    setValueText((current) =>
      /* Only when they disagree, so this never fights the operator mid-keystroke: while
         typing "1766" the form already holds 1766 and the two agree. */
      parseMoney(current) === (watchedValue ?? null) ? current
        : watchedValue == null ? "" : commitMoney(String(watchedValue)),
    );
  }, [watchedValue]);

  // ── Duplicate warning ──────────────────────────────────────────────
  // As the operator types company / phone, surface any EXISTING lead that
  // already matches — so they open it instead of creating a second record.
  // Prevention beats cleanup. Skips the lead being edited. Non-blocking:
  // it's a heads-up with a link, never a hard stop.
  /* R-072: asked of find_lead_duplicates() — GSTIN, email, phone or company (lib/leads/
     duplicate-check.ts), strongest match first, with the owner's name. Only keys worth
     asking go to the server, a beat after the last keystroke, and only while the dialog is
     open. For an existing customer their closed (won / lost) leads are history, not a
     duplicate (pickDuplicate). */
  const wCompany = watch("company");
  const wPhone   = watch("contact_phone");
  const wEmail   = watch("contact_email");
  const wGstin   = watch("gstin");
  const [dupKeys, setDupKeys] = React.useState(() => dupCheckKeys({}));
  React.useEffect(() => {
    const t = setTimeout(() => setDupKeys(dupCheckKeys({ company: wCompany, phone: wPhone, email: wEmail, gstin: wGstin })), 300);
    return () => clearTimeout(t);
  }, [wCompany, wPhone, wEmail, wGstin]);
  /* R-376 (a): a valid GSTIN proves the state (its first two digits) — fill the State select
     from it. Only when the GSTIN was typed/picked in this sitting, or no state is set yet: an
     edit that merely opens a lead must not silently rewrite the state saved on it. */
  const gstinStateCode = stateFromLeadGstin(wGstin);
  React.useEffect(() => {
    if (!gstinStateCode) return;
    const current = getValues("state_code") ?? "";
    if (current === gstinStateCode) return;
    if (current && !getFieldState("gstin").isDirty) return;
    setValue("state_code", gstinStateCode, { shouldDirty: true });
  }, [gstinStateCode, getValues, getFieldState, setValue]);
  const { data: dupCandidates } = useLeadDuplicateCheck(dupKeys, editingLead?.id, open);
  const dupMatch = React.useMemo(() => pickDuplicate(dupCandidates, forCustomer), [dupCandidates, forCustomer]);

  /**
   * Open the native Contacts Picker (Android Chrome / Edge Mobile only).
   * User selects ONE contact → we autofill name + phone + email into the
   * form. On iOS Safari / unsupported browsers the button is hidden by
   * the contactsApiAvailable gate, so this never runs.
   */
  const pickContact = React.useCallback(async () => {
    try {
      const props = ["name", "tel", "email"] as const;
      // @ts-expect-error — Contacts Picker not in lib.dom.d.ts yet
      const contacts = await navigator.contacts.select(props, { multiple: false }) as Array<{
        name?:  string[];
        tel?:   string[];
        email?: string[];
      }>;
      if (!contacts || contacts.length === 0) return;  // user cancelled

      const c     = contacts[0];
      const name  = c.name?.[0]  ?? "";
      const phone = c.tel?.[0]   ?? "";
      const email = c.email?.[0] ?? "";

      if (name)  setValue("contact_name",  name,  { shouldDirty: true });
      if (phone) setValue("contact_phone", phone, { shouldDirty: true });
      if (email) setValue("contact_email", email, { shouldDirty: true });
    } catch (err) {
      // User denied permission, or browser bailed. Silent — button is still
      // there as a no-op so they fall back to manual entry.
      console.warn("[contacts-picker] failed:", err);
    }
  }, [setValue]);

  /* ── Deal value = seats × price per seat × 12 — only when the USER changes an input ──
     Price per seat is editable (prefilled from the plan's list price, PLAN_PRICE_PER_SEAT_PM)
     because a reseller's real price is negotiated.

     BUG this replaces (Deals audit, 30 Sep 2026): the effect ran on plan/seats with no
     editingLead guard, so merely OPENING Edit on a deal recalculated list price × seats × 12
     and overwrote the negotiated value that was saved. Now `autoCalcArmed` starts false on
     every open and only the user's own change of plan / seats / price arms it; a value the
     user typed wins until they clear it (lib/leads/deal-rules.ts#autoDealValue). */
  const [priceText, setPriceText] = React.useState("");
  const pricePerSeat = parseMoney(priceText) ?? undefined;
  const autoCalcArmed = React.useRef(false);
  const valueTyped    = React.useRef(false);
  const armAutoCalc = () => { autoCalcArmed.current = true; };
  React.useEffect(() => {
    const next = autoDealValue({
      armed: autoCalcArmed.current, valueTyped: valueTyped.current, seats: watchedSeats, pricePerSeat,
    });
    if (next !== null) setValue("value", next, { shouldValidate: true, shouldDirty: true });
  }, [watchedSeats, pricePerSeat, setValue]);

  // Quote-first funnel: Demo/Trial/Quote/Won are reachable ONLY after a quote
  // is sent. So a pre-quote lead (New/Contacted, or a brand-new one) may only
  // be set to New / Contacted / Lost here — sending a quote (not this form) is
  // what crosses the gate into the deal stages. A lead already past the gate
  // (stage quote/demo/trial/won/lost) gets the deal-stage set.
  // Deal stages are allowed when editing a lead already past the quote gate, OR
  // when adding a NEW record straight into the Deal Pipeline (defaultStage is a
  // deal stage — "Add Deal" on /deals). Otherwise a raw lead can only be New / Contacted / Lost.
  const dealMode = editingLead
    ? (POST_QUOTE_STAGE_VALUES as readonly string[]).includes(editingLead.stage)
    : !!defaultStage && (POST_QUOTE_STAGE_VALUES as readonly string[]).includes(defaultStage);
  const availableStages = React.useMemo(() => {
    const allowed = dealMode ? POST_QUOTE_STAGE_VALUES : RAW_LEAD_STAGE_VALUES;
    return STAGES.filter((s) => (allowed as readonly string[]).includes(s.value));
  }, [dealMode]);
  /** Plan, company and close date are required at this stage (lib/leads/deal-rules.ts). */
  const dealDetailsRequired = needsDealDetails(stage);

  /** The deal rules zod cannot hold (stage- and today-dependent). Marks each field and
   *  returns false when something is missing. Run on "Next" from step 2 and on save. */
  const checkDealRules = (): boolean => {
    const v = getValues();
    const errs = dealFormErrors({
      stage, isProject, company: v.company, plan, requirement: v.requirement, value: v.value,
      expectedClose: v.expected_close_date, today: istToday(),
      savedClose: editingLead?.expected_close_date ?? null,
    });
    const fields = Object.keys(errs) as DealFormField[];
    for (const f of fields) setError(f, { type: "deal", message: errs[f] });
    if (fields.length > 0) {
      toast.error("Required fields missing", {
        description: fields.map((f) => errs[f]).join(" · "),
      });
    }
    return fields.length === 0;
  };

  // Keep the selected stage within the allowed set (e.g. if it drifted out of
  // range for this lead's funnel position).
  React.useEffect(() => {
    if (!availableStages.some((s) => s.value === stage)) {
      const fallback = (availableStages[0]?.value ?? "new") as FormData["stage"];
      setStage(fallback);
      setValue("stage", fallback, { shouldDirty: true });
    }
  }, [availableStages, stage, setValue]);

  // Seats / value gate on plan, same conceptual pattern as stage gating:
  //   • Plan empty (raw lead) → keep seats / value blank. Sales rep is just
  //     capturing "met someone at expo" — no commercial detail yet. Leaving
  //     these blank prevents the leads table from showing phantom "10 seats
  //     · ₹1,00,000" on every raw inbox row.
  //   • Plan picked (qualified deal) → pre-fill 10 seats. The existing
  //     auto-calc effect below then computes the annual value from the
  //     catalog price × 12. User can override either.
  // Editing existing leads is unaffected — the reset() block above carries
  // whatever values the lead was saved with.
  React.useEffect(() => {
    if (editingLead || isProject) return;
    if (plan) {
      const currentSeats = getValues("seats");
      if (!currentSeats || Number.isNaN(currentSeats) || currentSeats < 1) {
        setValue("seats", 10, { shouldDirty: true });
      }
    } else {
      // Plan went back to empty — clear seats / value so the raw lead
      // doesn't carry phantom numbers from a previous plan selection.
      setValue("seats", undefined as unknown as number, { shouldDirty: true });
      setValue("value", undefined as unknown as number, { shouldDirty: true });
    }
  }, [plan, editingLead, isProject, getValues, setValue]);

  // Reset form when modal closes OR when editingLead changes (re-fills defaults).
  React.useEffect(() => {
    /* Every open starts disarmed: nothing is recalculated until the user changes seats,
       price or plan. On an edit the price box opens at the price the saved value implies,
       so changing seats later scales the negotiated value instead of resetting it to list. */
    autoCalcArmed.current = false;
    valueTyped.current = false;
    if (!open) {
      reset();
      setPriceText("");
      setStage("new");
      setSource("manual");
      setPlan("");
      setPriority("medium");
      setEnquiry("subscription");
      setForCustomer(false);
      setCustomerId("");
      // For a fresh "Add lead" the owner defaults to the currently logged-in
      // user — sales reps own their own intake by default. They can re-assign.
      setOwnerId(me?.userId ?? "");
      return;
    }
    if (editingLead) {
      reset({
        company:        editingLead.company,
        contact_name:   editingLead.contact_name  ?? "",
        contact_email:  editingLead.contact_email ?? "",
        contact_phone:  editingLead.contact_phone ?? "",
        gstin:          editingLead.gstin         ?? "",
        state_code:     editingLead.state_code    ?? "",
        enquiry_type:   editingLead.enquiry_type  ?? "subscription",
        requirement:    editingLead.requirement   ?? "",
        project_timeline: editingLead.project_timeline ?? "",
        plan:           editingLead.plan          ?? "",
        seats:          editingLead.seats         ?? undefined,
        value:          editingLead.value         ?? undefined,
        stage:         (editingLead.stage  as FormData["stage"]) ?? "new",
        source:         canonicalSource(editingLead.source) || "manual",
        priority:      (editingLead.priority as LeadPriority) ?? "medium",
        follow_up_date: editingLead.follow_up_date ?? "",
        expected_close_date: editingLead.expected_close_date ?? "",
        owner_id:       editingLead.owner_id      ?? "",
        subscription_type: editingLead.subscription_type ?? "",
        billing_cycle:  editingLead.billing_cycle ?? "",
        current_provider: editingLead.current_provider ?? "",
        notes:          editingLead.notes         ?? "",
      });
      setStage((editingLead.stage as FormData["stage"]) ?? "new");
      setSource(canonicalSource(editingLead.source) || "manual");
      setPlan(editingLead.plan ?? "");
      /* Price per seat on an existing deal: what its saved value implies (value ÷ seats ÷ 12),
         else the plan's list price. Display only — nothing is recalculated on open. */
      {
        const s = editingLead.seats ?? 0;
        const implied = editingLead.value && s > 0 ? Math.round(editingLead.value / s / 12) : undefined;
        const p = implied ?? listPricePerSeat(editingLead.plan ?? "");
        setPriceText(p ? commitMoney(String(p)) : "");
      }
      setPriority((editingLead.priority as LeadPriority) ?? "medium");
      setOwnerId(editingLead.owner_id ?? "");
      setEnquiry(editingLead.enquiry_type ?? "subscription");
      setForCustomer(Boolean(editingLead.customer_id));
      setCustomerId(editingLead.customer_id ?? "");
    } else {
      // New-lead default: owner = current user.
      setOwnerId(me?.userId ?? "");
    }
  }, [open, editingLead, reset, me?.userId]);

  /**
   * ─── MISTAKE-PROOFING ONE REGISTERED FIELD ────────────────────────────────
   * Returns `register()`'s props with the keystroke and blur rules layered on top:
   * `live` cleans on every keystroke and may only ever REMOVE characters, `commit`
   * formats on blur and is the only place a value may gain any. Doing it the other way
   * round — formatting mid-type — moves the caret out from under the operator's finger
   * and is how a "smart" field becomes a worse one. See lib/forms/poka-yoke.ts.
   *
   * `shouldDirty` is passed so a cleaned value still marks the form dirty; without it the
   * unsaved-changes guard would let a paste-and-close lose the paste.
   */
  const smart = (
    field: "contact_email" | "contact_phone" | "gstin",
    rules: { live: (s: string) => string; commit?: (s: string) => string },
  ) => {
    const reg = register(field);
    return {
      ...reg,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        setValue(field, rules.live(e.target.value), { shouldDirty: true, shouldValidate: false });
      },
      onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
        if (rules.commit) {
          const pretty = rules.commit(e.target.value);
          if (pretty !== e.target.value) setValue(field, pretty, { shouldDirty: true });
        }
        return reg.onBlur(e);
      },
    };
  };

  const onSubmit = async (data: FormData) => {
    /* Edit has no steps, so this is the only place its deal rules run. */
    if (!checkDealRules()) return;
    try {
      // Normalize empties → null so the DB row honors "not qualified yet".
      // A raw lead (no plan/seats/value) lives in Inbox; once these get set,
      // it transitions into the Deal Pipeline.
      /* A project enquiry is "qualified" once there is a requirement — it carries a fixed
         plan label so every pipeline view that keys on `plan` treats it the same way. It
         never carries seats or a licence subscription type. */
      const project  = data.enquiry_type === "project";
      const requirementVal = project && data.requirement?.trim() ? data.requirement.trim() : null;
      const planVal  = project ? (requirementVal ? PROJECT_PLAN_LABEL : null) : (data.plan?.trim() ? data.plan : null);
      const seatsVal = !project && (data.seats !== undefined && data.seats !== null && !Number.isNaN(data.seats) && data.seats > 0) ? data.seats : null;
      const valueVal = (data.value !== undefined && data.value !== null && !Number.isNaN(data.value) && data.value > 0) ? data.value : null;

      const sharedPatch = {
        /* `leads.company` DB me NOT NULL hai, aur form ab use optional maanta hai.
           Isliye yahan khaali string — wahi shakl jo inbound raasta pehle se likhta hai
           (inbound-email/route.ts:130), taaki dono taraf se aayi lead ek jaisi dikhe. */
        company:        data.company?.trim() ?? "",
        contact_name:   data.contact_name  || null,
        contact_email:  data.contact_email || null,
        contact_phone:  data.contact_phone || null,
        gstin:          data.gstin?.trim().toUpperCase() || null,
        /* R-376 (a): the place of supply the quote builder prefills from. An edit writes it
           only when the select moved (lib/leads/lead-state.ts). */
        ...leadStatePatch(data.state_code, isEditing ? editingLead : null),
        enquiry_type:   data.enquiry_type,
        requirement:    requirementVal,
        project_timeline: project ? (data.project_timeline?.trim() || null) : null,
        plan:           planVal,
        seats:          seatsVal,
        value:          valueVal,
        stage:          data.stage,
        source:         data.source,
        priority:       data.priority,
        follow_up_date: data.follow_up_date || null,
        expected_close_date: data.expected_close_date || null,
        owner_id:       data.owner_id       || null,
        subscription_type: project ? null : (data.subscription_type || null),
        billing_cycle:  project ? null : toBillingCycle(data.billing_cycle),
        current_provider: project ? null : (data.current_provider?.trim() || null),
        notes:          data.notes          || null,
        customer_id:    forCustomer ? (customerId || null) : null,
      };

      if (isEditing && editingLead) {
        // ─── Update existing lead ───
        await updateLead.mutateAsync({ id: editingLead.id, patch: sharedPatch });
      } else {
        // ─── Create new lead ───
        const id = "L-" + Date.now().toString(36).toUpperCase();
        /* `created_by` goes HERE and deliberately NOT into `sharedPatch`, which is also the
           update payload. In there it would rewrite the creator on every edit — turning the one
           column that remembers who added a lead into a second copy of "who touched it last",
           which is the exact failure it was added to prevent. Written once, at creation, from
           the session rather than from `data`: a creator the user can pick is not a creator. */
        await createLead.mutateAsync({ id, ...sharedPatch, created_by: me?.userId ?? null });
        onOpenChange(false);

        // ─── Contextual toast (replaces the hook's generic "Lead created") ───
        // The split between Leads (raw) and Deals (qualified) confused users:
        // they'd save a lead with a plan picked, then can't find it on /leads.
        // Where it LANDS is decided by stage (Deals = past the quote gate), not by
        // plan/value — else we'd say "Deal" but the raw lead sits in the inbox.
        /* R-208: the button opens THIS lead (not just the page), and on /leads its drawer
           opens by itself — the list's "needs action" order buried a fresh lead under overdue ones. */
        const isDeal = (POST_QUOTE_STAGE_VALUES as readonly string[]).includes(data.stage);
        const name = data.company?.trim() || data.contact_name?.trim() || "New lead";
        revealSavedLead({
          id,
          title: isDeal ? `${name} saved as Deal` : `${name} added to your leads`,
          description: isDeal ? "In your Deal Pipeline" : "Send a quote to move it into the Deal Pipeline",
          isDeal,
          pathname,
          router,
        });
        return;
      }
      onOpenChange(false);
    } catch {
      // Error toast handled in mutation hooks' onError
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Slide-in drawer from the right (Linear / Attio / HubSpot pattern).
          Full-width on phones, ~560px panel on desktop. Form body scrolls
          independently; header + footer stay pinned. */}
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] md:max-w-[600px] p-0 flex flex-col overflow-x-hidden"
      >
        <SheetHeader className="min-w-0">
          <SheetTitle className="break-words">{isEditing ? (dealMode ? "Edit deal" : "Edit lead") : dealMode ? "Add deal" : "Add lead"}</SheetTitle>
          <SheetDescription className="break-words">
            {isEditing
              ? `Update details for ${editingLead?.company}.`
              : defaultStage
                ? "Add an opportunity straight to your Deal Pipeline."
                : "Send a quote to move it into the Deal Pipeline."}
          </SheetDescription>
        </SheetHeader>

        <form
          onSubmit={(e) => {
            /* R-069: only the Review step saves. Enter in a field, or any stray submit
               before it, must not create the lead behind the operator's back. */
            if (useSteps && step < STEP_LABELS.length) {
              e.preventDefault();
              return;
            }
            return handleSubmit(onSubmit)(e);
          }}
          className="flex flex-col flex-1 min-h-0 min-w-0 w-full"
        >
          {/* ── Three steps, and the third one is the point ────────────────────
              Contact → Product & seats → Review. The first two only shorten what is
              on screen at once; the REVIEW step is what makes this poka-yoke rather
              than decoration, because it shows the operator exactly what is about to
              be written before it is written.

              Editing skips the steps entirely. Somebody who opened this sheet to
              correct one phone number should not be walked through a wizard to reach
              it — see `steps` below. */}
          {useSteps && (
            <nav aria-label="Progress" className="flex items-center gap-1 border-b border-hairline px-5 py-2.5">
              {STEP_LABELS.map((label, i) => {
                const n = i + 1;
                const done = n < step;
                return (
                  <React.Fragment key={label}>
                    <button
                      type="button"
                      /* A completed step is clickable, an unreached one is not — going
                         back to fix something must never cost the operator their place,
                         and jumping forward past a required field just fails there. */
                      disabled={n > step}
                      onClick={() => setStep(n)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] transition-colors",
                        n === step ? "bg-amber-soft font-semibold text-amber-ink"
                          : done    ? "text-ink-2 hover:bg-paper-2"
                          : "text-ink-3",
                      )}
                      aria-current={n === step ? "step" : undefined}
                    >
                      {done && <span aria-hidden="true">✓</span>}
                      <span>{label}</span>
                    </button>
                    {n < STEP_LABELS.length && <span aria-hidden="true" className="text-ink-3">›</span>}
                  </React.Fragment>
                );
              })}
            </nav>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {/* ── Paste the WhatsApp message instead of retyping it ──────────────
              Offered on a NEW lead only. On an edit it would overwrite fields the
              operator opened this sheet to correct, which is the opposite of help.

              It fills only what the extractor actually FOUND, and it shows the whole
              list before filling anything — see components/shared/smart-paste.tsx. */}
          {!isEditing && (
            <SmartPaste
              catalogue={PLANS.map((p) => ({ id: p, name: p }))}
              onFill={(v) => {
                if (v.name)  setValue("contact_name",  v.name,  { shouldDirty: true });
                if (v.email) setValue("contact_email", liveEmail(v.email), { shouldDirty: true });
                if (v.phone) setValue("contact_phone", commitPhone(v.phone), { shouldDirty: true });
                /* A paste is the user's own input — it arms seats × price like typing does. */
                if (v.seats || v.product) armAutoCalc();
                if (v.seats) setValue("seats",         v.seats, { shouldDirty: true });
                if (v.product) {
                  setPlan(v.product.name);
                  setValue("plan", v.product.name, { shouldDirty: true });
                  const list = listPricePerSeat(v.product.name);
                  setPriceText(list ? commitMoney(String(list)) : "");
                }
                toast.success("Filled from the pasted text.", {
                  description: "Check each field before saving — anything it could not read is still blank.",
                });
              }}
            />
          )}

          <Step show={!useSteps || step === 1}>

          <div className="flex gap-2" role="group" aria-label="Lead type">
            {[{ v: false, label: "New business" }, { v: true, label: "Existing customer" }].map((o) => (
              <button key={o.label} type="button" onClick={() => { setForCustomer(o.v); if (!o.v) setCustomerId(""); }}
                aria-pressed={forCustomer === o.v}
                className={cn("rounded-full border px-3 py-1 text-xs",
                  forCustomer === o.v ? "border-amber bg-amber-soft/40 text-ink font-medium" : "border-hairline text-ink-2 hover:border-amber/60")}>
                {o.label}
              </button>
            ))}
          </div>
          {forCustomer && (
            <FormField label="Customer" htmlFor="lead-customer">
              <CustomerCombobox id="lead-customer" value={customerId} placeholder="Search customers…"
                onChange={(id) => {
                  setCustomerId(id);
                  const c = (customerList ?? []).find((x) => x.id === id);
                  if (!c) return;
                  const person = [c.contact_first_name, c.contact_last_name].filter(Boolean).join(" ") || c.contact_name || "";
                  setValue("company", c.display_name || c.name, { shouldDirty: true });
                  if (person) setValue("contact_name", person, { shouldDirty: true });
                  if (c.contact_email) setValue("contact_email", c.contact_email, { shouldDirty: true });
                  const phone = c.contact_mobile || c.contact_phone;
                  if (phone) setValue("contact_phone", commitPhone(phone), { shouldDirty: true });
                  if (c.gstin) setValue("gstin", c.gstin, { shouldDirty: true });
                }} />
              <p className="mt-1 text-xs text-ink-3">Upsell, zyada seats ya naya project — customer ki details khud bhar jaati hain, badal bhi sakte ho.</p>
            </FormField>
          )}

          {/* Company name — ab MARZI se. Contact zaroori hai, wajah schema par likhi hai.
              `autoFocus` bhi contact par chala gaya: cursor us khaane me khulna chahiye jise
              bharna hi hai. */}
          <FormField label="Company name" htmlFor="company">
            <Input
              id="company"
              placeholder="e.g. Acme Corp Pvt Ltd (optional)"
              error={errors.company?.message}
              {...register("company")}
            />
          </FormField>

          {/* Duplicate heads-up — an existing lead already matches this
              company / phone. Non-blocking: offer to open it instead. */}
          {!isEditing && dupMatch && (
            <div className="rounded-md bg-amber-soft/60 border border-amber/30 px-3 py-2.5 flex items-start gap-2 min-w-0">
              <Icon name="copy" size={14} className="text-amber-ink flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 text-xs text-amber-ink leading-snug">
                <b>{duplicateWarning(dupMatch).title}</b>
                {" · "}{duplicateWarning(dupMatch).matched}.
                Naya banane ke bajaye usi ko kholein? (Save phir bhi ho sakta hai.)
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    /* Won leads live on /deals only (page-scope.ts). */
                    const page = stageShownOnPage(dupMatch.stage as Lead["stage"], false) ? "/leads" : "/deals";
                    router.push(`${page}?lead=${dupMatch.id}` as Route);
                  }}
                  className="ml-1.5 font-semibold underline underline-offset-2 hover:text-amber"
                >
                  Open existing lead
                </button>
              </div>
            </div>
          )}

          {/* Pick from phone contacts — Android PWA only.
              Tap → native contact picker opens → name/phone/email auto-fill.
              Hidden on iOS Safari + desktop (Contacts Picker API not supported).
              Mobile layout: text on top, button full-width below (more thumb-friendly).
              Desktop: text left, button right. */}
          {contactsApiAvailable && (
            <div className="rounded-md bg-indigo-50 border border-indigo/20 px-3 py-2.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 min-w-0">
              <p className="text-xs text-indigo-ink inline-flex items-start gap-2 min-w-0 leading-snug">
                <Icon name="mobile" size={13} className="flex-shrink-0 mt-0.5" />
                <span>On your phone? Add from contacts.</span>
              </p>
              <Button
                type="button"
                variant="default"
                size="sm"
                icon="user"
                onClick={pickContact}
                className="sm:shrink-0 w-full sm:w-auto justify-center"
              >
                Pick from contacts
              </Button>
            </div>
          )}

          {/* Contact info — 3 fields in grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <FormField label="Contact name" required htmlFor="contact_name">
              <Input
                id="contact_name"
                autoFocus
                placeholder="e.g. Rajesh K"
                error={errors.contact_name?.message}
                {...register("contact_name")}
              />
            </FormField>
            <FormField label="Email" htmlFor="contact_email">
              <Input
                id="contact_email"
                type="email"
                placeholder="e.g. rajesh@acme.com"
                error={errors.contact_email?.message}
                {...smart("contact_email", { live: liveEmail })}
              />
              <FieldPill check={checkEmail(watch("contact_email") ?? "")} />
            </FormField>
            <FormField label="Phone" htmlFor="contact_phone">
              <Input
                id="contact_phone"
                inputMode="numeric"
                placeholder="e.g. +91 98765 43210"
                {...smart("contact_phone", { live: livePhone, commit: commitPhone })}
              />
              {/* Catches the ten-digit landline, which looks perfect right up until
                  somebody tries to WhatsApp it. */}
              <FieldPill check={checkPhone(watch("contact_phone") ?? "")} />
            </FormField>
          </div>

          {/* GSTIN — optional. When set, the existing Sandbox.co.in verifier
              auto-fills legal name + registered address on conversion. */}
          <FormField label="GSTIN" htmlFor="gstin">
            {/* Upper-cases and strips the spaces a PDF or WhatsApp paste brings, on every
                keystroke. The `uppercase` class alone only changed how it LOOKED — the
                stored value stayed lower-case, and a lower-case GSTIN fails the checksum
                that decides the tax head. */}
            <Input
              id="gstin"
              className="font-mono"
              placeholder="e.g. 27AABCE1234D1Z9"
              error={errors.gstin?.message}
              {...smart("gstin", { live: liveGstin })}
            />
            {/* One shared, tested rule instead of the four hand-written branches that used
                to live here — and it now names the STATE, which is the fact about to
                decide IGST vs CGST+SGST. An operator who sees "Delhi" where they expected
                Haryana has caught a wrong paste before it became a tax head. */}
            <FieldPill check={checkGstin(watch("gstin") ?? "")} />
            {!(watch("gstin") ?? "").trim() && (
              <p className="text-xs text-ink-3">
                Optional. Helps auto-fill legal name + address on conversion.
              </p>
            )}
          </FormField>

          {/* R-376 (a): State = place of supply. GST is CGST + SGST in the seller's own
              state and IGST outside it, so the quote builder prefills from this. Same list
              and codes as the quote builder's Place of supply. */}
          <FormField label="State" htmlFor="state_code">
            <select
              id="state_code"
              {...register("state_code")}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              <option value="">Select state (for GST)</option>
              {GST_STATE_OPTIONS.map((s) => (
                <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
              ))}
            </select>
            <p className="text-xs text-ink-3">
              {gstinStateCode && watch("state_code") === gstinStateCode
                ? "Filled from the GSTIN."
                : "Optional. Decides IGST or CGST + SGST on the quote."}
            </p>
          </FormField>

          </Step>

          <Step show={!useSteps || step === 2}>

          {/* What the enquiry is FOR decides every field below it. */}
          <FormField label="Enquiry type" htmlFor="enquiry_type">
            <div id="enquiry_type" role="radiogroup" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ENQUIRY_TYPES.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={enquiry === t.value}
                  onClick={() => {
                    setEnquiry(t.value);
                    setValue("enquiry_type", t.value, { shouldDirty: true });
                  }}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left transition-colors",
                    enquiry === t.value ? "border-amber bg-amber-soft/40" : "border-hairline hover:bg-paper-2",
                  )}
                >
                  <div className="text-sm font-medium text-ink">{t.label}</div>
                  <div className="text-xs text-ink-3">{t.hint}</div>
                </button>
              ))}
            </div>
            <input type="hidden" {...register("enquiry_type")} value={enquiry} />
          </FormField>

          {isProject ? (
            <>
              <FormField label="Requirement" htmlFor="requirement">
                <textarea
                  id="requirement"
                  rows={3}
                  placeholder="e.g. School ERP — fees, attendance, parent app"
                  className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
                  {...register("requirement")}
                />
                <p className="text-xs text-ink-3 mt-1">
                  {(watch("requirement") ?? "").trim()
                    ? "Goes to the Deal Pipeline as a qualified project."
                    : "Leave blank to keep it in the Lead Inbox."}
                </p>
              </FormField>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <FormField label="Budget (₹, before GST)" htmlFor="value">
                  <Input
                    id="value"
                    type="text"
                    inputMode="numeric"
                    prefix="₹"
                    error={errors.value?.message}
                    value={valueText}
                    onChange={(e) => {
                      const next = liveMoney(e.target.value);
                      setValueText(next);
                      setValue("value", parseMoney(next) ?? undefined, { shouldDirty: true });
                    }}
                    onBlur={() => setValueText((t) => commitMoney(t))}
                  />
                  <FieldPill check={checkMoney(valueText)} />
                  {(parseMoney(valueText) ?? 0) > 0 && (
                    <p className="mt-1 text-xs text-ink-3">= <b className="text-ink">{amountInIndianWords(parseMoney(valueText) ?? 0)}</b></p>
                  )}
                </FormField>
                <FormField label="Timeline" htmlFor="project_timeline">
                  <Input id="project_timeline" placeholder="e.g. 3 months, before Diwali" {...register("project_timeline")} />
                </FormField>
              </div>
            </>
          ) : (
          <>
          {/* Plan. On /leads it may stay empty (a raw lead in the Inbox). Once the stage is
              past New / Contacted — always, on "Add Deal" — a plan is required (Custom /
              Mixed counts): a deal with no product cannot be quoted or forecast. */}
          <FormField label="Interested plan" required={dealDetailsRequired} htmlFor="plan">
            <Select
              value={plan}
              onValueChange={(v) => {
                armAutoCalc();
                setPlan(v);
                (register("plan") as any).onChange({ target: { value: v, name: "plan" } });
                /* The plan's current list price, as a starting point the rep can change. */
                const list = listPricePerSeat(v);
                setPriceText(list ? commitMoney(String(list)) : "");
              }}
            >
              <SelectTrigger id="plan" error={!!errors.plan}>
                <SelectValue placeholder={dealMode ? "Pick a plan (required)" : "Not sure yet? Leave blank"} />
              </SelectTrigger>
              <SelectContent>
                {PLANS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <input type="hidden" {...register("plan")} value={plan} />
            {errors.plan?.message ? (
              <p className="text-xs text-rose mt-1">{errors.plan.message}</p>
            ) : (
              <p className="text-xs text-ink-3 mt-1">
                {dealDetailsRequired
                  ? "Plan is required — use Custom / Mixed for a mix."
                  : plan
                    ? "Moves to Deals once a quote is sent."
                    : "Leave blank to keep it in the Lead Inbox."}
              </p>
            )}
          </FormField>

          {/* Seats × price per seat → deal value. Price is prefilled from the plan's list
              price and is editable (the real price is negotiated). The value follows seats ×
              price × 12 until the rep types a value of their own. */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Seats" htmlFor="seats">
              {(() => {
                const reg = register("seats", { valueAsNumber: true, setValueAs: (v) => v === "" || v === null ? undefined : Number(v) });
                return (
                  <Input
                    id="seats"
                    type="number"
                    min={0}
                    placeholder="—"
                    error={errors.seats?.message}
                    {...reg}
                    onChange={(e) => { armAutoCalc(); return reg.onChange(e); }}
                  />
                );
              })()}
            </FormField>
            <FormField label="Price per seat (₹/month)" htmlFor="price_per_seat">
              <Input
                id="price_per_seat"
                type="text"
                inputMode="numeric"
                prefix="₹"
                placeholder="—"
                value={priceText}
                onChange={(e) => { armAutoCalc(); setPriceText(liveMoney(e.target.value)); }}
                onBlur={() => setPriceText((t) => commitMoney(t))}
              />
              {listPricePerSeat(plan) !== undefined && pricePerSeat !== listPricePerSeat(plan) && (
                <p className="mt-1 text-xs text-ink-3">
                  List price ₹{listPricePerSeat(plan)!.toLocaleString("en-IN")}
                </p>
              )}
            </FormField>
          </div>
          {/* "(whole rupees)" said in the label, not left to be discovered. This app
              stores money as integers (CLAUDE.md §13) and a field that quietly rounds
              1500.50 has decided something about somebody's money without telling them
              — checkMoney reports that instead. */}
          <FormField label="Deal value (₹/year — whole rupees)" required={stage === "won"} htmlFor="value">
            <Input
              id="value"
              type="text"
              inputMode="numeric"
              prefix="₹"
              error={errors.value?.message}
              /* The BOX holds a display string ("1,76,640"); the FORM holds a number.
                 Keeping them apart is what lets the field group digits the Indian way
                 without the grouping breaking its own validation — and it keeps the
                 registered field typed as the number it actually is, with no cast. */
              value={valueText}
              onChange={(e) => {
                const next = liveMoney(e.target.value);
                /* A typed value is the rep's own and stops the auto-calc; clearing the box
                   hands it back to seats × price. */
                valueTyped.current = next.trim() !== "";
                setValueText(next);
                setValue("value", parseMoney(next) ?? undefined, { shouldDirty: true });
              }}
              onBlur={() => setValueText((t) => commitMoney(t))}
            />
            <FieldPill check={checkMoney(valueText)} />
            {(parseMoney(valueText) ?? 0) > 0 && (
              <p className="mt-1 text-xs text-ink-3">= <b className="text-ink">{amountInIndianWords(parseMoney(valueText) ?? 0)}</b></p>
            )}
            {/* The sum the auto-calc uses, shown so the rep can see where the number came from. */}
            {(pricePerSeat ?? 0) > 0 && (watchedSeats ?? 0) >= 1 && (
              <p className="mt-1 text-xs text-ink-3">
                ₹{(pricePerSeat ?? 0).toLocaleString("en-IN")}/seat/mo
                {" × "}{watchedSeats} seats × 12 mo
                {" = "}
                <span className="font-semibold text-ink">
                  ₹{Math.round((pricePerSeat ?? 0) * (watchedSeats ?? 0) * 12).toLocaleString("en-IN")}
                </span>
              </p>
            )}
            {plan === "Custom / Mixed" && (
              <p className="mt-1 text-xs text-ink-3">Enter the negotiated deal value</p>
            )}
            {/* R-071: the value stays yearly on a monthly deal; one month's bill is shown. */}
            {watch("billing_cycle") === "monthly" && monthlyBill(parseMoney(valueText)) !== null && (
              <p className="mt-1 text-xs text-ink-3">
                Monthly billing: ≈ <b className="text-ink">₹{monthlyBill(parseMoney(valueText))!.toLocaleString("en-IN")}/month</b> (deal value is per year)
              </p>
            )}
          </FormField>
          </>
          )}

          {/* Stage + Source + Priority — 3 status fields together */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <FormField label="Stage" required htmlFor="stage">
              <Select
                value={stage}
                onValueChange={(v) => {
                  setStage(v as FormData["stage"]);
                  (register("stage") as any).onChange({ target: { value: v, name: "stage" } });
                }}
              >
                <SelectTrigger id="stage">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {availableStages.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("stage")} value={stage} />
              {/* What actually unlocks the deal stages is SENDING A QUOTE (quote-first gate,
                  lib/leads/stage-options.ts) — not picking a plan, as this line used to say. */}
              <p className="mt-1 text-xs text-ink-3 leading-snug">
                {dealMode
                  ? "Quote Sent onward needs plan, company and expected close. Won also needs value."
                  : "Send a quote to move it to Deals."}
              </p>
            </FormField>
            <FormField label="Source" htmlFor="source">
              <Select
                value={source}
                onValueChange={(v) => {
                  setSource(v);
                  (register("source") as any).onChange({ target: { value: v, name: "source" } });
                }}
              >
                <SelectTrigger id="source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions(source).map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("source")} value={source} />
            </FormField>
            <FormField label="Priority" htmlFor="priority">
              <Select
                value={priority}
                onValueChange={(v) => {
                  setPriority(v as LeadPriority);
                  (register("priority") as any).onChange({ target: { value: v, name: "priority" } });
                }}
              >
                <SelectTrigger id="priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      <span className="inline-flex items-center gap-2">
                        <span className={cn("inline-block w-2 h-2 rounded-full", p.dot)} />
                        {p.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("priority")} value={priority} />
            </FormField>
          </div>

          {/* New vs switching — is the prospect already subscribed elsewhere? A licence
              question only; a custom-software project has nothing to switch from. */}
          {!isProject && (
          <FormField label="New or switching?" htmlFor="subscription_type">
            <select
              id="subscription_type"
              {...register("subscription_type")}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
            >
              <option value="">Not sure yet</option>
              <option value="fresh">Fresh subscription (new)</option>
              <option value="switch">Switching vendor (already subscribed elsewhere)</option>
            </select>
            <p className="mt-1 text-xs text-ink-3 leading-snug">
              &ldquo;Switching&rdquo; = they already use this product, just moving billing/reseller to you (migration).
            </p>
          </FormField>
          )}

          {/* R-071: billing cycle + current provider (leads.billing_cycle / current_provider).
              Licence questions only, like the one above. */}
          {!isProject && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <FormField label="Billing cycle" htmlFor="billing_cycle">
              <select
                id="billing_cycle"
                {...register("billing_cycle")}
                className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
              >
                <option value="">Not sure yet</option>
                {BILLING_CYCLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </FormField>
            <FormField label="Current provider" htmlFor="current_provider">
              <Input
                id="current_provider"
                placeholder="e.g. Direct Google, another reseller"
                error={errors.current_provider?.message}
                {...register("current_provider")}
              />
            </FormField>
          </div>
          )}

          {/* Expected close — `leads.expected_close_date` (Deals audit, 30 Sep 2026: the column
              existed and nothing wrote it, so "Closing this month" and the forecast were
              empty). Required from Quote onward; not in the past (IST). An edit may keep an
              already-saved past date — lib/leads/deal-rules.ts#dealFormErrors. */}
          <FormField label="Expected close" required={dealDetailsRequired} htmlFor="expected_close_date">
            <Input
              id="expected_close_date"
              type="date"
              min={isEditing && (editingLead?.expected_close_date ?? "") < istToday() ? undefined : istToday()}
              error={errors.expected_close_date?.message}
              {...register("expected_close_date")}
            />
            <p className="mt-1 text-xs text-ink-3">
              Used by the forecast and &ldquo;Closing this month&rdquo;.
            </p>
          </FormField>

          {/* Follow-up date + Owner — sales workflow row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <FormField label="Next follow-up" htmlFor="follow_up_date">
              <Input
                id="follow_up_date"
                type="date"
                min={istToday()}
                {...register("follow_up_date")}
              />
              <p className="mt-1 text-xs text-ink-3">
                Drives your daily worklist · reminder ping the morning of.
              </p>
            </FormField>
            <FormField label="Owner" htmlFor="owner_id">
              <Select
                value={ownerId || "__unassigned"}
                onValueChange={(v) => {
                  const nextId = v === "__unassigned" ? "" : v;
                  setOwnerId(nextId);
                  (register("owner_id") as any).onChange({ target: { value: nextId, name: "owner_id" } });
                }}
              >
                <SelectTrigger id="owner_id">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassigned">Unassigned</SelectItem>
                  {(tenantUsers ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.full_name || u.email}
                      {u.id === me?.userId ? " (you)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("owner_id")} value={ownerId} />
            </FormField>
          </div>

          {/* Notes — multi-line textarea so sales reps can capture call
              transcripts, decision-maker context, budget cycles, etc. */}
          <FormField label="Notes" htmlFor="notes">
            <textarea
              id="notes"
              rows={4}
              placeholder="Decision maker, timeline, budget, objections, next-step plan…"
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-amber resize-y"
              {...register("notes")}
            />
          </FormField>

          </Step>

          {/* ── Step 3: what is about to be saved ─────────────────────────────
              Read-only, and that is the whole value. A form's last screen is the only
              place an operator sees every field at once without having to scroll past
              the ones they already filled — which is where a wrong seat count or a
              landline in the phone box actually gets caught. */}
          <Step show={useSteps && step === 3}>
            <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                About to be saved
              </p>
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Review label="Company"     value={watch("company")} />
                <Review label="Contact"     value={watch("contact_name")} />
                <Review label="Email"       value={watch("contact_email")} />
                <Review label="Phone"       value={watch("contact_phone")} />
                <Review label="GSTIN"       value={watch("gstin")} mono
                        note={gstinState(watch("gstin") ?? "")?.name} />
                <Review label="State"       value={stateLabel(watch("state_code"))} />
                <Review label="Enquiry"     value={ENQUIRY_TYPES.find((t) => t.value === enquiry)?.label} />
                {isProject ? (
                  <>
                    <Review label="Requirement" value={watch("requirement")} />
                    <Review label="Budget (pre-GST)" value={valueText ? `₹${valueText}` : ""} />
                    <Review label="Timeline"    value={watch("project_timeline")} />
                  </>
                ) : (
                  <>
                    <Review label="Plan"        value={plan} />
                    <Review label="Seats"       value={watchedSeats == null || Number.isNaN(watchedSeats) ? "" : String(watchedSeats)} />
                    <Review label="Price / seat" value={priceText ? `₹${priceText}/month` : ""} />
                    <Review label="Deal value"  value={valueText ? `₹${valueText}/year` : ""} />
                    <Review label="Billing"     value={billingCycleLabel(watch("billing_cycle"))} />
                    <Review label="Current provider" value={watch("current_provider")} />
                  </>
                )}
                <Review label="Stage"       value={STAGES.find((s) => s.value === stage)?.label} />
                <Review label="Expected close" value={watch("expected_close_date") ? formatIstDate(watch("expected_close_date") ?? "") : ""} />
                <Review label="Priority"    value={PRIORITY_OPTIONS.find((p) => p.value === priority)?.label} />
              </dl>
              {/* Blanks are stated, not shown as gaps — a blank row reads as a
                  rendering fault and an operator cannot tell it apart from a value
                  that failed to load. See the same rule on the enquiry panel. */}
              <p className="mt-2.5 border-t border-hairline pt-2 text-xs leading-snug text-ink-3">
                Anything marked “not set” will be saved empty. Go back to any step above to
                fill it — nothing is lost.
              </p>
            </div>
          </Step>

          </div>  {/* close scrollable form body */}

          <SheetFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => (useSteps && step > 1 ? setStep(step - 1) : onOpenChange(false))}
            >
              {useSteps && step > 1 ? "Back" : "Cancel"}
            </Button>

            {/* R-069: distinct keys are load-bearing. Without them React reuses ONE <button>
                and only flips its type; Next's setStep(3) commits in the microtask right
                after the click listener, so the browser then "activates" a type="submit"
                button and the lead was created on step 2 — Review never showed. */}
            {useSteps && step < STEP_LABELS.length ? (
              <Button
                key="step-next"
                type="button"
                variant="primary"
                onClick={async () => {
                  /* Validates ONLY this step's fields. Running the whole schema here
                     would red-flag a field two steps ahead that nobody has reached
                     yet, which is the same "shouting at an untouched field" the pills
                     were built to stop. */
                  const ok = await trigger(step === 1 ? STEP_FIELDS[0] : STEP_FIELDS[1]);
                  /* Step 2 also runs the deal rules (plan / company / close date / Won value). */
                  if (ok && (step !== 2 || checkDealRules())) setStep(step + 1);
                }}
              >
                Next
              </Button>
            ) : (
              <Button
                key="step-save"
                type="submit"
                variant="primary"
                loading={isSubmitting || createLead.isPending || updateLead.isPending}
              >
                {isEditing ? "Save changes" : dealMode ? "Save deal" : "Save lead"}
              </Button>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
