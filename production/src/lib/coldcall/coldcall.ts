/**
 * Cold Calling (R-1661/R-1662) — the decisions, with no I/O in them.
 *
 *   parseCallingList   spreadsheet text → numbers to call (DND, bad and repeated numbers set aside)
 *   outcomeFromCall    what the voice agent's call came to → the row's next status
 *   canCallNow         is this minute inside the campaign's calling window (IST, Mon–Fri)?
 *   istDayStart        the start of today in IST, for counting the daily limit
 *
 * Pure so every rule is pinned by a test: a cold list rings strangers, and a rule that quietly
 * stops holding (DND, the window, the daily cap) is a complaint or a bill nobody expected.
 */
import { findColumn, parseCsvLine } from "@/lib/csv";
import { normaliseIndianPhone, statusFromDisposition, type PostCallSignals } from "@/lib/ai/telecall";

/* ── Import ──────────────────────────────────────────────────────────────── */

export interface CallingListRow {
  name: string | null;
  company: string | null;
  city: string | null;
  phone: string;
  dnd: boolean;
}

export interface ParsedCallingList {
  /** Numbers to put on the list (DND ones included, marked — they are shown but never called). */
  rows: CallingListRow[];
  /** 1-based spreadsheet line numbers whose phone could not be read. */
  invalidLines: number[];
  /** Phones that appeared again lower down (kept once). */
  duplicates: number;
  /** Set when the file itself is unusable — say what to fix. */
  error: string | null;
}

/** Most rows one import may add — a bigger list is a sign the wrong file was picked. */
export const MAX_IMPORT_ROWS = 5000;

const PHONE_HEADERS = ["phone", "mobile", "phone number", "mobile number", "contact number", "number", "contact", "whatsapp"];
const NAME_HEADERS = ["name", "contact name", "full name", "person", "customer name"];
const COMPANY_HEADERS = ["company", "company name", "business", "business name", "organisation", "organization", "firm"];
const CITY_HEADERS = ["city", "location", "town", "state"];
const DND_HEADERS = ["dnd", "do not call", "do not disturb", "dnd status", "ndnc"];

/** A DND cell that means "do not call". Anything else (blank, "no", "0") means callable. */
function isDnd(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return ["yes", "y", "true", "1", "dnd", "registered", "fully blocked", "blocked"].includes(s);
}

function cell(cols: string[], i: number): string | null {
  if (i < 0) return null;
  const v = (cols[i] ?? "").trim();
  return v ? v.slice(0, 200) : null;
}

/**
 * Read a calling list exported from Excel as CSV. The header row must have a phone column;
 * name / company / city / DND are optional and found by common names.
 */
export function parseCallingList(text: string): ParsedCallingList {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx < 0) return { rows: [], invalidLines: [], duplicates: 0, error: "The file is empty." };

  const headers = parseCsvLine(lines[firstIdx]);
  const phoneCol = findColumn(headers, PHONE_HEADERS);
  if (phoneCol < 0) {
    return {
      rows: [], invalidLines: [], duplicates: 0,
      error: "No phone column found. Name the column 'Phone' (also allowed: Mobile, Number) and import again.",
    };
  }
  const nameCol = findColumn(headers, NAME_HEADERS);
  const companyCol = findColumn(headers, COMPANY_HEADERS);
  const cityCol = findColumn(headers, CITY_HEADERS);
  const dndCol = findColumn(headers, DND_HEADERS);

  const rows: CallingListRow[] = [];
  const invalidLines: number[] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  for (let i = firstIdx + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCsvLine(lines[i]);
    const phone = normaliseIndianPhone(cols[phoneCol]);
    if (!phone) { invalidLines.push(i + 1); continue; }
    if (seen.has(phone)) { duplicates++; continue; }
    seen.add(phone);
    rows.push({
      phone,
      name: cell(cols, nameCol),
      company: cell(cols, companyCol),
      city: cell(cols, cityCol),
      dnd: dndCol >= 0 && isDnd(cols[dndCol]),
    });
    if (rows.length > MAX_IMPORT_ROWS) {
      return {
        rows: [], invalidLines: [], duplicates: 0,
        error: `More than ${MAX_IMPORT_ROWS.toLocaleString("en-IN")} numbers in one file. Split it into smaller files.`,
      };
    }
  }

  if (rows.length === 0 && invalidLines.length > 0) {
    return { rows, invalidLines, duplicates, error: "None of the phone numbers could be read. Use 10-digit mobiles or +91 numbers." };
  }
  return { rows, invalidLines, duplicates, error: null };
}

/* ── After the call ──────────────────────────────────────────────────────── */

export type ColdCallStatus =
  | "pending" | "calling" | "answered" | "interested" | "callback"
  | "not_interested" | "no_answer" | "failed" | "skipped_dnd" | "moved";

/** One try plus two retries (Abhishek: "no answer → next day, max 2 retries"). */
export const MAX_ATTEMPTS = 3;
/** A retry waits about a day, so a second ring is never the same afternoon. */
export const RETRY_AFTER_HOURS = 20;

export interface ColdCallOutcome {
  status: ColdCallStatus;
  /** When to ring again, for a no-answer that still has attempts left. */
  nextAttemptAt: Date | null;
}

/**
 * What a finished call means for the list.
 *
 * "Interested" is generous on purpose — asked for a quote, asked to be called back with a
 * number of users, or said how many users — because the next step is a PERSON reading the call
 * and pressing "Move to Sales & Pipeline". A wrongly-marked interested row costs one look; a
 * missed one costs a customer.
 */
export function outcomeFromCall(signals: PostCallSignals, attemptsSoFar: number, now: Date): ColdCallOutcome {
  const status = statusFromDisposition(signals.disposition);

  if (status === "no_answer" || status === "busy") {
    if (attemptsSoFar < MAX_ATTEMPTS) {
      return { status: "pending", nextAttemptAt: new Date(now.getTime() + RETRY_AFTER_HOURS * 3_600_000) };
    }
    return { status: "no_answer", nextAttemptAt: null };
  }
  if (status === "failed") return { status: "failed", nextAttemptAt: null };

  if (signals.customerNotInterested) return { status: "not_interested", nextAttemptAt: null };
  if (signals.customerAskedForQuote || (signals.seatsDiscussed ?? 0) > 0) {
    return { status: "interested", nextAttemptAt: null };
  }
  if (signals.customerAskedForCallback) return { status: "callback", nextAttemptAt: null };
  return { status: "answered", nextAttemptAt: null };
}

/* ── When ────────────────────────────────────────────────────────────────── */

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** IST hour (0–23) and weekday (0 = Sunday) for an instant. IST has no DST. */
export function istClock(at: Date): { hour: number; weekday: number } {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  return { hour: ist.getUTCHours(), weekday: ist.getUTCDay() };
}

/** Inside the campaign's window: Monday–Friday, window_start ≤ IST hour < window_end. */
export function canCallNow(at: Date, windowStart: number, windowEnd: number): boolean {
  const { hour, weekday } = istClock(at);
  if (weekday === 0 || weekday === 6) return false;
  return hour >= windowStart && hour < windowEnd;
}

/** Midnight IST today, as an instant — "calls today" counts from here. */
export function istDayStart(at: Date): Date {
  const ist = new Date(at.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/**
 * The next working day (Mon–Fri, IST) at `hour`:00 IST — when the salesperson's follow-up call is
 * due after a cold-call contact is moved into the pipeline. Friday/Saturday/Sunday land on Monday.
 */
export function nextWorkingDayAt(now: Date, hour: number): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  do {
    ist.setUTCDate(ist.getUTCDate() + 1);
  } while (ist.getUTCDay() === 0 || ist.getUTCDay() === 6);
  ist.setUTCHours(hour, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/** Why a number from a new file is not added: it was already rung, or the business already has it. */
export interface SkippedNumber {
  phone: string;
  name: string | null;
  /** Plain words, e.g. "On “Delhi CA — Oct” · Not interested · 12 Oct". */
  reason: string;
  leadId?: string | null;
}
