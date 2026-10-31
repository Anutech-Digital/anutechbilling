/**
 * R-2299 (G-TEAMCHAT TC-06) — safe linkify for team chat message bodies.
 *
 * A body is PLAIN TEXT: no markdown, no HTML. The screen renders each part as a React text node
 * (escaped) and only these two shapes become an <a>:
 *   - http:// or https:// URLs (no user:password@ part) → open in a new tab, rel noopener;
 *   - app-internal paths like /quotes/<id> → same tab. A path must start the text or follow a
 *     space/bracket, start with a lowercase segment, and never be `//…` or `/\…` (which a
 *     browser would read as another site).
 * Anything else — javascript:, data:, ftp:, mailto: — stays text. Trailing . , ; : ! ? ) ' "
 * are left out of a link, so "see https://x.in." links https://x.in.
 */

export type ChatTextPart =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; href: string; external: boolean };

const MAX_LINK = 2000;
/* A URL or an app path, each preceded by start/space/bracket (group 1). */
const TOKEN = /(^|[\s([{"'])((?:https?:\/\/[^\s<>"'`]+)|(?:\/[a-z][a-z0-9-]*(?:\/[^\s<>"'`\\]*)?))/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

function safeExternal(raw: string): string | null {
  if (raw.length > MAX_LINK) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    return raw;
  } catch {
    return null;
  }
}

function safeInternal(raw: string): string | null {
  if (raw.length > MAX_LINK) return null;
  if (!/^\/[a-z]/.test(raw) || raw.startsWith("//") || raw.includes("\\")) return null;
  return raw;
}

/** Split a message body into text and safe link parts; joining every part's text gives the body back. */
export function linkifyChatText(body: string): ChatTextPart[] {
  const parts: ChatTextPart[] = [];
  let text = "";
  let last = 0;
  const flushText = () => {
    if (text) parts.push({ kind: "text", text });
    text = "";
  };
  for (const m of body.matchAll(TOKEN)) {
    const start = (m.index ?? 0) + m[1].length;
    let token = m[2];
    const trail = token.match(TRAILING)?.[0] ?? "";
    if (trail) token = token.slice(0, -trail.length);
    const external = /^https?:/i.test(token);
    const href = external ? safeExternal(token) : safeInternal(token);
    if (!href || !token) continue;
    text += body.slice(last, start);
    flushText();
    parts.push({ kind: "link", text: token, href, external });
    last = start + token.length;
  }
  text += body.slice(last);
  flushText();
  return parts;
}
