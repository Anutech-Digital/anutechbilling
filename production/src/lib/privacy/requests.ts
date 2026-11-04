/**
 * R-2013 (2 Nov 2026, goal G-DPDP) — data-rights requests, the parts both sides share.
 *
 * A person asks the company (public form /privacy/request) to see, correct or delete their
 * data, to withdraw consent, or to nominate someone. They confirm the email with a 6-digit
 * code; the owner/manager then handles it in Settings → Privacy requests before `due_by`.
 *
 * Response period: 30 days from the confirmed request. Our privacy policy already promises
 * "we respond inside thirty days" (site/lib/data/misc.ts → "Your rights"), and the database
 * sets due_by the same way (migration 20261101215539, privacy_request_verify).
 */
import { z } from "zod";

export const DPDP_RESPONSE_DAYS = 30;
export const PRIVACY_CODE_TTL_MIN = 15;
export const PRIVACY_CODE_TRIES = 5;

export const PRIVACY_REQUEST_KINDS = [
  { id: "access", label: "See my data", hint: "A copy of what you hold about me" },
  { id: "correction", label: "Correct my data", hint: "Something you hold about me is wrong" },
  { id: "erasure", label: "Delete my data", hint: "Remove my personal data (tax invoices are kept as the law requires)" },
  { id: "withdraw_consent", label: "Withdraw my consent", hint: "Stop offers, greetings and follow-ups to me" },
  { id: "nominate", label: "Nominate someone", hint: "Someone who can use these rights for me" },
] as const;

export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number]["id"];
export const PRIVACY_KIND_IDS = PRIVACY_REQUEST_KINDS.map((k) => k.id) as [PrivacyRequestKind, ...PrivacyRequestKind[]];

export function kindLabel(kind: string): string {
  return PRIVACY_REQUEST_KINDS.find((k) => k.id === kind)?.label ?? kind;
}

/** The public form's body (the server checks it again). */
export const privacyRequestSchema = z.object({
  fullName: z.string().trim().min(2, "Please enter your name").max(120),
  email: z.string().trim().toLowerCase().email("Enter a valid email — we send the code there").max(320),
  phone: z.string().trim().max(20).optional().or(z.literal("").transform(() => undefined))
    .refine((p) => !p || p.replace(/\D/g, "").length >= 10, "Enter a 10-digit mobile number, or leave it empty"),
  kind: z.enum(PRIVACY_KIND_IDS, { message: "Choose what you want us to do" }),
  details: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
}).superRefine((v, ctx) => {
  if ((v.kind === "correction" || v.kind === "nominate") && !v.details) {
    ctx.addIssue({
      code: "custom", path: ["details"],
      message: v.kind === "correction" ? "Tell us what is wrong and what it should be" : "Give the name and email or phone of the person you nominate",
    });
  }
});
export type PrivacyRequestInput = z.infer<typeof privacyRequestSchema>;

export const verifySchema = z.object({
  requestId: z.string().uuid("This request link is not complete — send the form again"),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email"),
});

/** What the database said about a code, in words for the person (§24: what, why, what next). */
export function verifyReasonMessage(reason: string, left?: number): string {
  switch (reason) {
    case "wrong_code":
      return left && left > 0
        ? `That code is not right. Check the latest email and try again — ${left} ${left === 1 ? "try" : "tries"} left.`
        : "That code is not right, and no tries are left. Send the form again for a new code.";
    case "expired":
      return `The code has expired (it works for ${PRIVACY_CODE_TTL_MIN} minutes). Send the form again for a new code.`;
    case "too_many":
      return "Too many wrong codes. Send the form again for a new code.";
    case "not_found":
      return "We could not find this request. Send the form again.";
    default:
      return "We could not check the code right now. Try again in a minute.";
  }
}

export type PrivacyStatus = "open" | "corrected" | "closed";

export interface PrivacyRequestRow {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  kind: PrivacyRequestKind;
  details: string | null;
  status: PrivacyStatus;
  verified_at: string;
  due_by: string;
  lead_ids: string[];
  customer_ids: string[];
  note: string | null;
  exported_at: string | null;
  closed_at: string | null;
  created_at: string;
}

export const PRIVACY_REQUEST_COLUMNS =
  "id, full_name, email, phone, kind, details, status, verified_at, due_by, lead_ids, customer_ids, note, exported_at, closed_at, created_at";

export const STATUS_LABEL: Record<PrivacyStatus, string> = { open: "Open", corrected: "Corrected", closed: "Closed" };

/** Days until due (negative = overdue) and whether to flag it. A closed request is never overdue. */
export function dueState(dueBy: string, status: PrivacyStatus, todayIst: string): { daysLeft: number; overdue: boolean; label: string } {
  const days = Math.round((Date.parse(`${dueBy}T00:00:00Z`) - Date.parse(`${todayIst}T00:00:00Z`)) / 86_400_000);
  if (status === "closed") return { daysLeft: days, overdue: false, label: "Closed" };
  if (days < 0) return { daysLeft: days, overdue: true, label: `Overdue by ${-days} ${-days === 1 ? "day" : "days"}` };
  if (days === 0) return { daysLeft: 0, overdue: false, label: "Due today" };
  return { daysLeft: days, overdue: false, label: `${days} ${days === 1 ? "day" : "days"} left` };
}

/** Open first, then by due date (soonest first); closed last. */
export function sortRequests<T extends { status: PrivacyStatus; due_by: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const ac = a.status === "closed" ? 1 : 0;
    const bc = b.status === "closed" ? 1 : 0;
    if (ac !== bc) return ac - bc;
    return a.due_by.localeCompare(b.due_by);
  });
}

/* ── Export: one person's data ─────────────────────────────────────────────── */

export interface PersonExport {
  request: { id: string; kind: string; name: string; email: string; phone: string | null; confirmed: string; due_by: string };
  leads: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  consent: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
}

/** Flat rows for the CSV: one line per field, grouped by record — readable by the person. */
export function exportCsvRows(e: PersonExport): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  const add = (section: string, id: string, rec: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(rec)) {
      if (v === null || v === undefined || v === "") continue;
      rows.push([section, id, k, typeof v === "object" ? JSON.stringify(v) : String(v)]);
    }
  };
  add("request", e.request.id, e.request);
  for (const l of e.leads) add("lead", String(l.id ?? ""), l);
  for (const c of e.customers) add("customer", String(c.id ?? ""), c);
  for (const c of e.consent) add("consent", String(c.id ?? ""), c);
  for (const i of e.invoices) add("invoice", String(i.id ?? ""), i);
  return { headers: ["Section", "Record", "Field", "Value"], rows };
}

/** A safe file name part from the person's name. */
export function exportFileStem(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `privacy-request-${s || "person"}`;
}
