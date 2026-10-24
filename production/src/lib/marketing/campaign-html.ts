/**
 * R-734 (23 Oct 2026): the HTML side of a campaign mail. Merge values ({{company}}, {{name}},
 * the AI pitch …) come from public forms, Lead Finder and the model — in the HTML body they are
 * text, never markup, or a lead named `<a href=…>` becomes a link mailed from our domain.
 * The plain-text body and the subject keep the raw values.
 */
import { escapeHtml } from "@/lib/digest/owner-digest-html";

/** Every merge value escaped for HTML. */
export function campaignHtmlVars<T extends Record<string, string>>(vars: T): T {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = escapeHtml(v);
  return out as T;
}

/** The contact name as fillName should see it for the HTML body; null stays null (→ "Sir/Ma'am"). */
export function campaignHtmlName(full: string | null | undefined): string | null {
  return full ? escapeHtml(full) : null;
}
