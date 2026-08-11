/**
 * Contact detail — the full profile for one of the owner's people.
 *
 * Purpose-built for outreach: reach them (email / call / WhatsApp), advertise to
 * them (social links), and meet them (address → maps). Everything is editable via
 * the ContactForm. Backed by the standalone `contacts` table.
 */
"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";

import { useContact, useDeleteContact } from "@/lib/queries/contacts";
import { ContactForm } from "@/components/features/contacts/contact-form";
import { ContactCompanyPanel } from "@/components/features/contacts/contact-company-panel";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { initials, formatDate, cn } from "@/lib/utils";

// ── Social handle → full URL. Accepts a full URL, a bare domain path, or a
//    @handle and produces a clickable https link. ──────────────────────────
function ensureHttp(v: string) {
  return /^https?:\/\//i.test(v) ? v : `https://${v.replace(/^\/+/, "")}`;
}
function handle(v: string) {
  return v.trim().replace(/^@/, "").replace(/\/+$/, "");
}
function socialUrl(kind: "linkedin" | "instagram" | "facebook" | "twitter" | "website", v: string): string {
  const t = v.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (kind === "website")  return ensureHttp(t);
  if (t.includes(".com") || t.includes(".in") || t.includes("/")) return ensureHttp(t);
  const h = handle(t);
  switch (kind) {
    case "linkedin":  return `https://linkedin.com/in/${h}`;
    case "instagram": return `https://instagram.com/${h}`;
    case "facebook":  return `https://facebook.com/${h}`;
    case "twitter":   return `https://x.com/${h}`;
  }
}

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: contact, isLoading, error } = useContact(params.id);
  const del = useDeleteContact();
  const confirm = useConfirm();
  const [editOpen, setEditOpen] = React.useState(false);

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[900px] mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Skeleton className="h-14 w-14 rounded-full" />
          <Skeleton className="h-8 w-56" />
        </div>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error || !contact) {
    return (
      <div className="p-8">
        <EmptyState
          icon="user"
          title="Contact not found"
          body={error?.message ?? "This contact may have been deleted."}
          action={<Button icon="arrow_left" onClick={() => router.push("/contacts" as never)}>Back to Contacts</Button>}
        />
      </div>
    );
  }

  const phoneDigits = (n?: string | null) => (n ?? "").replace(/\D/g, "");
  const waNum = (() => {
    const d = phoneDigits(contact.whatsapp || contact.phone);
    return d.length === 10 ? `91${d}` : d;
  })();
  const waFor = (n: string) => {
    const d = phoneDigits(n);
    return d.length === 10 ? `91${d}` : d;
  };
  // All emails/phones (fall back to the legacy single primary for old contacts).
  const emails = contact.emails?.length ? contact.emails : (contact.email ? [{ value: contact.email, label: "other" }] : []);
  const phones = contact.phones?.length ? contact.phones : (contact.phone ? [{ value: contact.phone, label: "mobile" }] : []);

  const socials: { kind: "linkedin" | "instagram" | "facebook" | "twitter"; icon: string; label: string; value: string | null }[] = [
    { kind: "linkedin",  icon: "link",     label: "LinkedIn",  value: contact.linkedin },
    { kind: "instagram", icon: "user",     label: "Instagram", value: contact.instagram },
    { kind: "facebook",  icon: "users",    label: "Facebook",  value: contact.facebook },
    { kind: "twitter",   icon: "message",  label: "X / Twitter", value: contact.twitter },
  ];
  const hasSocial = socials.some((s) => s.value) || contact.website;

  async function handleDelete() {
    if (!contact) return;
    if (!(await confirm({ title: `Delete contact "${contact.full_name}"?`, body: "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
    del.mutate(contact.id, { onSuccess: () => router.push("/contacts" as never) });
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[900px] mx-auto space-y-5">
      {/* Back */}
      <button
        onClick={() => router.push("/contacts" as never)}
        className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink transition-colors"
      >
        <Icon name="arrow_left" size={14} /> Contacts
      </button>

      {/* Identity header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-4 min-w-0">
          <Avatar initials={initials(contact.full_name) || "?"} color="amber" size="lg" />
          <div className="min-w-0">
            <h1 className="font-serif text-2xl md:text-3xl text-ink leading-tight truncate">{contact.full_name}</h1>
            <p className="text-sm text-ink-2 mt-0.5 truncate">
              {[contact.title, contact.company].filter(Boolean).join(" · ") || <span className="text-ink-3 italic">No company yet</span>}
            </p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              <Badge kind="muted" size="sm" dot>Contact</Badge>
              {contact.city && <span className="text-[11px] text-ink-3 inline-flex items-center gap-1"><Icon name="globe" size={11} /> {contact.city}</span>}
              <span className="text-[11px] text-ink-3">Added {formatDate(contact.created_at)}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button size="sm" icon="edit" onClick={() => setEditOpen(true)}>Edit</Button>
          <IconButton icon="trash" aria-label="Delete contact" onClick={handleDelete} />
        </div>
      </div>

      {/* Company — full records of the linked customer company */}
      {contact.customer_id && <ContactCompanyPanel customerId={contact.customer_id} />}

      {/* Reach — primary actions */}
      <Panel title="Reach out">
        <div className="flex flex-wrap gap-2">
          <ReachButton show={!!contact.phone}    href={`tel:${contact.phone}`}                     icon="call"     label="Call"     tone="emerald" />
          <ReachButton show={!!waNum}            href={`https://wa.me/${waNum}`}   external          icon="whatsapp" label="WhatsApp" tone="emerald" />
          <ReachButton show={!!contact.email}    href={`mailto:${contact.email}`}                   icon="mail"     label="Email"    tone="amber" />
          <ReachButton show={!!contact.website}  href={contact.website ? socialUrl("website", contact.website) : "#"} external icon="globe" label="Website" tone="slate" />
        </div>
        <div className="mt-4 space-y-3">
          {/* All phones — each with its label + call/WhatsApp shortcuts */}
          {phones.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3 mb-1.5">Phones</div>
              <ul className="space-y-1">
                {phones.map((p, i) => (
                  <li key={`ph-${i}`} className="flex items-center gap-2 text-sm">
                    <span className="inline-flex items-center rounded-full bg-paper-2 text-ink-3 text-[10px] uppercase tracking-wide px-1.5 py-0.5 w-14 justify-center shrink-0">{p.label}</span>
                    <span className="font-mono text-ink truncate">{p.value}</span>
                    <a href={`tel:${p.value}`} className="ml-auto shrink-0 text-emerald hover:text-emerald/80" aria-label={`Call ${p.value}`}><Icon name="call" size={15} /></a>
                    <a href={`https://wa.me/${waFor(p.value)}`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-emerald hover:text-emerald/80" aria-label={`WhatsApp ${p.value}`}><Icon name="whatsapp" size={15} /></a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* All emails — each with its label + a mail shortcut */}
          {emails.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-ink-3 mb-1.5">Emails</div>
              <ul className="space-y-1">
                {emails.map((e, i) => (
                  <li key={`em-${i}`} className="flex items-center gap-2 text-sm">
                    <span className="inline-flex items-center rounded-full bg-paper-2 text-ink-3 text-[10px] uppercase tracking-wide px-1.5 py-0.5 w-14 justify-center shrink-0">{e.label}</span>
                    <span className="font-mono text-ink truncate">{e.value}</span>
                    <a href={`mailto:${e.value}`} className="ml-auto shrink-0 text-amber-ink hover:text-amber" aria-label={`Email ${e.value}`}><Icon name="mail" size={15} /></a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
            <Field label="WhatsApp" value={contact.whatsapp} mono />
            <Field label="Website"  value={contact.website}  mono />
          </dl>
        </div>
      </Panel>

      {/* Social — for advertising / outreach */}
      {hasSocial && (
        <Panel title="Social media">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {socials.filter((s) => s.value).map((s) => (
              <a
                key={s.kind}
                href={socialUrl(s.kind, s.value!)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-3 rounded-lg border border-hairline bg-paper px-3 py-2.5 hover:border-hairline-strong hover:bg-paper-2 transition-colors group"
              >
                <span className="w-8 h-8 rounded-full grid place-items-center bg-paper-2 text-ink-2 group-hover:text-ink shrink-0">
                  <Icon name={s.icon} size={14} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs text-ink-3">{s.label}</span>
                  <span className="block text-sm text-ink truncate">{s.value}</span>
                </span>
                <Icon name="external" size={13} className="text-ink-3 ml-auto shrink-0" />
              </a>
            ))}
          </div>
        </Panel>
      )}

      {/* Where to meet */}
      {(contact.address || contact.city) && (
        <Panel title="Where to meet">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-ink-2 whitespace-pre-wrap min-w-0">
              {[contact.address, contact.city].filter(Boolean).join(", ")}
            </p>
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([contact.address, contact.city].filter(Boolean).join(", "))}`}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 inline-flex items-center gap-1.5 text-xs font-medium text-amber-ink hover:text-amber whitespace-nowrap"
            >
              <Icon name="globe" size={13} /> Open in Maps
            </a>
          </div>
        </Panel>
      )}

      {/* Personal — birthday / anniversary / nickname / family */}
      {(contact.birthday || contact.anniversary || contact.nickname || contact.family) && (
        <Panel title="Personal">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Field label="🎂 Birthday"    value={contact.birthday ? formatDate(contact.birthday) : null} />
            <Field label="💍 Anniversary" value={contact.anniversary ? formatDate(contact.anniversary) : null} />
            <Field label="Nickname"       value={contact.nickname} />
          </dl>
          {contact.family && (
            <div className="mt-3">
              <dt className="text-[11px] uppercase tracking-wider text-ink-3">Family</dt>
              <dd className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed mt-0.5">{contact.family}</dd>
            </div>
          )}
        </Panel>
      )}

      {/* Notes + tags */}
      {(contact.notes || (contact.tags && contact.tags.length > 0)) && (
        <Panel title="Notes">
          {contact.tags && contact.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {contact.tags.map((t) => (
                <span key={t} className="inline-flex items-center rounded-full bg-paper-2 text-ink-2 text-[11px] px-2 py-0.5">#{t}</span>
              ))}
            </div>
          )}
          {contact.notes && <p className="text-sm text-ink-2 whitespace-pre-wrap leading-relaxed">{contact.notes}</p>}
        </Panel>
      )}

      <ContactForm open={editOpen} onOpenChange={setEditOpen} contact={contact} />
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-hairline bg-card/40 bg-paper p-4 md:p-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 mb-3">{title}</h2>
      {children}
    </section>
  );
}

function ReachButton({
  show, href, external, icon, label, tone,
}: {
  show: boolean; href: string; external?: boolean; icon: string; label: string; tone: "emerald" | "amber" | "slate";
}) {
  if (!show) return null;
  return (
    <a
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
        tone === "emerald" && "border-emerald/30 text-emerald hover:bg-emerald-soft/50",
        tone === "amber" && "border-amber/30 text-amber-ink hover:bg-amber-soft/50",
        tone === "slate" && "border-hairline text-ink-2 hover:bg-paper-2",
      )}
    >
      <Icon name={icon} size={15} /> {label}
    </a>
  );
}

function Field({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wider text-ink-3">{label}</dt>
      <dd className={cn("text-sm text-ink truncate", mono && "font-mono", !value && "italic text-ink-3")}>
        {value || "—"}
      </dd>
    </div>
  );
}
