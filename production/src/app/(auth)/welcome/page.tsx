"use client";

/**
 * /welcome — the fork that replaces a guess.
 *
 * A person lands here signed in and with no workspace. That is the exact moment
 * the old callback silently created a company for them, named after their email
 * domain, indistinguishable on screen from the company they meant to join. Four of
 * this database's five tenants were born on that line; one of them absorbed two
 * days of real customer work and a ₹21,240 payment before anyone noticed.
 *
 * So the screen asks. Three options, because there are three real answers and the
 * third one is easy to forget: a customer who followed a quote link is not a
 * ResellerOS user at all and must not be handed a workspace.
 *
 * Option A is deliberately NOT the visually loudest. The most likely correct
 * answer for anyone arriving with a work address is B, and the failure this page
 * exists to prevent is people taking A when they meant B.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

type Choice = "new" | "join" | "quote";

function WelcomeInner() {
  const router = useRouter();
  const params = useSearchParams();

  const [pendingFromCreate, setPendingFromCreate] = React.useState<string | null>(null);
  const pendingTenant = params.get("pending") ?? pendingFromCreate;
  const suggested     = params.get("suggested") ?? "";

  const [choice, setChoice]   = React.useState<Choice | null>(null);
  const [busy, setBusy]       = React.useState(false);
  const [sentMsg, setSentMsg] = React.useState<string | null>(null);

  const [companyName, setCompanyName] = React.useState(suggested);
  const [domain, setDomain]           = React.useState("");
  const [quoteId, setQuoteId]         = React.useState("");

  // ── Already parked by the domain match on the way in ────────────────────
  if (pendingTenant) {
    return (
      <Card>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
            <Icon name="clock" size={22} className="text-amber-ink" />
          </div>
          <h1 className="font-serif text-2xl mb-2">Waiting for approval</h1>
          <p className="text-sm text-ink-2 leading-relaxed">
            Your company already uses ResellerOS — we&apos;ve asked the owner of{" "}
            <b className="text-ink">{pendingTenant}</b> to add you.
          </p>
          <p className="mt-2 text-xs text-ink-3">
            You&apos;ll be able to sign in as soon as they approve. Nothing else is needed from you.
          </p>
          <div className="mt-4 rounded-md border border-hairline bg-paper-2 p-3 text-left text-xs text-ink-3 leading-relaxed">
            We did <b>not</b> create a separate company for you. That is deliberate — joining the
            existing workspace is what lets you see your team&apos;s customers, quotes and invoices
            instead of an empty app.
          </div>
          <Link href="/login" className="mt-5 inline-block text-sm text-amber font-medium hover:underline">
            Back to sign in
          </Link>
        </div>
      </Card>
    );
  }

  if (sentMsg) {
    return (
      <Card>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
            <Icon name="check" size={22} className="text-amber-ink" />
          </div>
          <h1 className="font-serif text-2xl mb-2">Request sent</h1>
          <p className="text-sm text-ink-2 leading-relaxed">{sentMsg}</p>
          <Link href="/login" className="mt-5 inline-block text-sm text-amber font-medium hover:underline">
            Back to sign in
          </Link>
        </div>
      </Card>
    );
  }

  async function createWorkspace() {
    if (companyName.trim().length < 2) {
      toast.error("Enter your company name.", {
        description: "At least 2 letters — it goes on your quotes and invoices. You can change it later in Settings.",
      });
      return;
    }
    setBusy(true);
    try {
      const res  = await fetch("/api/auth/onboarding/new-tenant", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ companyName: companyName.trim() }),
      });
      const json = await res.json() as { ok?: boolean; error?: string; status?: string; tenantName?: string };
      if (!res.ok || json.error) {
        toastError(json.error, {
          fallback: "Could not create the workspace.",
          description: "Nothing was created. Check the company name and press Create again.",
        });
        return;
      }
      /* R-822: their company already has a workspace — a join request went to its owner
         instead of creating a second, empty company. */
      if (json.status === "pending_approval") {
        setPendingFromCreate(json.tenantName ?? "your company's workspace");
        return;
      }
      toast.success("Workspace created 🎉");
      window.location.href = "/setup?welcome=1";
    } catch (err) {
      toastError(err, {
        fallback: "Could not create the workspace.",
        description: "The connection dropped before it finished. Check your internet and press Create again.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function requestToJoin() {
    if (domain.trim().length < 3) {
      toast.error("Enter your work email domain, like anutech.in", {
        description: "The part after @ in your work email — we use it to find your company's workspace.",
      });
      return;
    }
    setBusy(true);
    try {
      const res  = await fetch("/api/auth/onboarding/join-request", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ company: domain.trim() }),
      });
      const json = await res.json() as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || json.error) {
        toastError(json.error, {
          fallback: "Could not send the request.",
          description: "Check the domain (like anutech.in) and try again, or ask your admin to invite you.",
        });
        return;
      }
      setSentMsg(json.message ?? "We've asked the workspace owner to add you.");
    } catch (err) {
      toastError(err, {
        fallback: "Could not send the request.",
        description: "The connection dropped before it finished. Check your internet and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  function openQuote() {
    const id = quoteId.trim();
    if (!id) {
      toast.error("Enter the quote code from your email.", {
        description: "It is in the quote email we sent you — or open the link in that email directly.",
      });
      return;
    }
    router.push(`/quote/${encodeURIComponent(id)}/accept`);
  }

  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">One quick question</h1>
        <p className="text-sm text-ink-3">
          We don&apos;t recognise this email yet. Which of these is you?
        </p>
      </div>

      <div className="space-y-3">
        <ChoiceRow
          icon="users"
          title="I'm joining my team"
          blurb="My company already uses ResellerOS and I need access to it."
          selected={choice === "join"}
          onSelect={() => setChoice("join")}
        >
          <FormField label="Your work email domain" required htmlFor="domain">
            <Input
              id="domain"
              placeholder="e.g. anutech.in"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              helper="We'll ask that workspace's owner to add you. Nothing is created for you."
            />
          </FormField>
          <Button variant="primary" className="w-full justify-center" loading={busy} onClick={requestToJoin}>
            Ask to join
          </Button>
        </ChoiceRow>

        <ChoiceRow
          icon="building"
          title="I'm setting up a new business"
          blurb="I'm a reseller starting my own workspace on ResellerOS."
          selected={choice === "new"}
          onSelect={() => setChoice("new")}
        >
          <FormField label="Company name" required htmlFor="companyName">
            <Input
              id="companyName"
              placeholder="e.g. ANUTECH DIGITAL PVT LTD"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              helper="This creates a brand-new, empty company. Your teammates won't be in it."
            />
          </FormField>
          <Button variant="primary" className="w-full justify-center" loading={busy} onClick={createWorkspace}>
            Create my workspace
          </Button>
        </ChoiceRow>

        <ChoiceRow
          icon="receipt"
          title="I'm a customer with a quote"
          blurb="Someone sent me a quote or invoice to review."
          selected={choice === "quote"}
          onSelect={() => setChoice("quote")}
        >
          <FormField label="Quote code" required htmlFor="quoteId">
            <Input
              id="quoteId"
              className="font-mono"
              placeholder="e.g. Q-ET-2026-27-0001"
              value={quoteId}
              onChange={(e) => setQuoteId(e.target.value)}
              helper="It's at the top of the email you received. You don't need an account."
            />
          </FormField>
          <Button variant="primary" className="w-full justify-center" onClick={openQuote}>
            Open my quote
          </Button>
        </ChoiceRow>
      </div>

      <p className="mt-6 text-center text-xs text-ink-3">
        Not sure? Ask whoever invited you — picking &quot;new business&quot; when you meant
        &quot;joining my team&quot; puts your work in a company only you can see.
      </p>
    </Card>
  );
}

function ChoiceRow({
  icon, title, blurb, selected, onSelect, children,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  title: string;
  blurb: string;
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border transition-colors ${
        selected ? "border-amber bg-amber-soft/40" : "border-hairline hover:border-ink-4"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-expanded={selected}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <span
          className={`mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full ${
            selected ? "bg-amber text-white" : "bg-paper-2 text-ink-3"
          }`}
        >
          <Icon name={icon} size={17} />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-ink">{title}</span>
          <span className="block text-xs text-ink-3 leading-relaxed">{blurb}</span>
        </span>
      </button>

      {selected && <div className="space-y-3 border-t border-hairline p-4 pt-3">{children}</div>}
    </div>
  );
}

export default function WelcomePage() {
  return (
    <React.Suspense fallback={null}>
      <WelcomeInner />
    </React.Suspense>
  );
}
