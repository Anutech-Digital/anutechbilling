/**
 * Help & Tutorial center — a searchable guide to every feature, with examples.
 * Content lives in `lib/help/content.ts`. This page just renders + searches it.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { HELP_SECTIONS, type HelpSection, type HelpTopic } from "@/lib/help/content";

function topicMatches(t: HelpTopic, q: string): boolean {
  const hay = `${t.q} ${t.what} ${t.steps.join(" ")} ${t.example}`.toLowerCase();
  return hay.includes(q);
}

export default function HelpPage() {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState<string | null>(null);
  const q = query.trim().toLowerCase();

  const sections: (HelpSection & { topics: HelpTopic[] })[] = React.useMemo(() => {
    if (!q) return HELP_SECTIONS;
    return HELP_SECTIONS
      .map((s) => ({ ...s, topics: s.topics.filter((t) => topicMatches(t, q)) }))
      .filter((s) => s.topics.length > 0);
  }, [q]);

  const totalTopics = HELP_SECTIONS.reduce((n, s) => n + s.topics.length, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1000px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Help</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Help &amp; Tutorial</h1>
        <p className="text-sm text-ink-3 mt-1">
          A plain-language guide to every feature — what it is, the exact steps, and an example.
          New here? Start with <b>Getting started</b>, then <b>The money flow</b>.
        </p>
      </div>

      {/* Search */}
      <div className="mb-6">
        <Input
          aria-label="Search help topics"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          prefix={<Icon name="search" size={15} className="text-ink-3" />}
          placeholder={`Search ${totalTopics} help topics… (e.g. "credit note", "export", "payroll")`}
        />
      </div>

      {/* Quick section jump (hidden while searching) */}
      {!q && (
        <div className="flex flex-wrap gap-2 mb-6">
          {HELP_SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-paper px-3 py-1.5 text-xs font-medium text-ink-2 hover:border-amber-soft hover:text-amber-ink transition-colors"
            >
              <Icon name={s.icon} size={13} /> {s.title}
            </a>
          ))}
        </div>
      )}

      {sections.length === 0 ? (
        <Card>
          <p className="text-sm text-ink-3">
            No help topic matches “{query}”. Try another word, or clear the search to browse everything.
          </p>
        </Card>
      ) : (
        <div className="space-y-8">
          {sections.map((s) => (
            <section key={s.id} id={s.id} className="scroll-mt-20">
              <div className="flex items-center gap-2 mb-1">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-soft text-amber-ink">
                  <Icon name={s.icon} size={16} />
                </span>
                <h2 className="font-serif text-2xl">{s.title}</h2>
              </div>
              <p className="text-sm text-ink-3 mb-3 ml-10">{s.blurb}</p>

              <div className="space-y-2">
                {s.topics.map((t) => {
                  const key = `${s.id}::${t.q}`;
                  const isOpen = open === key || Boolean(q);
                  return (
                    <Card key={key} className="p-0 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setOpen(isOpen && !q ? null : key)}
                        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-paper-2/40 transition-colors"
                      >
                        <span className="font-medium text-ink">{t.q}</span>
                        {!q && <Icon name={isOpen ? "chevron_up" : "chevron_down"} size={16} className="text-ink-3 shrink-0" />}
                      </button>

                      {isOpen && (
                        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-hairline">
                          <p className="text-sm text-ink-2 leading-relaxed">{t.what}</p>

                          <div>
                            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Steps</p>
                            <ol className="list-decimal list-inside space-y-1 text-sm text-ink-2 marker:text-ink-3">
                              {t.steps.map((step, i) => <li key={i}>{step}</li>)}
                            </ol>
                          </div>

                          <div className="rounded-md bg-emerald-soft/40 border border-emerald/20 px-3 py-2">
                            <p className="text-3xs uppercase tracking-wider text-emerald-ink font-semibold mb-0.5">Example</p>
                            <p className="text-[13px] text-ink-2 leading-relaxed">{t.example}</p>
                          </div>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
