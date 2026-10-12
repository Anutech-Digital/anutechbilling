/**
 * The dev-only "demo accounts" panel, shared by the staff sign-in page and the
 * customer portal's.
 *
 * ─── WHY THIS IS A COMPONENT AND NOT COPIED MARKUP ───────────────────────────
 * It started as one panel on /login. A second was written for /portal/login by
 * hand, and within a day the two had drifted in three ways that all read as
 * sloppiness rather than intent: the portal one lost the list wrapper so its
 * rows sat tighter, its second label was a lighter weight where the staff one
 * keeps a single weight, and its footer was a bare paragraph against a titled
 * block. None of that was decided; it was just two people typing Tailwind.
 *
 * Both panels look the same because they ARE the same. Anything that should
 * differ between them is a prop.
 *
 * ─── IT DOES NOT GATE ITSELF ─────────────────────────────────────────────────
 * The caller decides whether to render this, because the two pages have
 * different conditions: /login also waits on `isSupabaseConfigured()`, and
 * /portal/login only shows it on the email step. A component that hid itself
 * would make those conditions invisible at the call site.
 *
 * Every caller MUST still gate on `process.env.NODE_ENV !== "production"`.
 * The rows print real credentials.
 */
import * as React from "react";
import { Icon } from "@/components/ui/icon";

export interface DevDemoEntry {
  /** Bold first line. Keep qualifiers inside it — "Demo Co · Owner"
   *  is ONE label, not a label plus a lighter suffix. */
  label: string;
  /** Second line, monospaced — the address, and the credential when there is one. */
  mono?: React.ReactNode;
  /** Second line, prose. Use instead of `mono` when the row explains rather than fills. */
  note?: React.ReactNode;
  /** Fills the form. Omit when the row navigates instead. */
  onClick?: () => void;
  /** Navigates. Omit when the row fills the form instead. */
  href?: string;
  /**
   * The row leaves this app. Appends an arrow AND opens in a new tab, the same
   * pairing `NavItem.external` uses in lib/nav.ts — the arrow is a promise about
   * what the click does, so the two must not come apart.
   */
  external?: boolean;
}

function EntryBody({ entry }: { entry: DevDemoEntry }) {
  return (
    <>
      <div className="font-medium text-ink">
        {entry.label}
        {entry.external && (
          <Icon name="external" size={11} className="inline ml-1 mb-0.5 text-ink-3" />
        )}
      </div>
      {entry.mono && (
        <div className="text-2xs text-ink-3 font-mono">{entry.mono}</div>
      )}
      {entry.note && <div className="text-2xs text-ink-3">{entry.note}</div>}
    </>
  );
}

/** One row. A button when it fills the form, an anchor when it navigates. */
function Entry({ entry }: { entry: DevDemoEntry }) {
  const shared = "w-full text-left rounded px-2 py-1.5 hover:bg-indigo/10 transition-colors";

  if (entry.href) {
    return (
      <a
        href={entry.href}
        className={`block ${shared}`}
        target={entry.external ? "_blank" : undefined}
        rel={entry.external ? "noopener noreferrer" : undefined}
      >
        <EntryBody entry={entry} />
      </a>
    );
  }
  return (
    <button type="button" onClick={entry.onClick} className={shared}>
      <EntryBody entry={entry} />
    </button>
  );
}

export interface DevDemoPanelProps {
  /** Completes "Dev mode — …". e.g. "demo accounts", "demo customer". */
  title: string;
  /** Right of the title, muted. Defaults to the autofill hint. */
  hint?: string;
  entries: DevDemoEntry[];
  /** Rows below a divider — a related link, or a note about a second factor. */
  footer?: DevDemoEntry[];
  /** Free-form line below everything, for prose that is not a row. */
  footnote?: React.ReactNode;
}

export function DevDemoPanel({
  title,
  hint = "· click to autofill",
  entries,
  footer,
  footnote,
}: DevDemoPanelProps) {
  return (
    <div className="mb-4 p-3 bg-indigo-50 border border-indigo/30 rounded-md text-xs">
      <div className="flex items-start gap-2 mb-2">
        <Icon name="info" size={14} className="text-indigo flex-shrink-0 mt-0.5" />
        <div className="text-indigo flex-1">
          <b>Dev mode — {title}</b>
          <span className="text-ink-3 ml-1">{hint}</span>
        </div>
      </div>

      <ul className="space-y-1.5">
        {entries.map((e) => (
          <li key={e.label}>
            <Entry entry={e} />
          </li>
        ))}
      </ul>

      {footer && footer.length > 0 && (
        <ul className="mt-2 pt-2 border-t border-indigo/20 space-y-1.5">
          {footer.map((e) => (
            <li key={e.label}>
              <Entry entry={e} />
            </li>
          ))}
        </ul>
      )}

      {footnote && (
        <p className="mt-2 pt-2 border-t border-indigo/20 text-2xs text-ink-3">{footnote}</p>
      )}
    </div>
  );
}
