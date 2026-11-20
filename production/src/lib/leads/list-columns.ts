/**
 * R-2970 (20 Nov 2026) — which columns the lead list shows, in what order, per person.
 *
 * Pardeep: phone and email should show in the list without opening the lead, and the
 * Columns menu should ADD columns, not only hide the fixed nine.
 *
 * The rules live here (tested in list-columns.test.ts); the grid, the row and the Columns
 * menu only read them:
 *   · `select` (checkbox) and `actions` (⋯) are not data columns — always first / last.
 *   · `contact` is the sticky identity column — always shown, always first.
 *   · Every other column can be added, removed and moved. Only fields the list row already
 *     carries (LEAD_LIST_COLUMNS in list-page.ts) are offered — no new data is fetched.
 *
 * ── Width decision (measured 20 Nov 2026, localhost, 1280×800 viewport) ──────────────
 * The grid's box is 1006px wide at 1280 (sidebar open). Natural widths of the cells
 * (widest real cell + padding): contact ~180 (name + badges, email moved out), phone ~120,
 * email ~190, company 127, stage 140, value 82, follow-up 98, owner 109, plan 325,
 * seats 64, wait 57, plus 40 + 44 for the checkbox and ⋯.
 * The default set below (contact, phone, email, company, stage, value, follow-up, owner)
 * needs ~1130px; the first fit squeezes the text columns into 1006 and keeps the atomic
 * ones (phone, value, follow-up) whole — fitToContainer's `keep`. Adding Plan (325) on top
 * could never fit, so Plan, Seats and Wait moved to "Add a column": a person who wants them
 * adds them, and the table then scrolls sideways with Contact sticky.
 */
import type { SortCol } from "@/lib/leads/list-selectors";

export type LeadColId =
  | "contact" | "phone" | "email" | "company" | "stage" | "value" | "followup" | "owner"
  | "plan" | "seats" | "wait" | "source" | "created" | "updated" | "domain";

export interface LeadColDef {
  id: LeadColId;
  /** Header text and the name in the Columns menu. */
  label: string;
  /** First-paint width (px) before the autofit measures the real cells, and the width a
   *  column gets when added to a table whose widths are already set. */
  px: number;
  /** Atomic text (a number, a date, a phone) — never wrapped, never squeezed by the fit. */
  atom: boolean;
  align?: "left" | "right";
  /** The sort key when the header is clicked; none → the header does not sort. */
  sort?: SortCol;
}

export const LEAD_COL_DEFS: readonly LeadColDef[] = [
  { id: "contact",  label: "Contact",      px: 180, atom: false, sort: "contact" },
  { id: "phone",    label: "Phone",        px: 120, atom: true,  sort: "phone" },
  { id: "email",    label: "Email",        px: 190, atom: false, sort: "email" },
  { id: "company",  label: "Company",      px: 130, atom: false, sort: "company" },
  { id: "stage",    label: "Stage",        px: 130, atom: true,  sort: "stage" },
  { id: "value",    label: "Value",        px: 90,  atom: true,  sort: "value", align: "right" },
  { id: "followup", label: "Follow-up",    px: 98,  atom: true,  sort: "followup" },
  { id: "owner",    label: "Owner",        px: 110, atom: false, sort: "owner" },
  { id: "plan",     label: "Plan",         px: 170, atom: false, sort: "plan" },
  { id: "seats",    label: "Seats",        px: 64,  atom: true,  sort: "seats", align: "right" },
  { id: "wait",     label: "Wait",         px: 70,  atom: true,  sort: "wait", align: "right" },
  { id: "source",   label: "Source",       px: 110, atom: false },
  { id: "created",  label: "Created",      px: 100, atom: true,  sort: "created" },
  { id: "updated",  label: "Last updated", px: 100, atom: true },
  { id: "domain",   label: "Domain",       px: 140, atom: false },
];

const BY_ID = new Map(LEAD_COL_DEFS.map((d) => [d.id, d]));
export const ALL_LEAD_COL_IDS: readonly LeadColId[] = LEAD_COL_DEFS.map((d) => d.id);

export function leadColDef(id: LeadColId): LeadColDef {
  return BY_ID.get(id)!;
}

export function isLeadColId(v: unknown): v is LeadColId {
  return typeof v === "string" && BY_ID.has(v as LeadColId);
}

/** The view a person gets before choosing anything — fits 1280 (see the width note above). */
export const DEFAULT_LEAD_COLS: readonly LeadColId[] = [
  "contact", "phone", "email", "company", "stage", "value", "followup", "owner",
];

/** The identity column: always shown, always first, never moved. */
export const LOCKED_COL: LeadColId = "contact";

/** Fixed-width control columns around the data columns. */
export const SELECT_COL = "select";
export const ACTIONS_COL = "actions";
export const CONTROL_PX = { select: 40, actions: 40 } as const;

/** Full render order: checkbox, the shown data columns, ⋯. */
export function renderOrder(shown: readonly LeadColId[]): string[] {
  return [SELECT_COL, ...shown, ACTIONS_COL];
}

/** Columns that can still be added, in the menu's order. */
export function addableColumns(shown: readonly LeadColId[]): LeadColId[] {
  const s = new Set(shown);
  return ALL_LEAD_COL_IDS.filter((id) => !s.has(id));
}

/** Contact first, known ids only, no repeats — whatever the input. */
export function normaliseShown(ids: readonly unknown[]): LeadColId[] {
  const out: LeadColId[] = [LOCKED_COL];
  for (const id of ids) {
    if (isLeadColId(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function addColumn(shown: readonly LeadColId[], id: LeadColId): LeadColId[] {
  return shown.includes(id) ? [...shown] : [...shown, id];
}

export function removeColumn(shown: readonly LeadColId[], id: LeadColId): LeadColId[] {
  if (id === LOCKED_COL) return [...shown];
  return shown.filter((c) => c !== id);
}

/** One step up (-1) or down (+1). Contact stays first, so nothing moves above it. */
export function moveColumn(shown: readonly LeadColId[], id: LeadColId, dir: -1 | 1): LeadColId[] {
  const i = shown.indexOf(id);
  const j = i + dir;
  if (id === LOCKED_COL || i < 0 || j < 1 || j >= shown.length) return [...shown];
  const next = [...shown];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function canMove(shown: readonly LeadColId[], id: LeadColId, dir: -1 | 1): boolean {
  const i = shown.indexOf(id);
  const j = i + dir;
  return id !== LOCKED_COL && i > 0 && j >= 1 && j < shown.length;
}

/* ── Saved choice ─────────────────────────────────────────────────────────────
   No per-user settings store exists on the server (searched 20 Nov 2026: no users.prefs /
   user_settings table), so the choice is kept in this browser, like the widths and the
   density next to it. The key is versioned: the old one held only a "hidden" set over the
   fixed nine columns. */
export const LEAD_COLS_KEY = "resellersos.leads.columns.v2";
export const LEGACY_HIDDEN_KEY = "resellersos.leads.hiddenCols";

/**
 * The saved columns, or the default. A broken value falls back to the default rather than
 * an empty table. A person who hid columns under the old menu keeps them hidden.
 */
export function readShownColumns(store?: Pick<Storage, "getItem">): LeadColId[] {
  try {
    const s = store ?? window.localStorage;
    const raw = s.getItem(LEAD_COLS_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return normaliseShown(parsed);
    }
    const legacy = s.getItem(LEGACY_HIDDEN_KEY);
    if (legacy) {
      const hidden: unknown = JSON.parse(legacy);
      if (Array.isArray(hidden)) {
        return normaliseShown(DEFAULT_LEAD_COLS.filter((id) => !hidden.includes(id)));
      }
    }
  } catch { /* private mode / broken value — the default is a fine answer */ }
  return [...DEFAULT_LEAD_COLS];
}

export function writeShownColumns(shown: readonly LeadColId[], store?: Pick<Storage, "setItem">): void {
  try {
    (store ?? window.localStorage).setItem(LEAD_COLS_KEY, JSON.stringify(normaliseShown(shown)));
  } catch { /* not remembering is an inconvenience, not a fault */ }
}

export function sameColumns(a: readonly LeadColId[], b: readonly LeadColId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** First-paint widths as % of the table, for the shown columns only (sum 100). */
export function fallbackPercents(shown: readonly LeadColId[]): Record<string, string> {
  const total = shown.reduce((s, id) => s + leadColDef(id).px, 0) || 1;
  const out: Record<string, string> = {};
  for (const id of shown) out[id] = `${((leadColDef(id).px / total) * 100).toFixed(2)}%`;
  return out;
}

/** The atomic columns the first fit must not squeeze (fitToContainer's `keep`). */
export function keepWhole(shown: readonly LeadColId[]): string[] {
  return [SELECT_COL, ACTIONS_COL, ...shown.filter((id) => leadColDef(id).atom && id !== "stage")];
}
