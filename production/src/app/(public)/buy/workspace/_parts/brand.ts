/**
 * R-1970 (DECISIONS 1, 26 Oct 2026): the company on /buy/workspace — name, logo, GSTIN,
 * address, phone — comes from the website tenant's own row (tenants via websiteTenantId), never
 * a hard-coded constant. The design's sample company name is history; nothing is typed here.
 * When the row cannot be read the page still sells, with a neutral header and no legal block.
 */
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { WHATSAPP_NUMBER, WHATSAPP_READY, whatsappDisplay } from "@/site/lib/config";

export interface BuyBrand {
  name: string;
  logoUrl: string | null;
  gstin: string | null;
  address: string | null;
  stateCode: string | null;  // place of supply of the seller: CGST+SGST vs IGST
  phone: string | null;
  email: string | null;
}

export interface TenantBrandRow {
  name: string | null;
  logo_url: string | null;
  gstin: string | null;
  address: string | null;
  pin_code: string | null;
  state: string | null;
  state_code: string | null;
  phone: string | null;
  email: string | null;
}

const clean = (s: string | null | undefined) => (s ?? "").trim() || null;

/** The tenant row → what the page shows. The seller state falls back to the GSTIN's digits. */
export function brandFromTenant(row: TenantBrandRow | null): BuyBrand | null {
  const name = clean(row?.name);
  if (!row || !name) return null;
  const gstin = clean(row.gstin)?.toUpperCase() ?? null;
  const stateCode = clean(row.state_code) ?? (gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null);
  const pin = clean(row.pin_code);
  const addr = clean(row.address);
  const address = addr ? (pin && !addr.includes(pin) ? `${addr} ${pin}` : addr) : null;
  return { name, logoUrl: clean(row.logo_url), gstin, address, stateCode, phone: clean(row.phone), email: clean(row.email) };
}

export function stateName(code: string | null | undefined): string | null {
  return code ? (GST_STATE_BY_CODE as Record<string, string>)[code] ?? null : null;
}

export interface BuyContact {
  /** Call link + its text; null when there is no live number to call. */
  tel: { href: string; display: string } | null;
  /** WhatsApp number (digits, country code first); null while the site's number is the placeholder. */
  whatsapp: string | null;
}

/** Phone from the tenant row, else the site's WhatsApp number (DECISIONS 5). */
export function buyContact(brand: BuyBrand | null): BuyContact {
  const digits = (brand?.phone ?? "").replace(/\D/g, "");
  const tenantE164 = digits.length === 10 ? `91${digits}` : digits.length === 12 && digits.startsWith("91") ? digits : null;
  const e164 = tenantE164 ?? (WHATSAPP_READY ? WHATSAPP_NUMBER : null);
  return {
    tel: e164 ? { href: `tel:+${e164}`, display: whatsappDisplay(e164) } : null,
    whatsapp: WHATSAPP_READY ? WHATSAPP_NUMBER : null,
  };
}

export function whatsappHref(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}
