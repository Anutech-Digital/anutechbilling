/**
 * R-260 — the "All set" screen's status rows, built ONLY from real data.
 *
 * Before R-260 the list was hard-coded: Razorpay always "todo", Google CSP always
 * "pending · approval in 5–7 days" (for owners who never applied), WhatsApp always
 * "todo" — even when Settings → Integrations showed them connected. Every row here
 * comes from the same integration GET Settings reads.
 *
 * R-1931 (G-ONBOARD OB-10): the GSTIN / state / payment / customers / price-list rows that used
 * to be built here are gone — the Done screen now shows the ONE "Get to your first quote" list
 * (components/features/dashboard/setup-checklist.ts, the same rows as the Dashboard card). What
 * is left here are the optional integrations, listed under "Later".
 *
 * Input convention for the integration probes:
 *   undefined → still loading  → "checking"
 *   null      → the GET failed (e.g. role cannot read it) → "unknown", never a guess
 */

export type ChecklistStatus = "done" | "pending" | "todo" | "checking" | "unknown";

export interface ChecklistItem {
  id: string;
  label: string;
  status: ChecklistStatus;
  note?: string;
  /** Where to finish it. Absent when the row is done. */
  href?: string;
  /** R-1927: optional integration — listed under "Later" on the Done screen, never before the first quote. */
  later?: boolean;
}

export interface RazorpayProbe {
  configured?: boolean;
  readiness?: { state?: "not_configured" | "collect_only" | "ready" } | null;
}
export interface WhatsAppProbe { configured?: boolean }
export interface GoogleResellerProbe { connected?: boolean; code?: string }

export interface DoneInputs {
  razorpay: RazorpayProbe | null | undefined;
  whatsapp: WhatsAppProbe | null | undefined;
  googleReseller: GoogleResellerProbe | null | undefined;
}

const INTEGRATIONS = "/settings?tab=integrations";

export function buildDoneChecklist(i: DoneInputs): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  // Razorpay — readiness from the server, not a boolean guess.
  if (i.razorpay === undefined) items.push({ later: true, id: "razorpay", label: "Razorpay payments", status: "checking" });
  else if (i.razorpay === null) items.push({ later: true, id: "razorpay", label: "Razorpay payments", status: "unknown", note: "Check in Settings → Integrations", href: INTEGRATIONS });
  else {
    const state = i.razorpay.readiness?.state ?? (i.razorpay.configured ? "ready" : "not_configured");
    if (state === "ready") items.push({ later: true, id: "razorpay", label: "Razorpay connected", status: "done" });
    else if (state === "collect_only") items.push({ later: true, id: "razorpay", label: "Razorpay half set up", status: "pending", note: "Add the webhook secret", href: INTEGRATIONS });
    else items.push({ later: true, id: "razorpay", label: "Connect Razorpay", status: "todo", note: "Optional · online payments", href: INTEGRATIONS });
  }

  // Google Reseller API — the same probe the Settings card runs.
  if (i.googleReseller === undefined) items.push({ later: true, id: "google", label: "Google Reseller API", status: "checking" });
  else if (i.googleReseller?.connected) items.push({ later: true, id: "google", label: "Google Reseller API connected", status: "done" });
  else {
    const code = i.googleReseller?.code;
    items.push({
      later: true,
      id: "google",
      label: "Google Reseller API",
      status: "todo",
      note: code === "api_disabled" ? "The Reseller API is turned off in Google Cloud"
        : code === "needs_reauth" ? "Google needs you to sign in again"
        : code === "not_connected" || code === "missing_scope" ? "Connect Google Reseller in Settings"
        : "Optional · syncs subscriptions",
      href: INTEGRATIONS,
    });
  }

  // WhatsApp Business
  if (i.whatsapp === undefined) items.push({ later: true, id: "whatsapp", label: "WhatsApp Business", status: "checking" });
  else if (i.whatsapp === null) items.push({ later: true, id: "whatsapp", label: "WhatsApp Business", status: "unknown", note: "Check in Settings → Integrations", href: INTEGRATIONS });
  else if (i.whatsapp.configured) items.push({ later: true, id: "whatsapp", label: "WhatsApp Business connected", status: "done" });
  else items.push({ later: true, id: "whatsapp", label: "Connect WhatsApp Business", status: "todo", note: "Optional · send from the app", href: INTEGRATIONS });

  return items;
}

/** Next steps on the Done screen — each one opens the page that does it.
 *  R-1927: the first quote and the integrations are not repeated here (one way per task).
 *  R-1931: "Invite your team" is an item of the first-quote list now, so not repeated either. */
export const NEXT_STEPS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Check your renewals calendar",  href: "/renewals" },
  { label: "Set up reminder automations",   href: "/automation" },
];
