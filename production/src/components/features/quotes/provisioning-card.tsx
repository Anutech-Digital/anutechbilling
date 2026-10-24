"use client";

/**
 * What still has to be set up at the vendor, and a way to mark it done.
 *
 * ─── IT SAYS OUT LOUD THAT NOTHING IS AUTOMATIC ─────────────────────────────
 * The brief calls for "zero-touch provisioning". No Google CSP or Microsoft Partner
 * Center credential exists on this project, so nothing here calls a vendor. This card
 * says that in the first line rather than presenting manual work as an integration —
 * a rep who believes seats were created automatically will not create them, and the
 * customer finds out.
 *
 * The completion buttons are therefore real: a human did the work, a human records it,
 * and the name and timestamp are stored. When a vendor API is connected, the same rows
 * flow through it and this card starts showing progress instead of buttons.
 */
import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ProvisioningTask, QuoteLineItem } from "@/lib/supabase/database.types";
import { planProvisioning, provisionTaskTitle, vendorLabel, type ProvisionVendor } from "@/lib/provisioning/plan";
import { useExpandProvisioning, useUpdateProvisioning } from "@/lib/queries/provisioning";
import { useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { stampPaymentDomain } from "@/lib/payments/after-payment-fill";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { useQuote } from "@/lib/queries/quotes";
import { quotePaymentState, partPaidLine, type QuoteMoneyState } from "@/lib/quotes/quote-payment-state";

/**
 * R-1730 — should the "Setting up" card ask for the customer's domain? Record payment no longer
 * does (setup, not money — UI rule 7), so this is where a domain nobody knew yet is entered:
 * only when something is to be set up and no domain is known anywhere the set-up list reads
 * (the quote, a line, a task).
 */
export function needsDomainSetup(args: {
  tasks: ReadonlyArray<{ status: string | null; vendor: string | null; domain: string | null }>;
  quoteDomain: string | null;
  planItems: ReadonlyArray<{ domain: string | null }>;
}): boolean {
  const { tasks, quoteDomain, planItems } = args;
  if (tasks.length === 0 || tasks.every((t) => t.status === "not_required")) return false;
  if (planItems.length === 0 && !tasks.some((t) => t.vendor)) return false;
  if (quoteDomain?.trim()) return false;
  if (tasks.some((t) => t.domain?.trim())) return false;
  return !planItems.some((i) => i.domain?.trim());
}

/**
 * R-1689 — the first line of the "Setting up" box, from the quote's MONEY (R-1710's
 * quotePaymentState), never assumed. The set-up task is also raised when a quote is activated
 * before payment ("Activate now, pay later" / credit), and the box said "This quote is paid."
 * on Q-F588-27-0018 while nothing had come in. `money` null = the quote is not read yet: no
 * claim about payment at all.
 */
export function setupBoxLine(money: Pick<QuoteMoneyState, "state" | "received" | "due"> | null, productCount: number): string {
  const what = productCount > 0
    ? `${productCount} ${productCount === 1 ? "product" : "products"} to set up.`
    : "Nothing on it looks like a product that needs setting up.";
  if (!money) return what;
  if (money.state === "paid") return `This quote is paid. ${what}`;
  if (money.state === "part-paid") return `Part paid — ${partPaidLine(money)}. ${what}`;
  return `Not paid yet — set up before payment. ${what}`;
}

/** R-1730: the domain field on the card — saves to the quote's subscription, customer and task. */
function DomainSetupField({ quoteId }: { quoteId: string }) {
  const qc = useQueryClient();
  const [value, setValue] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const save = async () => {
    const domain = value.trim().toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      toast.error("Domain not saved — enter it like acme.com");
      return;
    }
    setSaving(true);
    try {
      const r = await stampPaymentDomain(createClient(), { quoteId, domain });
      if (r.subscription || r.customer || r.task) {
        toast.success(`Domain ${domain} saved`);
        qc.invalidateQueries({ queryKey: ["provisioning"] });
        qc.invalidateQueries({ queryKey: ["subscriptions"] });
        qc.invalidateQueries({ queryKey: ["customers"] });
        qc.invalidateQueries({ queryKey: ["quotes", quoteId] });
      } else {
        toast.error("Domain not saved", { description: "The subscription, customer and set-up task already have a domain, or could not be updated. Check Subscriptions." });
      }
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mb-3 rounded-lg border border-hairline bg-paper p-3 space-y-2">
      <FormField label="Customer domain" htmlFor="setup-domain">
        <Input
          id="setup-domain"
          placeholder="e.g. acme.com"
          className="font-mono text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }}
        />
      </FormField>
      <p className="text-2xs text-ink-3">Needed to set up Google Workspace / Microsoft 365. Saved on the subscription and the customer.</p>
      <Button size="sm" variant="default" loading={saving} disabled={!value.trim()} onClick={() => void save()}>
        Save domain
      </Button>
    </div>
  );
}

export function ProvisioningCard({ tasks, quoteId, tenantId, lines, quoteDomain, userId }: {
  tasks: ProvisioningTask[];
  quoteId: string;
  tenantId: string;
  lines: QuoteLineItem[];
  quoteDomain: string | null;
  userId?: string;
}) {
  const expand = useExpandProvisioning();
  const update = useUpdateProvisioning();
  /* R-1689: the quote's money state — the same cached read as the quote page (["quotes", id]). */
  const { data: quote } = useQuote(quoteId);
  const money = quote ? quotePaymentState(quote) : null;

  /* The trigger's unresolved row: raised on payment, not yet turned into per-line
     work. Recognised by having no vendor. */
  const placeholder = tasks.find((t) => !t.vendor && t.status === "pending");
  const real = tasks.filter((t) => t.vendor);
  /* R-1730: a domain saved on this card lands on the placeholder task — the set-up list uses it. */
  const taskDomain = tasks.find((t) => t.domain?.trim())?.domain ?? null;
  const plan = React.useMemo(
    () => planProvisioning({ lines, fallbackDomain: quoteDomain?.trim() ? quoteDomain : taskDomain }),
    [lines, quoteDomain, taskDomain],
  );
  const askDomain = needsDomainSetup({ tasks, quoteDomain, planItems: plan.items });

  if (tasks.length === 0) return null;

  const notRequired = tasks.every((t) => t.status === "not_required");

  return (
    <Card title="Setting up" sub="Seats to create at the vendor">
      {/* The honesty line. First thing, every time. */}
      <p className="mb-3 flex items-start gap-1.5 rounded-md bg-paper-2/60 px-2.5 py-2 text-2xs leading-snug text-ink-2">
        <Icon name="alert" size={12} className="mt-px shrink-0 text-ink-3" />
        <span>
          No reseller API is connected on this account, so these seats are created by hand.
          Nothing below happens automatically.
        </span>
      </p>

      {askDomain && <DomainSetupField quoteId={quoteId} />}

      {notRequired && (
        <p className="text-sm text-ink-3">Nothing on this quote needs setting up.</p>
      )}

      {placeholder && (
        <div className="rounded-lg border border-hairline bg-paper p-3">
          <p className="text-sm text-ink">
            {setupBoxLine(money, plan.items.length)}
          </p>
          {plan.skipped.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {plan.skipped.map((s) => (
                <li key={s.name} className="text-2xs leading-snug text-ink-3">
                  · <b className="text-ink-2">{s.name}</b> — {s.reason}
                </li>
              ))}
            </ul>
          )}
          <Button
            size="sm"
            className="mt-3"
            loading={expand.isPending}
            onClick={() =>
              expand.mutate(
                {
                  placeholderId: placeholder.id,
                  tenantId,
                  quoteId,
                  items: plan.items.map((i) => ({
                    vendor: i.vendor, plan: i.plan, seats: i.seats, domain: i.domain, mode: i.mode,
                  })),
                },
                { onSuccess: () => toast.success(plan.items.length ? "Set-up list ready." : "Marked as nothing to set up.") },
              )
            }
          >
            {plan.items.length > 0 ? "Build the set-up list" : "Mark as nothing to set up"}
          </Button>
        </div>
      )}

      {real.length > 0 && (
        <ul className="space-y-2">
          {real.map((t) => {
            const done = t.status === "done" || t.status === "not_required";
            return (
              <li
                key={t.id}
                className={cn(
                  "rounded-lg border p-3",
                  t.status === "failed" ? "border-rose/40 bg-rose-soft/30" : "border-hairline bg-paper",
                  done && "opacity-70",
                )}
              >
                <div className="flex items-start gap-2">
                  <Icon
                    name={done ? "check_circle" : t.status === "failed" ? "alert" : "clock"}
                    size={14}
                    className={cn("mt-0.5 shrink-0", done ? "text-emerald" : t.status === "failed" ? "text-rose" : "text-ink-3")}
                  />
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm text-ink", done && "line-through")}>
                      {provisionTaskTitle({
                        vendor: (t.vendor ?? "other") as ProvisionVendor,
                        plan: t.plan ?? "—",
                        seats: t.seats ?? 0,
                        domain: t.domain,
                        mode: "manual",
                      })}
                    </p>
                    <p className="mt-0.5 text-2xs text-ink-3">
                      {vendorLabel((t.vendor ?? "other") as ProvisionVendor)}
                      {t.completed_at && ` · done ${new Date(t.completed_at).toLocaleDateString("en-IN")}`}
                    </p>
                    {t.error_message && (
                      <p className="mt-1 text-2xs leading-snug text-rose">{t.error_message}</p>
                    )}
                  </div>
                </div>

                {!done && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: t.id, status: "done", userId })}
                    >
                      Mark created
                    </Button>
                    {t.status !== "in_progress" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={update.isPending}
                        onClick={() => update.mutate({ id: t.id, status: "in_progress", userId })}
                      >
                        Started
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: t.id, status: "not_required", userId })}
                    >
                      Not needed
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
