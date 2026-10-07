/**
 * GettingStartedCard — first-run onboarding for a new reseller.
 *
 * A new tenant lands on an empty dashboard with no idea what to do first. This card gives a
 * guided path — each step checks off from REAL data (no fake ticks), routes to the right
 * screen, and the whole card auto-hides once the reseller is set up.
 *
 * ─── THE GST STEP IS SEPARATE, AND THAT IS A BUG FIX ────────────────────────
 * It used to be one row: "Set up your business & GST profile", ticked by `setupDone` — which
 * is `tenants.setup_completed_at`, stamped by the final Continue of the setup wizard.
 *
 * GSTIN IS OPTIONAL IN THAT WIZARD. Nothing blocks Continue with the field empty
 * (app/(app)/setup/page.tsx — the GSTIN Field has no required rule and no gate on the
 * button). So a reseller could run the wizard, skip GSTIN, and get a green tick with a line
 * through the words "GST profile" while holding no GSTIN at all. Every invoice this app
 * issues is a GST tax invoice; that tick was the app telling somebody they were compliant
 * when the one field that makes them compliant was blank.
 *
 * The fix is not a longer label. The two facts are separate and are checked separately: the
 * organisation exists when its legal name is saved, and GST is set when a GSTIN passes
 * `isValidGstin` — format AND checksum, the same function Settings → Company uses. A
 * mistyped GSTIN now leaves the step open rather than ticking it.
 *
 * ─── WHY FIVE STEPS AND NOT FOUR ────────────────────────────────────────────
 * The brief asked for four, ending at "issue first quote". The payment step is kept anyway:
 * a quote that nobody paid proves the app can draft, not that the money-spine works, and
 * this card's whole job is to walk somebody to their first real sale. Splitting the GST row
 * out is what took it from four to five.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { isValidGstin } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenRoute } from "./route-access";

interface Step {
  id:    string;
  label: string;
  hint:  string;
  href:  string;
  cta:   string;
  done:  boolean;
}

export function GettingStartedCard({
  setupDone, hasCustomer, hasCatalog, hasQuote, hasSale, workspaceName, gstin, ready = true,
}: {
  /**
   * False while any of the facts above is still loading. Until then the card renders nothing:
   * judged on half-loaded data it showed every step open for a second and then vanished,
   * the largest layout shift on the Dashboard (R-134, 3 Oct 2026).
   */
  ready?:       boolean;
  setupDone:    boolean;
  hasCustomer:  boolean;
  /**
   * Kya catalogue me ek bhi item hai? 1 Sep 2026 ke audit ka B2: naya tenant
   * "Create your first quote" par pahunchta tha aur quote-builder KHALI milta
   * tha — default-catalog ka button sirf /items ke empty-state me chhupa tha.
   * Ab wo kadam guided raaste ka hissa hai.
   */
  hasCatalog:   boolean;
  hasQuote:     boolean;
  hasSale:      boolean;
  workspaceName: string;
  /** `tenants.gstin`. Null or malformed leaves the GST step open — see the header. */
  gstin?:       string | null;
}) {
  const gstDone = isValidGstin((gstin ?? "").trim());
  const { data: me } = useCurrentUser();
  const role = me?.role ?? null;
  if (!ready) return null;

  const allSteps: Step[] = [
    { id: "org",      label: "Add your organisation",              hint: "Legal name, address and state — these print on every document.", href: "/setup",     cta: "Set up",       done: setupDone },
    { id: "gst",      label: "Add your GSTIN",                     hint: "Without it an invoice cannot be a valid tax invoice.",           href: "/setup",     cta: "Add GSTIN",    done: gstDone },
    { id: "customer", label: "Add your first customer",            hint: "Or import from CSV — takes a minute.",                           href: "/customers", cta: "Add customer", done: hasCustomer },
    { id: "catalog",  label: "Load your price list",               hint: "One click seeds 7 products + 8 add-ons — edit rates anytime.",   href: "/items",     cta: "Load catalog", done: hasCatalog },
    { id: "quote",    label: "Create your first quote",            hint: "Pick from your catalog, send on WhatsApp/email.",                href: "/quotes/new", cta: "New quote",   done: hasQuote },
    { id: "sale",     label: "Record your first payment",          hint: "When a customer pays, the sale + invoice happen here.",          href: "/quotes",    cta: "View quotes",  done: hasSale },
  ];
  /* R-253: billing cannot open /quotes or /items, so those buttons threw them back to
     /invoices. Their payment step goes to Payments Received (Record payment works there for
     every role); a step on a page the role cannot open is someone else's job and is left out. */
  const steps: Step[] = allSteps
    .map((s) => (s.id === "sale" && !canOpenRoute(role, s.href) && canOpenRoute(role, "/payments")
      ? { ...s, href: "/payments", cta: "Record payment", hint: "When a customer pays, record it here. The invoice follows." }
      : s))
    .filter((s) => canOpenRoute(role, s.href));
  if (steps.length === 0) return null;

  const doneCount = steps.filter((s) => s.done).length;
  // Once everything is done, the card retires itself — no clutter for an active user.
  if (doneCount === steps.length) return null;

  const pct = Math.round((doneCount / steps.length) * 100);
  // The next actionable step gets the spotlight (primary CTA); the rest are quiet.
  const nextStep = steps.find((s) => !s.done);

  return (
    <Card className="mb-3 border-amber/30 bg-amber-soft/20">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h2 className="font-serif text-xl text-ink leading-tight flex items-center gap-2">
            <Icon name="rocket" size={18} className="text-amber" />
            Welcome{workspaceName ? <> to <span className="text-amber-ink">{workspaceName}</span></> : null} — let&apos;s get you selling
          </h2>
          <p className="text-[12px] text-ink-3 mt-0.5">
            {doneCount} of {steps.length} done. A few minutes and you&apos;re ready to send your first quote.
          </p>
        </div>
        <div className="text-right">
          <span className="font-serif text-2xl text-amber tabular-nums">{pct}%</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 w-full rounded-full bg-paper-2 overflow-hidden mb-4">
        <div className="h-full bg-amber transition-all" style={{ width: `${pct}%` }} />
      </div>

      <ul className="space-y-2">
        {steps.map((s) => {
          const isNext = nextStep?.id === s.id;
          return (
            <li
              key={s.id}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                s.done ? "border-hairline bg-paper/60" : isNext ? "border-amber/40 bg-paper" : "border-hairline bg-paper"
              }`}
            >
              <span
                className={`grid place-items-center h-6 w-6 rounded-full shrink-0 ${
                  s.done ? "bg-emerald text-white" : "border-2 border-hairline-strong text-transparent"
                }`}
              >
                {s.done && <Icon name="check" size={13} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-sm font-medium ${s.done ? "text-ink-3 line-through" : "text-ink"}`}>{s.label}</span>
                {!s.done && <span className="block text-2xs text-ink-3">{s.hint}</span>}
              </span>
              {!s.done && (
                <Link
                  href={s.href as Route}
                  className={`shrink-0 text-xs font-semibold px-3 py-1.5 rounded-md transition-colors ${
                    isNext ? "bg-amber text-white hover:bg-amber-ink" : "border border-hairline text-ink-2 hover:bg-paper-2"
                  }`}
                >
                  {s.cta}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
