/**
 * R-2021 (R-2019 decision 5, G-DPDP, Pardeep 27 Oct 2026): the phone buy flow's DRAFT lead, sent
 * to POST /api/public/enquiry/workspace with `draft: true`. Saved ONLY when the buyer ticked
 * "WhatsApp me a link to finish this order": `resumeConsent` must be literally true, otherwise
 * the route answers 400 and writes nothing. Without the tick the details stay on the buyer's own
 * phone (localStorage). A draft is a lead only (stage new, no quote, no email, no owner alert);
 * its notes record the tick, the notice version and the time. It is NOT the "Send me offers"
 * opt-in (R-2011): no offers follow from it.
 * Pure — the route does the one insert (the route's allowlist entry already covers leads).
 */
import { z } from "zod";
import { DATA_NOTICE_VERSION } from "@/lib/consent/data-notice";
import { buyIntentNote } from "@/app/api/public/checkout/workspace/buy-intent";
import { buyIntentFields } from "@/app/api/public/checkout/workspace/buy-intent-schema";
import { RESUME_CONSENT_LABEL } from "@/app/(public)/buy/workspace/_mobile/resume-consent";

export const draftSchema = z.object({
  draft:         z.literal(true),
  /** Must be the literal true: the box was ticked. Anything else → nothing is saved. */
  resumeConsent: z.literal(true),
  fullName:      z.string().trim().min(2).max(120),
  phone:         z.string().trim().min(10).max(20),
  email:         z.string().trim().email().max(200).optional().or(z.literal("")),
  companyName:   z.string().trim().max(200).optional(),
  seats:         z.coerce.number().int().min(1).max(10000),
  tierId:        z.enum(["starter", "standard"]),
  billing:       z.enum(["monthly", "annual"]),
  domain:        z.string().trim().max(120).optional(),
  ...buyIntentFields,
});
export type DraftLead = z.infer<typeof draftSchema>;

/** The body asks for a draft (the phone flow) — the route takes this branch first. */
export function isDraftRequest(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { draft?: unknown }).draft === true;
}

export type DraftParse = { ok: true; data: DraftLead } | { ok: false; error: string };

export function parseDraft(body: unknown): DraftParse {
  const p = draftSchema.safeParse(body);
  if (p.success) return { ok: true, data: p.data };
  const noTick = p.error.issues.some((i) => i.path[0] === "resumeConsent");
  return {
    ok: false,
    error: noTick
      ? "Nothing was saved: the 'WhatsApp me a link' box was not ticked."
      : "Nothing was saved: " + p.error.issues.map((i) => i.message).join(", "),
  };
}

/** The lead row (without the ad attribution, which the route adds from the request). */
export function draftLeadRow(d: DraftLead, tenantId: string, leadId: string, now = new Date()) {
  const notes = [
    "DRAFT from the phone buy page — not an order yet, nothing paid.",
    `The buyer ticked "${RESUME_CONSENT_LABEL}" (data notice ${DATA_NOTICE_VERSION}, ${now.toISOString()}). Send them one link to finish; no offers.`,
    `Plan: Google Workspace ${d.tierId === "starter" ? "Business Starter" : "Business Standard"} · ${d.seats} licence${d.seats === 1 ? "" : "s"} · ${d.billing}`,
    d.domain ? `Domain: ${d.domain}` : null,
    buyIntentNote(d),
  ].filter(Boolean).join("\n");
  return {
    id:            leadId,
    tenant_id:     tenantId,
    company:       d.companyName || d.fullName,
    contact_name:  d.fullName,
    contact_email: d.email || null,
    contact_phone: d.phone,
    plan:          `google-workspace-${d.tierId}`,
    seats:         d.seats,
    value:         0,
    stage:         "new" as const,
    /* the Buy Workspace page's own source (lead-sources R-1981); the notes say DRAFT */
    source:        "buy-workspace",
    domain:        d.domain || null,
    notes,
  };
}
