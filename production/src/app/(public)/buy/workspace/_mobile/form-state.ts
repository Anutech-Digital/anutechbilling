/**
 * R-2021 (R-2019b, Pardeep 27 Oct 2026): the phone checkout's rules, as pure functions — what the
 * Domain and Details steps need before Continue, the GSTIN check (format + checksum, the same
 * check the server and the desktop use), the body sent to /api/public/checkout/workspace, and the
 * copy kept on THIS phone (localStorage) so a refresh or an interruption loses nothing.
 *
 * Nothing here prices anything: the body carries only choices; the server reads every rate.
 */
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { gstinProblem } from "@/site/lib/checkout-details";
import { DOMAIN_RE, EMPTY_DOMAIN, cleanDomain, type DomainChoice } from "../_parts/checkout-form";
import type { BuyPlan, Billing } from "../_parts/plans";
import type { DomainMode, MigrationSource } from "@/app/api/public/checkout/workspace/buy-intent";
import type { Intent } from "./url-state";

export type { DomainMode, MigrationSource };

export interface MobileForm {
  domainMode: DomainMode;
  /** have / google: the domain they own. */
  domain: string;
  /** new: the live search's choice (R-1977) — name, ending and the picked result. */
  newDomain: DomainChoice;
  migrationSource: MigrationSource;
  name: string;
  /** 10 digits after +91. */
  phone: string;
  email: string;
  /** "Will your business claim the GST back?" — null until answered. */
  needGst: boolean | null;
  gstin: string;
  company: string;
  /** Place of supply when there is no GSTIN (R-173 — the invoice needs it). */
  stateCode: string;
  /** R-1977: the new domain's owner address. */
  addressLine1: string;
  city: string;
  pinCode: string;
}

export const EMPTY_FORM: MobileForm = {
  domainMode: "have", domain: "", newDomain: { ...EMPTY_DOMAIN, mode: "new" }, migrationSource: "none",
  name: "", phone: "", email: "", needGst: null, gstin: "", company: "", stateCode: "",
  addressLine1: "", city: "", pinCode: "",
};

/** The domain choices for an intent (R-2019 decision 6): a switch has its domain on Google already. */
export function domainModesFor(intent: Intent | null): DomainMode[] {
  return intent === "transfer" ? ["google"] : ["have", "new", "later"];
}

/** The mode to use for this intent — the saved one when it fits, else the first offered. */
export function fitMode(form: MobileForm, intent: Intent | null): DomainMode {
  const modes = domainModesFor(intent);
  return modes.includes(form.domainMode) ? form.domainMode : modes[0];
}

/** Only the digits of an Indian mobile: +91 / 0 in front dropped, at most 10 kept. */
export function mobileDigits(v: string): string {
  let d = v.replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("91")) d = d.slice(2);
  if (d.length > 10 && d.startsWith("0")) d = d.slice(1);
  return d.slice(0, 10);
}

/** GSTIN as typed → upper case, no spaces, at most 15 characters. */
export function cleanGstinInput(v: string): string {
  return v.replace(/\s+/g, "").toUpperCase().slice(0, 15);
}

/** The domain the order is for, by mode ("" for Decide later or an unpicked new domain). */
export function orderDomain(form: MobileForm, intent: Intent | null): string {
  const mode = fitMode(form, intent);
  if (mode === "later") return "";
  if (mode === "new") return form.newDomain.picked?.domain ?? "";
  return cleanDomain(form.domain);
}

export type DomainErr = { domain?: string; newName?: string };

export function domainStepErrors(form: MobileForm, intent: Intent | null): DomainErr {
  const mode = fitMode(form, intent);
  if (mode === "later") return {};
  if (mode === "new") {
    const n = form.newDomain;
    if (n.newName.trim().replace(/[^a-z0-9-]/gi, "").length < 2) return { newName: "Type the name you'd like, then press Check" };
    if (!n.picked) return { newName: "Press Check, then choose an available domain" };
    return {};
  }
  const d = cleanDomain(form.domain);
  if (!d) return { domain: mode === "google" ? "Type the domain that is on Google Workspace now" : "Type your domain, or choose 'Decide later' above" };
  if (!DOMAIN_RE.test(d)) return { domain: "That doesn't look right. Try acme.in or acme.com" };
  return {};
}

export type DetailsField = "name" | "phone" | "email" | "needGst" | "gstin" | "company" | "stateCode" | "addressLine1" | "city" | "pinCode";
export type DetailsErr = Partial<Record<DetailsField, string>>;

/** GSTIN rule (R-227): 15 characters and a valid checksum — "" means fine. */
export function gstinError(gstin: string): string {
  const g = cleanGstinInput(gstin);
  if (!g) return "Please add your 15-character GSTIN";
  if (g.length < 15) return `${15 - g.length} more character${15 - g.length === 1 ? "" : "s"} — a GSTIN has 15`;
  return gstinProblem(g) ?? "";
}

/** The buyer's place of supply: the valid GSTIN's state, else the chosen state. */
export function buyerState(form: MobileForm): string | null {
  if (form.needGst && !gstinError(form.gstin)) return stateCodeFromGstin(cleanGstinInput(form.gstin)) ?? null;
  return form.stateCode || null;
}

export function detailsErrors(form: MobileForm, needAddress: boolean): DetailsErr {
  const e: DetailsErr = {};
  if (form.name.trim().length < 2) e.name = "Please add your name";
  if (mobileDigits(form.phone).length !== 10 || !/^[6-9]/.test(mobileDigits(form.phone))) e.phone = "Please enter a 10-digit mobile number";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = "Please check this email address";
  if (form.needGst === null) e.needGst = "Please choose Yes or No";
  if (form.needGst) {
    const g = gstinError(form.gstin);
    if (g) e.gstin = g;
    if (form.company.trim().length < 2) e.company = "Please add the business name on your GST certificate";
  } else if (form.company.trim().length === 1) {
    e.company = "Business name — or leave it blank";
  }
  /* with a GSTIN its first two digits are the state; without one the buyer picks it */
  if (form.needGst === false && !form.stateCode) e.stateCode = "Please choose your state — it decides the GST on your invoice";
  if (needAddress) {
    if (form.addressLine1.trim().length < 3) e.addressLine1 = "Please add your address — the domain is registered to it";
    if (form.city.trim().length < 2) e.city = "Please add your city";
    if (!/^\d{6}$/.test(form.pinCode.replace(/\s+/g, ""))) e.pinCode = "Please add your 6-digit PIN code";
  }
  return e;
}

const SUMMARY: Record<DetailsField, string> = {
  name: "your name", phone: "a 10-digit mobile", email: "an email", needGst: "the GST question", gstin: "a valid GSTIN",
  company: "business name", stateCode: "your state", addressLine1: "your address", city: "your city", pinCode: "a PIN code",
};

/** The one line on top after Continue: "Please add your name, a 10-digit mobile and an email." */
export function errorSummary(e: DetailsErr): string {
  const items = (Object.keys(SUMMARY) as DetailsField[]).filter((k) => e[k]).map((k) => SUMMARY[k]);
  if (!items.length) return "";
  const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `Please add ${list}.`;
}

/** The new domain needs the owner's address (R-1977): asked on Details only then. */
export function needsAddress(form: MobileForm, intent: Intent | null): boolean {
  return fitMode(form, intent) === "new";
}

/** The first checkout step that is not complete — a refresh on Review never shows a half order. */
export function firstIncompleteStep(form: MobileForm, intent: Intent | null): "domain" | "details" | null {
  if (!intent) return "domain";
  if (Object.keys(domainStepErrors(form, intent)).length) return "domain";
  if (Object.keys(detailsErrors(form, needsAddress(form, intent))).length) return "details";
  return null;
}

/** What the checkout route gets (the desktop's field names). Only choices — no price, ever. */
export function mobileCheckoutBody(o: {
  plan: BuyPlan; seats: number; billing: Billing; intent: Intent; form: MobileForm; couponCode: string | null; simulate: boolean;
}) {
  const { form } = o;
  const mode = fitMode(form, o.intent);
  const name = form.name.trim();
  const gstin = form.needGst ? cleanGstinInput(form.gstin) : "";
  return {
    fullName: name,
    companyName: form.company.trim() || name,
    email: form.email.trim(),
    phone: `+91${mobileDigits(form.phone)}`,
    seats: o.seats,
    domain: orderDomain(form, o.intent),
    domainNew: mode === "new" || undefined,
    tierId: o.plan.id,
    gstin: gstin || undefined,
    stateCode: buyerState(form) ?? undefined,
    couponCode: o.couponCode ?? undefined,
    simulate: o.simulate,
    commitment: o.billing,
    agreeTerms: true,
    intent: o.intent,
    domainMode: mode,
    migrationSource: mode === "have" || mode === "later" ? form.migrationSource : undefined,
    ...(mode === "new" ? { addressLine1: form.addressLine1.trim(), city: form.city.trim(), pinCode: form.pinCode.replace(/\s+/g, "") } : {}),
  };
}

// ── This phone's own copy (R-2019 decision 5: without the WhatsApp tick, nothing leaves the phone) ──
export const FORM_KEY = "buyWs.mobile.form.v1";
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function store(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function loadForm(now = Date.now()): MobileForm {
  try {
    const raw = store()?.getItem(FORM_KEY);
    if (!raw) return EMPTY_FORM;
    const j = JSON.parse(raw) as { at?: number; form?: Partial<MobileForm> };
    if (!j || typeof j.at !== "number" || now - j.at > KEEP_MS || !j.form) { store()?.removeItem(FORM_KEY); return EMPTY_FORM; }
    const f = { ...EMPTY_FORM, ...j.form };
    const nd = { ...EMPTY_FORM.newDomain, ...(j.form.newDomain ?? {}), mode: "new" as const };
    return { ...f, newDomain: nd };
  } catch {
    return EMPTY_FORM;
  }
}

export function saveForm(form: MobileForm, now = Date.now()): void {
  try { store()?.setItem(FORM_KEY, JSON.stringify({ at: now, form })); } catch { /* private mode: the URL still keeps the step */ }
}

export function clearForm(): void {
  try { store()?.removeItem(FORM_KEY); } catch { /* nothing kept */ }
}
