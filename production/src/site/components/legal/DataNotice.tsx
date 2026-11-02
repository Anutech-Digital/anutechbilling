"use client";
/**
 * R-2011 (1 Nov 2026, goal G-DPDP): the ONE data notice every website form shows next to its
 * button — what we collect, what for, the Privacy policy, your rights and the grievance contact
 * (DPDP Rules 2025, Rule 3: itemised, plain language) — and, when the form passes `optIn`, a
 * separate UNTICKED "Send me offers on email/WhatsApp" box that is never needed to submit.
 *
 * Wording, version and links live in lib/consent/data-notice.ts. Links open in a new tab so a
 * half-filled form is never lost. Styles are inline with the page's own colour inherited: the
 * notice sits in forms built with three different CSS systems (site.css, Tailwind, gw-*).
 */
import * as React from "react";
import {
  ADULT_OR_BUSINESS_LINE, DATA_NOTICE, MARKETING_OPT_IN_HINT, MARKETING_OPT_IN_LABEL,
  PRIVACY_GRIEVANCE_HREF, PRIVACY_POLICY_HREF, PRIVACY_RIGHTS_HREF, type DataNoticePurpose,
} from "@/lib/consent/data-notice";

export interface DataNoticeProps {
  purpose: DataNoticePurpose;
  /** The opt-in box's state; leave out (with onOptIn) for a notice without the box (AI chat). */
  optIn?: boolean;
  onOptIn?: (v: boolean) => void;
  /** Checkout: also show "I am 18+ or buying for my business." */
  adultLine?: boolean;
  /** Unique per page when a page has two forms (ids of the box and the list). */
  idPrefix?: string;
  /** Smaller, one-paragraph form for tight places (the chat box, a compact call-back strip). */
  compact?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

const link: React.CSSProperties = { color: "inherit", textDecoration: "underline", textUnderlineOffset: 2 };

function Links() {
  return (
    <>
      <a href={PRIVACY_POLICY_HREF} target="_blank" rel="noopener noreferrer" style={link}>Privacy policy</a>
      {" · "}
      <a href={PRIVACY_RIGHTS_HREF} target="_blank" rel="noopener noreferrer" style={link}>Your rights</a>
      {" · "}
      <a href={PRIVACY_GRIEVANCE_HREF} target="_blank" rel="noopener noreferrer" style={link}>Grievance contact</a>
    </>
  );
}

export function DataNotice({ purpose, optIn, onOptIn, adultLine, idPrefix = "dn", compact, className, style }: DataNoticeProps) {
  const n = DATA_NOTICE[purpose];
  const boxId = `${idPrefix}-marketing-optin`;
  const showBox = typeof optIn === "boolean" && typeof onOptIn === "function";
  return (
    <div
      data-testid="data-notice"
      data-purpose={purpose}
      className={className}
      style={{ fontSize: 13, lineHeight: 1.5, opacity: 0.85, textAlign: "left", margin: "10px 0", ...style }}
    >
      {compact ? (
        <p style={{ margin: 0 }}>
          <b>How we use your data:</b> we collect {n.collects} {n.use}. <Links />
        </p>
      ) : (
        <>
          <p style={{ margin: "0 0 2px", fontWeight: 600 }}>How we use your data</p>
          <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc" }}>
            <li>We collect {n.collects}.</li>
            <li>We use it {n.use}. We do not sell it.</li>
            <li>You can ask to see, correct or delete it, or complain: <Links /></li>
          </ul>
        </>
      )}
      {adultLine && <p data-testid="adult-line" style={{ margin: "6px 0 0" }}>{ADULT_OR_BUSINESS_LINE}</p>}
      {showBox && (
        <label htmlFor={boxId} style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 8, cursor: "pointer", opacity: 1 }}>
          <input
            id={boxId}
            type="checkbox"
            name="marketingOptIn"
            checked={optIn}
            onChange={(e) => onOptIn(e.target.checked)}
            aria-describedby={`${boxId}-hint`}
            style={{ width: 18, height: 18, marginTop: 1, flexShrink: 0 }}
          />
          <span>
            {MARKETING_OPT_IN_LABEL}
            <span id={`${boxId}-hint`} style={{ display: "block", fontSize: 12, opacity: 0.85 }}>{MARKETING_OPT_IN_HINT}</span>
          </span>
        </label>
      )}
    </div>
  );
}
