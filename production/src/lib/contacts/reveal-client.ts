/**
 * R-1009 — the browser half of "masked until an explicit call / email action".
 *
 * A role without can_view_contact_details gets leads / customers / contacts with the phone and
 * email masked by the data gateway ("••••••3210"). A Call / WhatsApp / Email button must not
 * dial that string. It asks usableContact() first: an unmasked value comes straight back (owner,
 * manager — no extra request); a masked one is fetched once from /api/contacts/reveal, which
 * checks the role, reads through the caller's RLS and logs the reveal.
 */
"use client";

import { toast } from "sonner";
import { isMaskedContact } from "@/lib/auth/roles";

export type ContactTable = "leads" | "customers" | "contacts";
export type ContactPurpose = "call" | "whatsapp" | "email";

export interface ContactRef {
  table: ContactTable;
  id: string;
  field: string;
}

export { isMaskedContact };

/** The real value from the server, or null (a toast already said why). */
export async function revealContact(ref: ContactRef, purpose: ContactPurpose): Promise<string | null> {
  try {
    const res = await fetch("/api/contacts/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...ref, purpose }),
    });
    const json = (await res.json().catch(() => ({}))) as { value?: string; error?: string };
    if (!res.ok || !json.value) {
      toast.error("Could not open this contact", {
        description: json.error ?? "The server did not answer. Check your connection and try again.",
      });
      return null;
    }
    return json.value;
  } catch {
    toast.error("Could not open this contact", { description: "No connection. Check your internet and try again." });
    return null;
  }
}

/**
 * For an <a href> built from a contact value. A real value: nothing happens, the link works as
 * it is. A masked one: the dead link ("tel:••••3210") is stopped, the real value fetched, and
 * the link built from it is opened.
 */
export function followRevealed(
  e: { preventDefault(): void },
  value: string | null | undefined,
  ref: ContactRef,
  purpose: ContactPurpose,
  build: (real: string) => string | null,
  newTab = false,
): void {
  if (!isMaskedContact(value)) return;
  e.preventDefault();
  void revealContact(ref, purpose).then((real) => {
    const href = real ? build(real) : null;
    if (!href) return;
    if (newTab) window.open(href, "_blank", "noopener,noreferrer");
    else window.location.href = href;
  });
}

/** The value to dial / mail: as it is when not masked, else revealed by the server. */
export async function usableContact(value: string | null | undefined, ref: ContactRef, purpose: ContactPurpose): Promise<string | null> {
  if (!value) return null;
  if (!isMaskedContact(value)) return value;
  return revealContact(ref, purpose);
}
