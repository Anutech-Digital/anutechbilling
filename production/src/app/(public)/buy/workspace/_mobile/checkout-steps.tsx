"use client";
/**
 * R-2021 (R-2019b): the phone checkout's two form steps.
 *  - Domain (step 1): a switch → only the domain on Google Workspace now; new → I have a domain /
 *    I need a new one (the desktop's live search + booking, R-1977) / Decide later. The field opens
 *    inside the chosen card; where their email is today is asked for have / later.
 *  - Details (step 2): name, +91 mobile (numeric keypad), invoice email, GST yes / no → GSTIN
 *    (checksum, as the server) + business name, else the state. Errors only after Continue, with
 *    one summary line on top. The R-2011 data notice + its unticked offers box, and — separate and
 *    unticked — "WhatsApp me a link to finish this order" (only that saves a draft on our server).
 */
import * as React from "react";
import { DataNotice } from "@/site/components/legal/DataNotice";
import { NewDomainSearch } from "../_parts/new-domain";
import { STATE_OPTIONS, cleanDomain } from "../_parts/checkout-form";
import { stateName } from "../_parts/brand";
import { MIGRATION_LABEL, MIGRATION_SOURCES, type DomainMode } from "@/app/api/public/checkout/workspace/buy-intent";
import {
  cleanGstinInput, domainModesFor, fitMode, gstinError, mobileDigits, type DetailsErr, type DomainErr, type MobileForm,
} from "./form-state";
import { inputCls, choiceCls, Dot } from "./checkout-chrome";
import { RESUME_CONSENT_HINT, RESUME_CONSENT_LABEL } from "./resume-consent";
import type { Intent } from "./url-state";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";

type SetForm = (patch: Partial<MobileForm>) => void;

const MODE_COPY: Record<DomainMode, [string, string]> = {
  have: ["I have a website / domain", "Like acme.in. We'll connect it for you."],
  new: ["I need a new domain", "We'll register the name you choose."],
  google: ["I'm already on Google Workspace", "We only take over billing. Nothing changes for your team."],
  later: ["Decide later", "No problem. We'll sort it out together on the setup call."],
};

function Msg({ id, err, ok, hint }: { id: string; err?: string; ok?: string; hint?: string }) {
  const text = err || ok || hint || "";
  return <div id={id} className={`text-sm mt-1 min-h-5 ${err ? "text-rose-ink" : ok ? "text-emerald-ink" : "text-ink-3"}`}>{text}</div>;
}

export function DomainStep({ intent, form, setForm, errors, seats, billsWithOrder }: {
  intent: Intent; form: MobileForm; setForm: SetForm; errors: DomainErr; seats: number; billsWithOrder: boolean;
}) {
  const mode = fitMode(form, intent);
  const modes = domainModesFor(intent);
  const clean = cleanDomain(form.domain);
  const migNote = form.migrationSource === "none"
    ? "No problem. Your new mailboxes start fresh."
    : seats >= 5
      ? `We copy all your old email, contacts and calendar for you, free for your ${seats} licences. Usually 24–48 hours, and email keeps working throughout.`
      : "We copy all your old email for you. For fewer than 5 licences, we'll tell you the price on the setup call before doing anything.";
  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-serif font-normal text-[26px] leading-tight m-0">
        {intent === "transfer" ? "Which domain is on Google Workspace now?" : "What should your email address be?"}
      </h2>
      <div role="radiogroup" aria-label="Domain choice" className="flex flex-col gap-2.5">
        {modes.map((m) => {
          const on = m === mode;
          return (
            <div key={m} className={`${choiceCls(on)} flex-col !gap-0 p-0`}>
              <button type="button" role="radio" aria-checked={on} onClick={() => setForm({ domainMode: m })}
                className="w-full text-left flex gap-3 items-start p-3.5 min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-xl">
                <Dot on={on} />
                <span className="flex flex-col gap-0.5">
                  <span className="font-bold text-[15px]">{MODE_COPY[m][0]}</span>
                  <span className="text-sm text-ink-2">{MODE_COPY[m][1]}</span>
                </span>
              </button>
              {on && (m === "have" || m === "google") && (
                <div className="px-3.5 pb-3.5 w-full">
                  <label htmlFor="m-domain" className="block text-sm font-semibold text-ink-2 mb-1.5">Your domain</label>
                  <input id="m-domain" value={form.domain} placeholder="acme.in" autoComplete="url" inputMode="url" autoCapitalize="none" spellCheck={false}
                    aria-invalid={!!errors.domain} aria-describedby="m-domain-msg"
                    onChange={(e) => setForm({ domain: e.target.value })} className={`${inputCls(errors.domain)} font-mono`} />
                  <Msg id="m-domain-msg" err={errors.domain}
                    ok={/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean) ? (m === "google" ? `✓ We'll take over billing for ${clean}. Nothing moves.` : `✓ We'll connect ${clean} for you on the setup call.`) : undefined}
                    hint="Just the part after @. No www needed." />
                </div>
              )}
              {on && m === "new" && (
                <div className="px-3.5 pb-3.5 w-full">
                  <NewDomainSearch value={form.newDomain} onChange={(d) => setForm({ newDomain: { ...d, mode: "new" } })}
                    error={errors.newName} onClearError={() => undefined} billsWithOrder={billsWithOrder} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {(mode === "have" || mode === "later") && (
        <div className="flex flex-col gap-2">
          <h3 id="m-mig" className="font-bold text-[15px] m-0">Where do you get email today?</h3>
          <div role="radiogroup" aria-labelledby="m-mig" className="flex flex-wrap gap-2">
            {MIGRATION_SOURCES.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={form.migrationSource === s} onClick={() => setForm({ migrationSource: s })}
                className={`min-h-11 px-3.5 rounded-full border-[1.5px] text-sm font-semibold ${form.migrationSource === s ? "border-amber bg-amber-soft" : "border-hairline bg-white"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber`}>
                {MIGRATION_LABEL[s]}
              </button>
            ))}
          </div>
          <p className="text-sm text-ink-2 m-0">{migNote}</p>
        </div>
      )}
    </div>
  );
}

export function DetailsStep({ form, setForm, errors, summary, needAddress, optIn, onOptIn, resume, onResume, turnstile }: {
  form: MobileForm; setForm: SetForm; errors: DetailsErr; summary: string; needAddress: boolean;
  optIn: boolean; onOptIn: (v: boolean) => void; resume: boolean; onResume: (v: boolean) => void; turnstile: React.ReactNode;
}) {
  const g = cleanGstinInput(form.gstin);
  const gOk = form.needGst && g.length === 15 && !gstinError(g);
  const digits = mobileDigits(form.phone);
  const field = (k: "name" | "email" | "company" | "addressLine1" | "city" | "pinCode", label: React.ReactNode, extra: React.InputHTMLAttributes<HTMLInputElement>, hint?: string) => (
    <div>
      <label htmlFor={`m-${k}`} className="block text-sm font-semibold text-ink-2 mb-1.5">{label}</label>
      <input id={`m-${k}`} value={form[k]} onChange={(e) => setForm({ [k]: e.target.value })} aria-invalid={!!errors[k]} aria-describedby={`m-${k}-msg`}
        className={inputCls(errors[k])} {...extra} />
      <Msg id={`m-${k}-msg`} err={errors[k]} hint={hint} />
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-serif font-normal text-[26px] leading-tight m-0 mb-1">Who should we send the invoice to?</h2>
      {summary && <p role="alert" data-testid="details-summary" className="text-sm text-rose-ink bg-rose-soft border border-rose rounded-[10px] px-3 py-2.5 m-0">{summary}</p>}
      {field("name", "Your name", { autoComplete: "name", autoCapitalize: "words" })}
      <div>
        <label htmlFor="m-phone" className="block text-sm font-semibold text-ink-2 mb-1.5">Mobile number</label>
        <div className={`flex items-stretch ${inputCls(errors.phone)} !p-0 overflow-hidden`}>
          <span aria-hidden className="px-3 grid place-items-center bg-paper-2 border-r border-hairline text-base text-ink-2">+91</span>
          <input id="m-phone" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={11} value={form.phone}
            aria-invalid={!!errors.phone} aria-describedby="m-phone-msg"
            onChange={(e) => setForm({ phone: e.target.value.replace(/[^\d ]/g, "").slice(0, 11) })}
            className="flex-1 min-w-0 h-full px-3 text-base bg-white outline-none" />
        </div>
        <Msg id="m-phone-msg" err={errors.phone} ok={digits.length === 10 ? "✓ We'll call this number to set things up" : undefined} hint="We'll call this number to set things up" />
      </div>
      {field("email", "Email for the invoice", { type: "email", inputMode: "email", autoComplete: "email", autoCapitalize: "none", spellCheck: false }, "Any email works. Your new Workspace email isn't ready yet.")}
      <div>
        <h3 id="m-gst-q" className="text-sm font-semibold text-ink-2 m-0 mb-1.5">Will your business claim the GST back?</h3>
        <div role="radiogroup" aria-labelledby="m-gst-q" aria-describedby="m-needGst-msg" className="grid grid-cols-2 gap-2">
          {([["Yes, add GSTIN", true], ["No / not sure", false]] as const).map(([label, v]) => (
            <button key={label} type="button" role="radio" aria-checked={form.needGst === v} onClick={() => setForm({ needGst: v })}
              className={`min-h-12 px-3 rounded-[10px] border-[1.5px] text-sm font-semibold ${form.needGst === v ? "border-amber bg-amber-soft" : errors.needGst ? "border-rose bg-white" : "border-hairline bg-white"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber`}>
              {label}
            </button>
          ))}
        </div>
        <Msg id="m-needGst-msg" err={errors.needGst} />
      </div>
      {form.needGst === true && (
        <>
          <div>
            <label htmlFor="m-gstin" className="block text-sm font-semibold text-ink-2 mb-1.5">GSTIN</label>
            <input id="m-gstin" value={form.gstin} maxLength={15} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="07ABCDE1234F1Z5"
              aria-invalid={!!errors.gstin} aria-describedby="m-gstin-msg"
              onChange={(e) => setForm({ gstin: cleanGstinInput(e.target.value) })} className={`${inputCls(errors.gstin)} font-mono uppercase`} />
            <Msg id="m-gstin-msg" err={errors.gstin}
              ok={gOk ? `✓ Valid · ${stateName(stateCodeFromGstin(g)) ?? `state code ${g.slice(0, 2)}`}` : undefined}
              hint="15 characters, printed on your GST certificate" />
          </div>
          {field("company", "Business name (as on GST certificate)", { autoComplete: "organization" })}
        </>
      )}
      {form.needGst === false && (
        <>
          <div>
            <label htmlFor="m-stateCode" className="block text-sm font-semibold text-ink-2 mb-1.5">Your state</label>
            <select id="m-stateCode" value={form.stateCode} onChange={(e) => setForm({ stateCode: e.target.value })} aria-invalid={!!errors.stateCode} aria-describedby="m-stateCode-msg"
              autoComplete="address-level1" className={`${inputCls(errors.stateCode)} px-3`}>
              <option value="">Select state</option>
              {STATE_OPTIONS.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
            </select>
            <Msg id="m-stateCode-msg" err={errors.stateCode} hint="It decides whether your invoice shows CGST + SGST or IGST." />
          </div>
          {field("company", "Business name (optional)", { autoComplete: "organization" })}
        </>
      )}
      {needAddress && (
        <>
          {field("addressLine1", "Address (the new domain is registered to it)", { autoComplete: "street-address" })}
          {field("city", "City", { autoComplete: "address-level2" })}
          {field("pinCode", "PIN code", { inputMode: "numeric", autoComplete: "postal-code", maxLength: 6 })}
        </>
      )}
      {/* R-2011: the ONE data notice + its unticked offers box (never needed to order). */}
      <DataNotice purpose="order" optIn={optIn} onOptIn={onOptIn} idPrefix="m" className="text-ink-2" style={{ margin: "6px 0 0" }} />
      {/* R-2019 decision 5: separate, unticked — only this saves a draft lead on our server. */}
      <label htmlFor="m-resume" className="flex gap-2.5 items-start text-sm text-ink cursor-pointer mt-1 min-h-11">
        <input id="m-resume" type="checkbox" name="resumeConsent" checked={resume} onChange={(e) => onResume(e.target.checked)} aria-describedby="m-resume-hint"
          className="w-5 h-5 mt-0.5 shrink-0 accent-[hsl(var(--amber))]" />
        <span className="flex flex-col gap-0.5">
          <span className="font-semibold">{RESUME_CONSENT_LABEL}</span>
          <span id="m-resume-hint" className="text-ink-2">{RESUME_CONSENT_HINT}</span>
        </span>
      </label>
      {resume && turnstile}
      <p className="text-sm text-ink-3 m-0">Your details are kept on this phone as you type, so a refresh loses nothing.</p>
    </div>
  );
}
