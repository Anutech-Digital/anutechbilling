/**
 * The name pre-filled in the accept dialog's "Your full name" box (R-376 d, 7 Oct 2026).
 *
 * It used to be `quote.customer_name` — the COMPANY ("Acme Pvt Ltd") — so the person
 * accepting signed as a company unless they noticed and retyped. The signature is a
 * person's: the customer's contact person, else the lead's contact, and only when
 * neither is known the company name (the old behaviour, still editable).
 *
 * @example signerNameDefault({ lead: { contact_name: "Rajesh K" }, company: "Acme" }) // "Rajesh K"
 */
export function signerNameDefault(a: {
  customer?: { contact_first_name?: string | null; contact_last_name?: string | null; contact_name?: string | null } | null;
  lead?: { contact_name?: string | null } | null;
  company?: string | null;
}): string {
  const c = a.customer;
  const split = [c?.contact_first_name, c?.contact_last_name].map((s) => s?.trim()).filter(Boolean).join(" ");
  return split || c?.contact_name?.trim() || a.lead?.contact_name?.trim() || a.company?.trim() || "";
}
