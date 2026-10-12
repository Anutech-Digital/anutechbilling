/**
 * The Gmail-style search box: `from:testuser1 is:unread label:workspace seats`.
 *
 * Pure, so the parser can be tested without a mailbox — and so the page never has to
 * grow its own copy of "what does is:unread mean".
 *
 * ─── AN OPERATOR WE DO NOT SUPPORT IS REPORTED, NEVER IGNORED ───────────────
 * This is the whole reason the parser returns `unknown` instead of dropping what it
 * cannot read. A search box that silently ignores `is:important` returns EVERY email
 * and looks like it filtered — the rep reads the first twenty results believing they
 * are the important ones. Ignoring a filter is worse than refusing it, because the
 * result is indistinguishable from a filter that matched a lot.
 *
 * The caller shows `unknown` back to the rep. Nothing here decides how.
 *
 * ─── WHAT `label:` MEANS HERE ───────────────────────────────────────────────
 * `route` — the only label-shaped column inbound_emails has. There is no vendor or
 * tag column, so `label:google` matches a row routed as "google" and nothing else.
 * It is not a guess at the vendor from the subject line; a search that quietly
 * pattern-matched the body would return mail that merely MENTIONS Google.
 */

export interface ParsedSearch {
  /** Free-text terms, matched against subject, sender and body. */
  text: string[];
  /** `from:` — matched against sender email AND name. */
  from: string[];
  /** `to:` — matched against the recipient address. */
  to: string[];
  /** `label:` — matched against `route`. */
  label: string[];
  /** `is:unread` → false, `is:read` → true. Null when neither was asked for. */
  read: boolean | null;
  /** `is:starred` → true, `is:unstarred` → false. */
  starred: boolean | null;
  /** `has:attachment` → true. */
  hasAttachment: boolean | null;
  /** Operators typed but not supported. Shown to the rep, never silently dropped. */
  unknown: string[];
}

const EMPTY: ParsedSearch = {
  text: [], from: [], to: [], label: [],
  read: null, starred: null, hasAttachment: null, unknown: [],
};

/** Operators that take a free value. */
const VALUE_OPS = new Set(["from", "to", "label"]);

/**
 * Split on whitespace, but keep "quoted phrases" together — `from:"testuser1 Rao"` and
 * `"renewal quote"` are both single terms a rep would reasonably type.
 */
function tokenise(q: string): string[] {
  const out: string[] = [];
  /* The quoted part has to survive ATTACHED to its operator: `from:"testuser1 Rao"` is
     one token, not `from:"testuser1` and `Rao"`. A regex that only recognises a quote at
     the START of a token gets that wrong, because this token starts with `f`. */
  const re = /(?:[^\s:"]+:)?"[^"]*"|\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) out.push(m[0]);
  return out;
}

/** Strip one layer of surrounding double quotes. Quotes are removed where the value
 *  is read, not in the tokeniser — the parser has to find the operator's colon
 *  first, and that colon sits outside the quotes. */
function unquote(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseSearch(query: string): ParsedSearch {
  const q = (query ?? "").trim();
  if (!q) return { ...EMPTY };

  const parsed: ParsedSearch = {
    text: [], from: [], to: [], label: [],
    read: null, starred: null, hasAttachment: null, unknown: [],
  };

  for (const raw of tokenise(q)) {
    const colon = raw.indexOf(":");
    /* No colon, or a colon at the very start ( ":foo" ), is free text. An email
       address typed bare — user1@x.com — has no colon and stays free text, which is
       what a rep pasting an address expects to work. */
    /* A token that STARTS with a quote is a phrase, whatever is inside it — so
       `"re: renewal quote"` searches for that text and is not read as an operator
       called `"re`. */
    if (colon <= 0 || raw.startsWith('"')) {
      parsed.text.push(unquote(raw).toLowerCase());
      continue;
    }

    const op    = raw.slice(0, colon).toLowerCase();
    const value = unquote(raw.slice(colon + 1)).toLowerCase();

    /* `from:` with nothing after it is half-typed, not a filter. Treating it as
       "match every sender" would widen the search at the moment the rep thinks they
       are narrowing it. */
    if (VALUE_OPS.has(op)) {
      if (value) (parsed[op as "from" | "to" | "label"]).push(value);
      continue;
    }

    if (op === "is") {
      switch (value) {
        case "unread":   parsed.read = false;    break;
        case "read":     parsed.read = true;     break;
        case "starred":  parsed.starred = true;  break;
        case "unstarred":parsed.starred = false; break;
        default:         parsed.unknown.push(raw);
      }
      continue;
    }

    if (op === "has") {
      if (value === "attachment") parsed.hasAttachment = true;
      else parsed.unknown.push(raw);
      continue;
    }

    parsed.unknown.push(raw);
  }

  return parsed;
}

/** The fields a row must expose to be searchable. Kept structural so tests need no DB row. */
export interface SearchableEmail {
  from_email:      string | null;
  from_name:       string | null;
  to_email:        string | null;
  subject:         string | null;
  body_text:       string | null;
  route:           string | null;
  read_at:         string | null;
  starred:         boolean | null;
  attachment_name: string | null;
}

function has(hay: string | null | undefined, needle: string): boolean {
  return (hay ?? "").toLowerCase().includes(needle);
}

/**
 * Does this email satisfy the whole query?
 *
 * Every clause is AND — `from:testuser1 is:unread` means both, the way Gmail behaves.
 * Repeated operators are OR within themselves (`from:a from:b` = either sender),
 * because a rep listing two people means "either of them", not "a message from both".
 *
 * `unknown` operators are NOT applied — the caller has already been handed them to
 * show. Applying them as free text would match the literal string "is:important".
 */
export function matchesSearch(row: SearchableEmail, p: ParsedSearch): boolean {
  if (p.read !== null && (row.read_at != null) !== p.read) return false;
  if (p.starred !== null && (row.starred === true) !== p.starred) return false;
  if (p.hasAttachment === true && !row.attachment_name) return false;

  if (p.from.length && !p.from.some((f) => has(row.from_email, f) || has(row.from_name, f))) return false;
  if (p.to.length    && !p.to.some((t) => has(row.to_email, t))) return false;
  if (p.label.length && !p.label.some((l) => has(row.route, l))) return false;

  /* Free text is AND across terms: "renewal quote" should not match an email that
     only says "renewal". Each term may land in any field. */
  for (const t of p.text) {
    const hit = has(row.subject, t) || has(row.from_email, t)
             || has(row.from_name, t) || has(row.body_text, t);
    if (!hit) return false;
  }
  return true;
}

/** True when the query asks for nothing — used to skip filtering entirely. */
export function isEmptySearch(p: ParsedSearch): boolean {
  return p.text.length === 0 && p.from.length === 0 && p.to.length === 0
      && p.label.length === 0 && p.read === null && p.starred === null
      && p.hasAttachment === null;
}

/** The operators this box understands, for the rep-facing hint under the field. */
export const SUPPORTED_OPERATORS = [
  "from:", "to:", "label:", "is:unread", "is:read", "is:starred", "has:attachment",
] as const;
