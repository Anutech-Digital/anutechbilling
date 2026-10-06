/**
 * IndiaMART leads — /marketing/indiamart (S34)
 *
 * The IndiaMART pull (cron /api/cron/indiamart-leads) existed, and so did the owner-only key
 * API (/api/leads/indiamart) — but the only way to save the key was to call that API by hand,
 * so no company could actually switch it on (AGENTS.md L17: an API the UI never calls is a
 * feature that does not exist). This screen is that caller: is a key saved, did the last pull
 * work, save / replace / remove the key, and where to get it.
 *
 * The key is typed into a password field that browsers are told not to fill, sent once in a
 * POST body, and never shown back — at most its last 4 characters. Wording and status logic:
 * lib/leads/indiamart-key.ts (tested). Owner-only, like the API; a manager who opens the URL
 * is told who can do it.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/providers/confirm-provider";
import { cn } from "@/lib/utils";
import {
  crmKeySchema, pullSummary, istDateTime, KEY_SOURCE_TEXT, PULL_SCHEDULE_TEXT,
  type CrmKeyInput, type IndiamartKeyStatus, type PullTone,
} from "@/lib/leads/indiamart-key";
import {
  useIndiamartKeyStatus, useSaveIndiamartKey, useRemoveIndiamartKey, IndiamartApiError,
} from "@/lib/leads/indiamart-key-queries";

const TONE_BOX: Record<PullTone, string> = {
  neutral: "border-hairline bg-paper-2/60",
  success: "border-emerald/30 bg-emerald-soft/30",
  warning: "border-amber/40 bg-amber-soft/30",
  danger: "border-rose/30 bg-rose-soft/30",
};
const TONE_ICON: Record<PullTone, { name: string; cls: string }> = {
  neutral: { name: "clock", cls: "text-ink-3" },
  success: { name: "check_circle", cls: "text-emerald" },
  warning: { name: "alert", cls: "text-amber-ink" },
  danger: { name: "alert", cls: "text-rose" },
};

export default function IndiamartLeadsPage() {
  const status = useIndiamartKeyStatus();
  const err = status.error;
  const notOwner = err instanceof IndiamartApiError && err.status === 403;

  return (
    <div className="mx-auto max-w-[960px] p-4 md:p-6 lg:p-8 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">IndiaMART leads</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-2xl">
          Every IndiaMART enquiry becomes a lead here automatically (source &quot;IndiaMART&quot;) — just save your
          CRM key once. The same enquiry never comes in twice.
        </p>
      </header>

      {status.isLoading ? (
        <div className="space-y-3">{[1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-lg" />)}</div>
      ) : notOwner ? (
        <Card><div className="space-y-2">
          <p className="font-medium text-ink">Only the workspace owner can open this setting</p>
          <p className="text-sm text-ink-2">
            The IndiaMART key unlocks the company's IndiaMART account, so only the owner can save or remove it.
            Ask the owner to save the key on this page.
          </p>
          <Link href={"/marketing" as Route} className="inline-block text-sm font-medium text-amber-ink hover:underline">← Marketing Hub</Link>
        </div></Card>
      ) : err ? (
        <Card><div className="space-y-3">
          <p className="font-medium text-ink">Could not load the IndiaMART setting</p>
          <p className="text-sm text-ink-2">{(err as Error).message}</p>
          <Button variant="default" icon="refresh" onClick={() => status.refetch()} loading={status.isFetching}>Try again</Button>
        </div></Card>
      ) : status.data ? (
        <>
          <StatusCard s={status.data} />
          <KeyForm s={status.data} />
        </>
      ) : null}

      <HelpCard />
    </div>
  );
}

function StatusCard({ s }: { s: IndiamartKeyStatus }) {
  const sum = pullSummary(s);
  const icon = TONE_ICON[sum.tone];
  return (
    <Card><div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">CRM key</p>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            {s.configured ? (
              <>
                <Badge kind="success" dot>Saved</Badge>
                {s.key_last4 && <span className="text-sm text-ink-2">last 4 characters <span className="font-mono text-ink">…{s.key_last4}</span></span>}
                {s.encrypted
                  ? <Badge kind="muted" size="sm"><Icon name="lock" size={10} className="mr-1" />Encrypted</Badge>
                  : <Badge kind="warning" size="sm">Not encrypted</Badge>}
              </>
            ) : (
              <Badge kind="muted" dot>Not saved</Badge>
            )}
          </div>
          {s.configured && !s.encrypted && (
            <p className="mt-2 text-xs text-amber-ink max-w-xl">
              SECRETS_MASTER_KEY is not set on the server, so the key is stored without encryption. Ask an admin to set it, then save the key again.
            </p>
          )}
        </div>
      </div>

      <div className={cn("rounded-lg border px-3 py-2.5 flex items-start gap-2", TONE_BOX[sum.tone])} role="status">
        <Icon name={icon.name} size={16} className={cn("mt-0.5 shrink-0", icon.cls)} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{sum.title}</p>
          <p className="text-xs text-ink-2 mt-0.5 break-words">{sum.detail}</p>
        </div>
      </div>

      {/* Nothing saved and nothing ever pulled: three boxes of "—" would only push the form down. */}
      {(s.configured || s.last_run_at || s.total_imported) ? (
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Stat label="Last pull" value={s.last_run_at ? istDateTime(s.last_run_at) : "Not yet"} />
        <Stat label="New leads in last pull" value={s.last_run_at ? String(s.last_imported ?? 0) : "—"} />
        <Stat
          label="Total IndiaMART leads"
          value={s.total_imported === null ? "—" : s.total_imported.toLocaleString("en-IN")}
          link={s.total_imported ? { href: "/leads", label: "View leads →" } : undefined}
        />
      </dl>
      ) : null}
    </div></Card>
  );
}

function Stat({ label, value, link }: { label: string; value: string; link?: { href: string; label: string } }) {
  return (
    <div className="rounded-md border border-hairline p-3">
      <dt className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</dt>
      <dd className="mt-1 font-serif text-xl text-ink tabular-nums">{value}</dd>
      {link && <dd><Link href={link.href as Route} className="text-xs text-amber-ink hover:underline">{link.label}</Link></dd>}
    </div>
  );
}

function KeyForm({ s }: { s: IndiamartKeyStatus }) {
  const save = useSaveIndiamartKey();
  const remove = useRemoveIndiamartKey();
  const confirm = useConfirm();
  const form = useForm<CrmKeyInput>({ resolver: zodResolver(crmKeySchema), defaultValues: { crm_key: "" } });
  const fieldError = form.formState.errors.crm_key?.message;

  const onSubmit = form.handleSubmit(async ({ crm_key }) => {
    try {
      await save.mutateAsync(crm_key);
      form.reset({ crm_key: "" });
    } catch {
      /* the mutation's onError already showed what to do; keep the typed value so they can retry */
    }
  });

  async function onRemove() {
    const ok = await confirm({
      title: "Remove the IndiaMART key?",
      body: "New IndiaMART enquiries will stop becoming leads. Leads that already came in stay as they are. Save the key again any time to turn it back on.",
      confirmLabel: "Yes, remove key",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (ok) remove.mutate();
  }

  return (
    <Card>
      <form onSubmit={onSubmit} autoComplete="off" noValidate className="space-y-3">
        <div>
          <p className="font-medium text-ink">{s.configured ? "Change key" : "Save CRM key"}</p>
          <p className="text-xs text-ink-3 mt-0.5">
            {s.configured
              ? "Paste the new key and save — it replaces the old one. A saved key is never shown here."
              : `Copy the key from ${KEY_SOURCE_TEXT} and paste it here.`}
          </p>
        </div>
        <FormField label="IndiaMART CRM key" htmlFor="indiamart_crm_key">
          <Input
            id="indiamart_crm_key"
            type="password"
            autoComplete="new-password"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            placeholder={s.configured ? "Paste new key" : "Paste key"}
            error={fieldError}
            {...form.register("crm_key")}
          />
        </FormField>
        <div className="flex items-center gap-2 flex-wrap">
          <Button type="submit" variant="primary" icon="check" loading={save.isPending} disabled={remove.isPending}>
            {save.isPending ? "Saving…" : s.configured ? "Save new key" : "Save key"}
          </Button>
          {s.configured && (
            <Button type="button" variant="ghost" className="text-rose-ink" onClick={onRemove} loading={remove.isPending} disabled={save.isPending}>
              Remove key
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

function HelpCard() {
  return (
    <Card><div className="space-y-2">
      <p className="font-medium text-ink">Where to find the key, and what happens next</p>
      <ol className="list-decimal pl-5 space-y-1 text-sm text-ink-2">
        <li>
          <a href="https://seller.indiamart.com" target="_blank" rel="noopener noreferrer" className="text-amber-ink hover:underline">
            IndiaMART Seller panel <Icon name="external" size={11} />
          </a>{" "}
          — sign in with the account that receives the enquiries.
        </li>
        <li>Open Lead Manager → <b className="font-medium text-ink">CRM API key</b> (sometimes labelled &quot;Import leads / CRM integration&quot;) → generate / copy the key.</li>
        <li>Paste it above and save. Enter the key only here — never send it to anyone on WhatsApp or email.</li>
      </ol>
      <ul className="list-disc pl-5 space-y-1 text-xs text-ink-3">
        <li>The app pulls new IndiaMART enquiries {PULL_SCHEDULE_TEXT}. The first pull brings the last 24 hours.</li>
        <li>Each enquiry becomes one lead — stage &quot;New&quot;, source &quot;IndiaMART&quot;. A repeated enquiry does not create a second lead.</li>
        <li>This IndiaMART connection is new: check the name / phone / note on the first few leads.</li>
      </ul>
    </div></Card>
  );
}
