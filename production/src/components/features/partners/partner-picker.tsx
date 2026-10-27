/**
 * R-1847 — pick the partner for a drawings / capital entry from the partners register
 * (no free text). Used by Balance Sheet → Record drawings and Banking → Reconcile.
 *
 * The value is the partner's register NAME: R-1839's RPCs take the name and the database
 * links it to the register row (trg_owner_equity_partner_link), so their signatures stay.
 * Only partners active on the entry's date are offered. Empty register → a link to add them.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { activePartners, type FirmPartner } from "@/lib/accounting/partners";

export const PARTNERS_HREF = "/settings?tab=company#partners";

export function PartnerPicker({ id, partners, onDate, value, onChange, loading = false, ariaLabel }: {
  id: string;
  partners: readonly FirmPartner[];
  /** YYYY-MM-DD — partners who had left by then (or not yet joined) are not offered. */
  onDate: string;
  value: string;
  onChange: (name: string) => void;
  loading?: boolean;
  /** When there is no visible <label htmlFor={id}>. */
  ariaLabel?: string;
}) {
  const choices = activePartners(partners, onDate);
  if (!loading && partners.length === 0) {
    return (
      <p className="text-xs text-ink-3">
        No partners in the register yet — <Link className="text-indigo underline" href={PARTNERS_HREF as never}>add your partners</Link> in Settings → Company first.
      </p>
    );
  }
  return (
    <>
      <select id={id} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} disabled={loading}
        className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo/40">
        <option value="">{loading ? "Loading partners…" : "Pick a partner…"}</option>
        {choices.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
      </select>
      {!loading && choices.length === 0 && (
        <p className="text-xs text-amber-ink mt-1">No partner was in the firm on this date — check the date, or the joining / leaving dates in <Link className="underline" href={PARTNERS_HREF as never}>the partners register</Link>.</p>
      )}
    </>
  );
}
