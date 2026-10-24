/**
 * Salary lines on a bank statement → who was paid, for which month.
 *
 * Indian bank narrations for salary transfers are regular enough to read without a
 * model — e.g. HDFC:
 *   50100784857169-TPT-SALARY APR 2026-PAWAN
 *   50100784857182-TPT-EMP MAY SALARY-HITESH BABU
 *   50100508749370-TPT-FULL N FINAL SALARY-KESHAV MALIK
 * The payee is the last "-" segment; the month, when present, is a month word with an
 * optional year.
 *
 * ─── WHAT IT DOES NOT PRETEND TO KNOW ───────────────────────────────────────
 *  • No month in the narration → the month BEFORE the payment (salary is normally paid
 *    for the month just ended), flagged `periodFromNarration: false` so the screen can
 *    say it was assumed and let the operator change it.
 *  • No readable name → `name: null`; the operator picks the employee.
 *  • "ADVANCE" lines are not salary — an advance is a loan against future pay and has
 *    its own flow — so they are not offered at all.
 */

const MONTHS: Array<[RegExp, number]> = [
  [/^JAN(UARY)?$/, 1], [/^FEB(RUARY)?$/, 2], [/^MAR(CH)?$/, 3], [/^APR(IL)?$/, 4],
  [/^MAY$/, 5], [/^JUNE?$/, 6], [/^JULY?$/, 7], [/^AUG(UST)?$/, 8],
  [/^SEPT?(EMBER)?$/, 9], [/^OCT(OBER)?$/, 10], [/^NOV(EMBER)?$/, 11], [/^DEC(EMBER)?$/, 12],
];

function monthOf(word: string): number | null {
  for (const [re, m] of MONTHS) if (re.test(word)) return m;
  return null;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The month before an ISO date, as YYYY-MM. */
export function previousPeriod(isoDate: string): string {
  const [y, m] = isoDate.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad2(m - 1)}`;
}

export type SalaryNarration = {
  /** Payee as written on the statement, or null when none could be read. */
  name: string | null;
  /** YYYY-MM */
  period: string;
  periodFromNarration: boolean;
  fullAndFinal: boolean;
  /** "SALARY TO DIRECTOR" — director's remuneration is not employee payroll; flag it. */
  director: boolean;
};

export function parseSalaryNarration(description: string, txnDate: string): SalaryNarration | null {
  const text = description.toUpperCase();
  if (!/\bSALARY\b/.test(text)) return null;
  if (/\bADVANCE\b/.test(text)) return null;

  const segments = text.split("-").map((s) => s.trim()).filter(Boolean);

  /* Payee. Transfers within the bank (TPT) put it LAST; IMPS / NEFT / RTGS put it
     third — IMPS-<ref>-<NAME>-<bank>-<account>-<remark>. Either way it must be words
     and not the SALARY segment itself. */
  const isName = (s: string | undefined) => !!s && /^[A-Z][A-Z .]*[A-Z.]$/.test(s) && !/\bSALARY\b/.test(s);
  let nameIdx = -1;
  if (isName(segments[segments.length - 1])) nameIdx = segments.length - 1;
  // "NEFT", "NEFT DR", "RTGS CR" … — HDFC writes "NEFT DR-<IFSC>-<NAME>-NETBANK, MUM-…".
  else if (/^(IMPS|NEFT|RTGS)(\s+(DR|CR))?$/.test(segments[0] ?? "") && isName(segments[2])) nameIdx = 2;
  const name = nameIdx >= 0 ? segments[nameIdx].replace(/\s+/g, " ") : null;

  /* Month: search every segment except the payee's (a name like "MAY" must not count). */
  const searchable = segments.filter((_, i) => i !== nameIdx).join(" ");
  const words = searchable.split(/[^A-Z0-9']+/).filter(Boolean);
  let period: string | null = null;
  const [ty, tm] = txnDate.split("-").map(Number);
  for (let i = 0; i < words.length; i++) {
    const m = monthOf(words[i]);
    if (!m) continue;
    const next = (words[i + 1] ?? "").replace(/^'/, "");
    let y: number;
    if (/^\d{4}$/.test(next)) y = Number(next);
    else if (/^\d{2}$/.test(next)) y = 2000 + Number(next);
    /* No year: the latest such month not after the payment. */
    else y = m > tm ? ty - 1 : ty;
    period = `${y}-${pad2(m)}`;
    break;
  }

  return {
    name,
    period: period ?? previousPeriod(txnDate),
    periodFromNarration: period !== null,
    fullAndFinal: /\bFULL\s*(N|AND|&)\s*FINAL\b|\bF\s*&\s*F\b|\bFNF\b/.test(text),
    director: /\bDIRECTORS?\b/.test(text),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();

export type EmployeeMatch =
  | { kind: "match"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

/**
 * Statement name → employee. Tries, in order, and stops at the first rule that
 * yields exactly ONE employee: the whole name; every statement word present in the
 * employee's name ("PAWAN" → "Pawan Kumar"). Two or more candidates is `ambiguous`,
 * never a pick — two Rahuls are the operator's call.
 */
export function matchEmployee(name: string | null, employees: Array<{ id: string; name: string }>): EmployeeMatch {
  if (!name) return { kind: "none" };
  const target = norm(name);
  if (!target) return { kind: "none" };

  const exact = employees.filter((e) => norm(e.name) === target);
  if (exact.length === 1) return { kind: "match", id: exact[0].id };
  if (exact.length > 1) return { kind: "ambiguous", ids: exact.map((e) => e.id) };

  /* The same letters with the spaces in different places — a PDF statement breaks names
     where its column wraps ("HITES H BABU", "RANJE ET RAJ"). Letters decide, not spaces. */
  const compact = compactName(name);
  const sameLetters = employees.filter((e) => compactName(e.name) === compact);
  if (sameLetters.length === 1) return { kind: "match", id: sameLetters[0].id };
  if (sameLetters.length > 1) return { kind: "ambiguous", ids: sameLetters.map((e) => e.id) };

  const words = target.split(" ");
  const contains = employees.filter((e) => {
    const have = new Set(norm(e.name).split(" "));
    return words.every((w) => have.has(w));
  });
  if (contains.length === 1) return { kind: "match", id: contains[0].id };
  if (contains.length > 1) return { kind: "ambiguous", ids: contains.map((e) => e.id) };
  return { kind: "none" };
}

/** "RANJEET RAJ" → "Ranjeet Raj", for a new employee created from a statement line. */
export function titleCaseName(name: string): string {
  return name.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/* ─── ONE PERSON, MANY SPELLINGS ─────────────────────────────────────────────
   26 Sep 2026: one statement import created FIFTEEN employees for eight people —
   "Hitesh Babu", "Hites H Babu", "Hitesh Ba Bu", "Hitesh Bab U"; "Abhi", "Abhis",
   "Abhi Shek". The PDF broke names where its column wrapped (and cut some short), and
   each spelling was taken for a new person. The narration also carried the one thing
   that does not change: the payee's account number. */

/** Letters only, upper-case — "Hites H Babu" and "HITESH BABU" are the same name. */
export function compactName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z]/g, "");
}

/**
 * A stable key for WHO was paid, from the narration — the same person on every line.
 *   TPT (own-bank transfer): the payee account, "50100784857182-TPT-…"   → "acct:50100784857182"
 *   IMPS: bank code + last 4 of the masked account, "IMPS-…-NAME-PUNB-XXXXXXXX X3174-…" → "imps:PUNB:3174"
 *   NEFT / RTGS: the payee IFSC + the letters of the name   → "ifsc:BKID0006087:PRATIK"
 * Null when none of these can be read — the caller falls back to the name.
 */
export function payeeKey(description: string): string | null {
  const segs = description.toUpperCase().split("-").map((x) => x.trim());
  if (/^\d{9,18}$/.test(segs[0] ?? "") && segs[1] === "TPT") return `acct:${segs[0]}`;
  if (/^IMPS$/.test(segs[0] ?? "") && segs.length >= 5) {
    const last4 = (segs[4] ?? "").replace(/\D/g, "").slice(-4);
    if (/^[A-Z]{4}$/.test(segs[3] ?? "") && last4.length === 4) return `imps:${segs[3]}:${last4}`;
  }
  if (/^(NEFT|RTGS)(\s+(DR|CR))?$/.test(segs[0] ?? "") && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(segs[1] ?? "") && segs[2]) {
    return `ifsc:${segs[1]}:${compactName(segs[2])}`;
  }
  return null;
}

/**
 * The best spelling among a payee's variants, for a NEW employee: the most letters (a cut
 * "ABHI" loses to "ABHI SHEK"), then the fewest stray fragments ("HITESH BABU" beats
 * "HITES H BABU" — longer average word). Title-cased. The operator can still edit it.
 */
export function bestNameVariant(names: readonly string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  const score = (n: string) => {
    const words = n.split(/\s+/);
    return [compactName(n).length, compactName(n).length / words.length];
  };
  const best = [...clean].sort((a, b) => {
    const [la, aa] = score(a), [lb, ab] = score(b);
    return lb - la || ab - aa;
  })[0];
  return titleCaseName(best.replace(/\s+/g, " "));
}

/* ─── ALREADY IN PAYROLL (R-1831, 24 Oct 2026) ───────────────────────────────
   "Salary lines" creates a salary record for a bank line that has none. It must never record
   a month payroll already has. The same employee + month is caught by the record lookup (and
   by the unique (employee, period) key); these are the ways a SECOND record could still slip in:
     • the line's month is a guess ("month assumed") one month off from a record payroll has
       booked and not seen paid — e.g. May booked, the line read as June;
     • the statement spells the name so the employee is not recognised ("MANOJ KUMAR S" vs
       "Manoj") and the screen offers to CREATE a new employee — with May's salary again.
   Such a line is skipped, and says which record it belongs to. */

export type PayrollRecordLite = {
  employee_id: string; period: string; net: number; paid_amount: number; paid_status: string;
};

export type AlreadyInPayroll =
  /** That employee's salary for that month is fully paid already. */
  | { kind: "paid"; employeeId: string; period: string }
  /** Booked for the month before/after, not paid, same amount — the line is probably that salary. */
  | { kind: "other_month"; employeeId: string; period: string; remaining: number }
  /** A new name, but an existing employee sharing a name has this month's salary of this amount. */
  | { kind: "other_employee"; employeeId: string; period: string; net: number };

function shiftPeriod(period: string, by: number): string {
  const [y, m] = period.split("-").map(Number);
  const t = y * 12 + (m - 1) + by;
  return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
}

/** Whole rupees, ±1 for paise rounding on the statement. */
const sameAmount = (a: number, b: number) => Math.abs(Math.round(a) - Math.round(b)) <= 1;

const nameWords = (s: string) => norm(s).split(" ").filter((w) => w.length >= 3);

export function alreadyInPayroll(input: {
  /** Employee id the line is set to, or "create" for a new employee ("" = not chosen). */
  choice: string;
  statementName: string | null;
  period: string;
  amount: number;
  salaries: readonly PayrollRecordLite[];
  employees: ReadonlyArray<{ id: string; name: string }>;
}): AlreadyInPayroll | null {
  const { choice, period, amount, salaries } = input;
  if (!choice) return null;

  if (choice !== "create") {
    const rec = salaries.find((s) => s.employee_id === choice && s.period === period);
    if (rec) {
      return rec.paid_status === "paid" || rec.net - rec.paid_amount <= 0
        ? { kind: "paid", employeeId: choice, period }
        : null; // an open record of this month: the line links to it, no second record
    }
    for (const by of [-1, 1]) {
      const near = salaries.find((s) => s.employee_id === choice && s.period === shiftPeriod(period, by));
      if (!near || near.paid_status === "paid") continue;
      const remaining = near.net - near.paid_amount;
      if (remaining > 0 && sameAmount(remaining, amount)) {
        return { kind: "other_month", employeeId: choice, period: near.period, remaining };
      }
    }
    return null;
  }

  /* A new employee from the statement name: is this someone payroll already pays this month? */
  const words = new Set(nameWords(input.statementName ?? ""));
  if (words.size === 0) return null;
  for (const e of input.employees) {
    if (!nameWords(e.name).some((w) => words.has(w))) continue;
    const rec = salaries.find((s) => s.employee_id === e.id && s.period === period);
    if (rec && (sameAmount(rec.net, amount) || sameAmount(rec.net - rec.paid_amount, amount))) {
      return { kind: "other_employee", employeeId: e.id, period, net: rec.net };
    }
  }
  return null;
}
