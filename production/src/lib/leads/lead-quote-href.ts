/**
 * R-389 (F5) — the link from a lead to a new quote.
 *
 * Every "Send quote" surface built /quotes/new?leadId=…&company=…&contact=…&email=…&phone=…,
 * which puts a customer's email and phone into the browser history, the server and proxy
 * logs, and any screenshot of the address bar. The builder already loads the lead by id
 * (quote-builder.tsx `leadFromQuery`) and fills company / contact / email / phone from it,
 * so the URL needs only the id — plus plan and seats, which are not personal and let the
 * builder price the first line before the lead row arrives.
 *
 * Old links that still carry company/email/phone keep working: the builder reads those
 * params when present.
 */
export function leadQuoteHref(
  lead: { id: string; plan?: string | null; seats?: number | null },
  extra?: { duplicate?: string | null },
): string {
  const q = new URLSearchParams();
  if (extra?.duplicate) q.set("duplicate", extra.duplicate);
  q.set("leadId", lead.id);
  if (lead.plan) q.set("plan", lead.plan);
  if (lead.seats != null && lead.seats > 0) q.set("seats", String(lead.seats));
  return `/quotes/new?${q.toString()}`;
}
