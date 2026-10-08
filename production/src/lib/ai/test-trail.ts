/**
 * AI Help as a test co-pilot (R-162, 5 Oct 2026).
 *
 * Pardeep: "AI Help ko itna advance banao ki ye meri testing ko fast aur fully automate kar
 * de — human intervention ki jarurat kam se kam ho."
 *
 * Three things a tester used to do by hand, now done by the app:
 *   1. remember what they did  → the TRAIL: clicks, page changes, errors shown, failed API
 *      calls — kept in the tab only, sent to the AI only when they ask or report;
 *   2. notice that something broke → an error in the trail lights AI Help up, and one tap
 *      turns the trail into a draft report (steps written from the trail, not from memory);
 *   3. look over a whole screen → the PAGE SCAN: text a person should never see (₹NaN,
 *      undefined, Invalid Date, [object Object]), broken images, a page wider than a phone,
 *      buttons with no name, requests that failed since the page opened.
 *
 * Pure functions only — what counts as a finding, how the trail is told to the model, when
 * two reports are the same bug. The DOM half lives in components/shared/page-scan.ts.
 *
 * Still not automated, on purpose: FILING. The draft is complete and one tap away, but a
 * person presses File — a report queue nobody looked at fills with noise and the real bug
 * hides in it (R-158 rule, kept).
 */

/** input_needed (R-176): the app asked the user to fill or choose something — not a bug. */
export type TrailKind = "page" | "click" | "error" | "api_fail" | "toast_error" | "input_needed";

export interface TrailEvent {
  kind: TrailKind;
  /** ms since epoch */
  at: number;
  /** what was clicked / which page / the error text / "POST /api/x → 500" */
  text: string;
  path: string;
}

export const TRAIL_MAX = 40;
export const TRAIL_TEXT_MAX = 200;

/** Add to the ring buffer: newest last, capped, the same click twice in a row folded into one. */
export function pushTrail(trail: readonly TrailEvent[], ev: TrailEvent): TrailEvent[] {
  const text = ev.text.replace(/\s+/g, " ").trim().slice(0, TRAIL_TEXT_MAX);
  if (!text) return trail as TrailEvent[];
  const last = trail[trail.length - 1];
  if (last && last.kind === ev.kind && last.text === text && last.path === ev.path && ev.at - last.at < 1500) return trail as TrailEvent[];
  return [...trail, { ...ev, text }].slice(-TRAIL_MAX);
}

export const isProblem = (e: TrailEvent) => e.kind === "error" || e.kind === "api_fail" || e.kind === "toast_error";

/** The class a toast carries when it only asks the user to fill something in (R-176). */
export const NEEDS_INPUT_CLASS = "toast-needs-input";

/**
 * Is this red toast a real failure, or the app asking for something the user left out?
 * (R-176, 6 Oct 2026: "Choose the new customer's state" turned AI Help red — "Error caught,
 * Report it" — for a form doing exactly its job. Testers got a bug button for every blank box.)
 *
 * A toast marked with NEEDS_INPUT_CLASS is always input. Otherwise, words of failure win
 * (not saved, failed, could not, denied, server…) — a real error must never be hidden — and
 * only then does "choose / select / add / required / is missing" mean input. Anything else
 * stays an error: when unsure, keep the button.
 */
export function classifyToast(text: string, marked = false): "input_needed" | "toast_error" {
  if (marked) return "input_needed";
  const t = text.replace(/\s+/g, " ").trim();
  if (/\b(not saved|wasn'?t saved|failed|failure|could ?n[o']t|cannot (load|save|connect|reach)|denied|forbidden|unauthori[sz]ed|permission|server|timed? ?out|went wrong|try again|crash|exception)\b|\b5\d\d\b|\b40[134]\b/i.test(t)) return "toast_error";
  if (/^(please )?(choose|select|pick|add|enter|fill|type|set|give|upload)\b/i.test(t)
    || /\b(is|are) (required|missing)|\brequired|can'?t be (blank|empty|before|after)|\bmust be\b/i.test(t)) return "input_needed";
  return "toast_error";
}

/**
 * A data: or blob: URL is read from memory — no request reaches any server. R-365, 7 Oct 2026:
 * the PDF engine's wasm loader fetches its own inlined data: URL, and a refusal there showed
 * up as "API FAILED … network error" although the PDF was made. Such fetches are never an
 * API failure, whether they reject or come back with an error status.
 */
export function isInPageUrl(url: string): boolean {
  return /^\s*(data|blob):/i.test(url);
}

/**
 * Which failed requests are worth a tester's attention. Framework chunks, the UX beacon and a
 * 401 after sign-out are noise; a 4xx from our own API or Supabase, and every 5xx, are not.
 */
export function apiFailureWorthNoting(url: string, status: number): boolean {
  if (status < 400 || isInPageUrl(url)) return false;
  let path = url;
  try { path = new URL(url, "http://x").pathname; } catch { /* keep raw */ }
  if (/\/_next\/|\/__nextjs|\/api\/public\/ux\/|\/monitoring|\/favicon/.test(path)) return false;
  // 401 = the session ended, not a bug on this screen. (403 stays: a refused save IS one.)
  if (status === 401) return false;
  return status >= 500 || /\/api\/|\/rest\/v1\/|\/auth\/v1\//.test(path);
}

/** "POST /api/quotes → 500" — the path only: no query string (it can carry ids or tokens). */
export function apiFailText(method: string, url: string, status: number): string {
  let path = url;
  try { path = new URL(url, "http://x").pathname; } catch { /* keep raw */ }
  return `${method.toUpperCase()} ${path.slice(0, 120)} → ${status || "network error"}`;
}

/** The trail as the model reads it: relative seconds, one event per line, problems marked. */
export function trailForPrompt(trail: readonly TrailEvent[], now = Date.now()): string {
  if (!trail.length) return "(nothing recorded yet)";
  return trail
    .slice(-TRAIL_MAX)
    .map((e) => {
      const ago = Math.max(0, Math.round((now - e.at) / 1000));
      const tag = { page: "OPENED", click: "CLICKED", error: "JS ERROR", api_fail: "API FAILED", toast_error: "ERROR SHOWN", input_needed: "ASKED USER TO FILL" }[e.kind];
      return `${isProblem(e) ? "!! " : ""}-${ago}s ${tag}: ${e.text}${e.kind === "page" ? "" : ` (on ${e.path})`}`;
    })
    .join("\n");
}

// ─── Page scan ──────────────────────────────────────────────────────────────────────────

export type FindingKind = "bad_text" | "broken_image" | "overflow" | "unnamed_button" | "api_fail" | "js_error" | "slow";

export interface Finding { kind: FindingKind; detail: string }

/**
 * Words that mean a value failed to render. Each is matched as a whole token so a customer
 * called "Nancy" or a product "Undefined Studio" does not trip it.
 */
const BAD_TEXT: { re: RegExp; label: string }[] = [
  { re: /₹\s?NaN|\bNaN\b/, label: "NaN" },
  { re: /\bundefined\b/, label: "undefined" },
  { re: /\bnull\b(?!\s*(?:and|or|value|check|safe))/i, label: "null" },
  { re: /\bInvalid Date\b/, label: "Invalid Date" },
  { re: /\[object Object\]/, label: "[object Object]" },
  { re: /\{\{\s*[\w.]+\s*\}\}/, label: "unfilled {{template}}" },
];

/** Visible text lines → findings, one per distinct problem with a short sample. */
export function badTextFindings(lines: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line.length > 400) continue;
    for (const b of BAD_TEXT) {
      if (!b.re.test(line)) continue;
      const key = b.label + "|" + line.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "bad_text", detail: `"${b.label}" on screen: ${line.slice(0, 120)}` });
    }
    if (out.length >= 10) break;
  }
  return out;
}

export const FINDINGS_MAX = 30;

/** Findings for the model, capped, grouped by kind. */
export function findingsForPrompt(f: readonly Finding[]): string {
  if (!f.length) return "(the automatic checks found nothing)";
  return f.slice(0, FINDINGS_MAX).map((x) => `- [${x.kind}] ${x.detail.slice(0, 220)}`).join("\n");
}

// ─── Same bug twice? ────────────────────────────────────────────────────────────────────

const STOP = new Set("the a an is on in of to and or for with par me mein ka ki ke hai nahi not when after page button".split(" "));
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}₹ ]+/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Share of the smaller title's words found in the other — 1 means same words. */
export function titleOverlap(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

/** An open report on the same page whose title says mostly the same thing. */
export function looksLikeSameBug(draft: { title: string; pagePath: string | null }, existing: { title: string; page_path: string | null }): boolean {
  const samePage = !draft.pagePath || !existing.page_path || existing.page_path === draft.pagePath;
  return samePage && titleOverlap(draft.title, existing.title) >= 0.6;
}
