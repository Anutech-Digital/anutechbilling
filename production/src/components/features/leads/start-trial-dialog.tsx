/**
 * StartTrialDialog — internal trial-start form for Pardeep.
 *
 * Used when a customer phones in directly asking for a trial — no need
 * to make them fill the public /buy/workspace form. Pardeep enters the
 * details himself in 30 seconds, lead is created with stage='trial',
 * trial dates set, follow-up tasks auto-scheduled.
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetFooter } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

type Tier = "starter" | "standard" | "plus" | "enterprise";

const TIERS: { id: Tier; label: string; sublabel: string }[] = [
  { id: "starter",    label: "Starter",    sublabel: "30 GB · basic email" },
  { id: "standard",   label: "Standard",   sublabel: "2 TB · meet recording" },
  { id: "plus",       label: "Plus",       sublabel: "5 TB · vault · attendance" },
  { id: "enterprise", label: "Enterprise", sublabel: "Custom · advanced security" },
];

export default function StartTrialDialog({ open, onOpenChange }: Props) {
  const router = useRouter();
  const qc     = useQueryClient();
  const [submitting, setSubmitting] = React.useState(false);

  // Form state
  const [companyName,  setCompanyName]  = React.useState("");
  const [fullName,     setFullName]     = React.useState("");
  const [email,        setEmail]        = React.useState("");
  const [phone,        setPhone]        = React.useState("");
  const [domain,       setDomain]       = React.useState("");
  const [seats,        setSeats]        = React.useState("10");
  const [tierId,       setTierId]       = React.useState<Tier>("standard");
  const [message,      setMessage]      = React.useState("");

  const reset = () => {
    setCompanyName(""); setFullName(""); setEmail(""); setPhone("");
    setDomain(""); setSeats("10"); setTierId("standard"); setMessage("");
  };

  const onSubmit = async () => {
    if (!companyName.trim() || !fullName.trim() || !email.trim() || !phone.trim() || !domain.trim()) {
      toast.error("Company, contact name, email, phone, and domain are required");
      return;
    }
    setSubmitting(true);
    try {
      const res  = await fetch("/api/leads/start-trial", {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify({
          fullName:    fullName.trim(),
          companyName: companyName.trim(),
          email:       email.trim(),
          phone:       phone.trim(),
          seats:       Number(seats) || 10,
          domain:      domain.trim(),
          tierId,
          message:     message.trim() || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not start trial");
        return;
      }
      toast.success(
        `Trial started · ${json.leadId} · ${json.seats} ${json.tier} seats · ${json.tasksCreated} reminder tasks`,
      );
      // Invalidate caches FIRST so the deep-link finds the new lead
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["leads"] }),
        qc.invalidateQueries({ queryKey: ["trials"] }),
        qc.invalidateQueries({ queryKey: ["tasks"] }),
      ]);
      reset();
      onOpenChange(false);
      // Take operator to the lead drawer to verify
      router.push(`/leads?lead=${json.leadId}` as never);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-[520px] md:max-w-[600px] p-0 flex flex-col overflow-x-hidden"
      >
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-amber-ink mb-1">
            Workspace · Start 14-day trial
          </p>
          <h2 className="font-serif text-2xl text-ink">New trial</h2>
          <p className="text-xs text-ink-3 mt-1">
            Customer asked over phone/email — fill in their details. We'll create a lead at <Badge size="sm" kind="warning" dot>trial</Badge> stage
            and schedule the 3 follow-up reminders automatically.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <Label>Company name *</Label>
            <Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Acme Pvt Ltd" />
          </div>
          <div>
            <Label>Contact name *</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Ramesh Kumar" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <Label>Email *</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="e.g. ramesh@acme.in" />
          </div>
          <div>
            <Label>Phone *</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 98765 43210" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <Label>Domain *</Label>
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="e.g. acme.in" className="font-mono" />
            <p className="text-[10px] text-ink-3 mt-1">For provisioning in Google CSP</p>
          </div>
          <div>
            <Label>Seats</Label>
            <Input type="number" min={1} max={300} value={seats} onChange={(e) => setSeats(e.target.value)} className="font-mono" />
          </div>
        </div>

        <Label>Tier</Label>
        <div className="grid grid-cols-4 gap-2 mb-4">
          {TIERS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTierId(t.id)}
              className={cn(
                "border rounded-md p-2 text-left transition-colors",
                tierId === t.id
                  ? "border-amber bg-amber-soft text-amber-ink"
                  : "border-hairline bg-paper hover:border-hairline-strong text-ink-2",
              )}
            >
              <p className="font-medium text-sm">{t.label}</p>
              <p className="text-[10px] text-ink-3 mt-0.5">{t.sublabel}</p>
            </button>
          ))}
        </div>

        <Label>Notes (optional)</Label>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="What did they ask for over the phone?"
          className="w-full text-sm bg-paper border border-hairline rounded px-3 py-2 mb-4 resize-none focus:outline-none focus:ring-1 focus:ring-amber"
        />

        <div className="bg-paper-2 rounded-md p-3 mb-4 text-xs text-ink-3 leading-relaxed">
          <p className="font-medium text-ink-2 mb-1">What happens next:</p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>Lead created at <b>trial</b> stage</li>
            <li>3 reminder tasks scheduled: Day 7 (check-in), Day 12 (conversion call), Day 14 (final)</li>
            <li>Trial appears on Subscriptions page + Dashboard widget</li>
            <li>You provision the licenses in Google Reseller Console manually</li>
          </ol>
        </div>

        </div>  {/* close scrollable body */}

        <SheetFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" icon="check_circle" onClick={onSubmit} disabled={submitting}>
            {submitting ? "Starting trial…" : "Start 14-day trial"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
