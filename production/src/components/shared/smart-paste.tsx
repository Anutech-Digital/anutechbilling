/**
 * ⚡ Smart Paste — turn a pasted WhatsApp message into filled fields.
 *
 * ─── IT REUSES THE ENQUIRY EXTRACTOR, IT DOES NOT GROW A SECOND ONE ─────────
 * lib/inbound/extract.ts already reads a name, an email, a phone, a seat count and a
 * catalogue product out of free text, and it has 56 tests including the Hinglish units
 * this market actually types ("20 email", "20 log"). A second extractor here would drift
 * from that one and the two would disagree about the same message — which is exactly how
 * the folder rules and the search box came to disagree before they were pulled into one
 * module.
 *
 * ─── NOTHING IS FILLED WITHOUT BEING SHOWN FIRST ────────────────────────────
 * The paste produces a PREVIEW listing every field it found and the words it read each
 * one from. Only then does "Fill the form" appear. One button that reads a stranger's
 * WhatsApp and silently writes six fields is how a wrong phone number ends up on a quote
 * — and the operator, who never saw it happen, has no reason to check.
 *
 * ─── AND A FIELD IT COULD NOT FIND STAYS EMPTY ──────────────────────────────
 * No guessing, no partial credit. A blank field costs ten seconds of typing; an invented
 * seat count becomes a price on a signed document. Same rule as the extractor's own
 * header, and the preview says "not found" out loud rather than showing a gap.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/ui/icon";
import { extractEntities, foundCount, type CatalogueEntry, type ExtractedEntities } from "@/lib/inbound/extract";
import { companyDomainFromEmail } from "@/lib/forms/poka-yoke";

export interface SmartPasteValues {
  name?:    string;
  email?:   string;
  phone?:   string;
  seats?:   number;
  /** The catalogue entry, so the caller can select the real SKU rather than a string. */
  product?: CatalogueEntry;
  /**
   * The company DOMAIN behind a work email — the honest half of "Company".
   *
   * The NAME is not derivable: "Acme", "Acme Corp" and "Acme Corporation Pvt Ltd" are
   * three strings for one business and the one that lands on a tax invoice is a legal
   * fact. The domain is the same every time. See companyDomainFromEmail.
   */
  domain?: string;
}

export interface SmartPasteProps {
  /** The tenant's own catalogue, so a product match is a real SKU and not a guess. */
  catalogue: readonly CatalogueEntry[];
  /** Called with only the fields that were actually found. */
  onFill: (values: SmartPasteValues) => void;
  /**
   * Only name / email / phone — for a form that has no seats, product or domain box
   * (Quick add lead, R-099). The preview and the "Fill N fields" count then describe
   * exactly what will be filled, not three rows the form throws away.
   */
  contactOnly?: boolean;
}

function toValues(e: ExtractedEntities): SmartPasteValues {
  /* Absent, not empty. An empty string in a form field is a value somebody has to notice
     and clear; an absent key leaves whatever the operator already typed alone. */
  const v: SmartPasteValues = {};
  if (e.name.value)    v.name    = e.name.value;
  if (e.email.value)   v.email   = e.email.value;
  if (e.phone.value)   v.phone   = e.phone.value;
  if (e.seats.value)   v.seats   = e.seats.value;
  if (e.product.value) v.product = e.product.value;
  /* Free-mail addresses give nothing — three customers on gmail.com are not one
     company, and filing them under "gmail.com" would tie three businesses together in
     the domain matching. companyDomainFromEmail returns null for those. */
  const domain = companyDomainFromEmail(e.email.value);
  if (domain) v.domain = domain;
  return v;
}

export function SmartPaste({ catalogue, onFill, contactOnly = false }: SmartPasteProps) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");

  const entities = React.useMemo(
    () => (text.trim()
      ? extractEntities({ fromName: null, fromEmail: null, subject: "", body: text, catalogue })
      : null),
    [text, catalogue],
  );
  /* The domain counts as a found field when it is there — it fills a real box on the
     customer form, and a preview that said "4 of 5" while filling five would be lying
     about its own work. */
  const found = !entities
    ? 0
    : contactOnly
      ? [entities.name, entities.email, entities.phone].filter((f) => f.value != null).length
      : foundCount(entities) + (companyDomainFromEmail(entities.email.value) ? 1 : 0);

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        title="Paste a WhatsApp message or an email and this fills what it can read from it."
      >
        ⚡ Smart Paste Text
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold text-ink">⚡ Paste the message</p>
        <button
          type="button"
          onClick={() => { setOpen(false); setText(""); }}
          className="text-ink-3 hover:text-ink"
          aria-label="Close smart paste"
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      <Textarea
        aria-label="Message to read details from"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        autoFocus
        placeholder="Paste a WhatsApp message or an email here — for example: “Hi, mujhe 20 email google workspace standard chahiye. Rahul, 98765 43210”"
        className="text-[13px]"
      />

      {entities && (
        <div className="mt-2.5 rounded-md border border-hairline bg-paper p-2.5">
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
            Found {found} of {contactOnly ? 3 : 6}
          </p>
          <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            <Row label="Name"    value={entities.name.value}    source={entities.name.source} />
            <Row label="Email"   value={entities.email.value}   source={entities.email.source} />
            <Row label="Phone"   value={entities.phone.value}   source={entities.phone.source} />
            {!contactOnly && (
              <>
                <Row label="Seats"   value={entities.seats.value}   source={entities.seats.source} />
                <Row label="Product" value={entities.product.value?.name ?? null} source={entities.product.source} />
                <Row
                  label="Company domain"
                  value={companyDomainFromEmail(entities.email.value)}
                  source={entities.email.value ? `the address ${entities.email.value}` : null}
                />
              </>
            )}
          </dl>
          <p className="mt-2 border-t border-hairline pt-1.5 text-3xs leading-snug text-ink-3">
            Read from the text by rules, not by a model — anything blank was not found and is
            left for you to type. Nothing here is guessed.
          </p>
        </div>
      )}

      <div className="mt-2.5 flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          disabled={found === 0}
          onClick={() => {
            if (!entities) return;
            onFill(toValues(entities));
            setOpen(false);
            setText("");
          }}
        >
          {found === 0 ? "Nothing to fill yet" : `Fill ${found} field${found === 1 ? "" : "s"}`}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, value, source }: { label: string; value: string | number | null; source: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-3xs uppercase tracking-wider text-ink-3">{label}</dt>
      {value == null ? (
        /* Said out loud. A gap reads as a rendering bug and an operator cannot tell it
           apart from a value that failed to load. */
        <dd className="text-[12px] italic text-ink-3">not found</dd>
      ) : (
        <>
          <dd className="break-words text-[13px] font-medium text-ink">{value}</dd>
          {source && (
            <dd className="break-words text-3xs leading-snug text-ink-3">
              from “{source.length > 40 ? `${source.slice(0, 40)}…` : source}”
            </dd>
          )}
        </>
      )}
    </div>
  );
}
