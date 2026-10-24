/**
 * R-1753 — the dry run's reading part: Zoho Books → zoho_books_import_records, in small
 * resumable steps.
 *
 * Zoho Books allows about 100 API requests a minute per organization, and a subscription
 * needs the line items of every invoice in the window (one request per invoice). So one
 * step makes at most `maxRequests` calls, at least `gapMs` apart (≈ 90 a minute), saves the
 * cursor (phase + next page) after every page / batch, and returns. The screen calls the
 * next step until the phase is "ready"; closing the browser loses nothing.
 *
 *   contacts → every customer contact (200 a page)
 *   invoices → every invoice (200 a page); kept when it is in the subscription window
 *              (dated on/after `since`) or still has a balance; the window ones that are not
 *              Subs Period "One-Time" are marked needs_detail
 *   details  → line items of the needs_detail invoices
 *   ready    → the dry run can be shown
 *
 * READ-ONLY at Zoho. The store is given by the caller (the route: service-role client
 * filtered by the caller's tenant + run id; the tests: memory).
 */
import {
  CF_NEW_BUSINESS, CF_SERVICE_EXPIRY, CF_SUBS_PERIOD, ZohoApiError,
  getInvoiceDetail, invoiceFieldValue, isOpenInvoice, listContactsPage, listInvoicesPage,
} from "./api";
import { subsPeriodMonths, type ZohoContactRec, type ZohoInvoiceRec, type ZohoLineRec } from "./import-plan";

export type ScanPhase = "contacts" | "invoices" | "details" | "ready";

export interface ScanRun {
  id: string;
  org_id: string;
  /** YYYY-MM-DD */
  since: string;
  phase: ScanPhase;
  next_page: number;
  contacts_read: number;
  invoices_read: number;
  details_total: number;
  details_done: number;
}

export interface ScanRecord { zoho_id: string; data: ZohoContactRec | Omit<ZohoInvoiceRec, "lines">; needs_detail?: boolean }

export interface ScanStore {
  saveRun(patch: Partial<Omit<ScanRun, "id" | "org_id" | "since">> & { last_error?: string | null; scanned_at?: string | null }): Promise<void>;
  upsertRecords(kind: "contact" | "invoice", rows: ScanRecord[]): Promise<void>;
  /** Zoho invoice ids still waiting for their line items (oldest first is fine). */
  pendingDetails(limit: number): Promise<string[]>;
  countPendingDetails(): Promise<number>;
  saveLines(zohoInvoiceId: string, lines: ZohoLineRec[]): Promise<void>;
}

export interface ScanDeps {
  store: ScanStore;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxRequests?: number;
  maxMs?: number;
  gapMs?: number;
}

export interface StepResult {
  run: ScanRun;
  /** Zoho said "too many requests": wait a minute, then continue. */
  rateLimited: boolean;
}

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A Zoho contact (list row) → what the import keeps. Null for a vendor. */
export function contactFromZoho(row: Record<string, unknown>): ZohoContactRec | null {
  const type = str(row.contact_type);
  if (type && type !== "customer") return null;
  const id = str(row.contact_id);
  const name = str(row.contact_name) ?? str(row.company_name);
  if (!id || !name) return null;
  const person = [str(row.first_name), str(row.last_name)].filter(Boolean).join(" ").trim();
  return {
    zohoId: id,
    name,
    gstin: str(row.gst_no),
    gstTreatment: str(row.gst_treatment),
    placeOfContact: str(row.place_of_contact),
    paymentTermsDays: num(row.payment_terms),
    email: str(row.email),
    phone: str(row.mobile) ?? str(row.phone),
    personName: person || null,
    subType: str(row.customer_sub_type),
  };
}

/** A Zoho invoice (list row) → what the import keeps (no line items yet). */
export function invoiceFromZoho(row: Record<string, unknown>): Omit<ZohoInvoiceRec, "lines"> | null {
  const id = str(row.invoice_id);
  const number = str(row.invoice_number);
  if (!id || !number) return null;
  return {
    zohoId: id,
    number,
    date: str(row.date),
    dueDate: str(row.due_date),
    zohoCustomerId: str(row.customer_id) ?? "",
    customerName: str(row.customer_name) ?? "",
    status: str(row.status) ?? "",
    total: num(row.total),
    balance: num(row.balance),
    currency: str(row.currency_code) ?? "INR",
    gstin: str(row.gst_no),
    placeOfSupply: str(row.place_of_supply),
    subsPeriod: invoiceFieldValue(row, CF_SUBS_PERIOD),
    newBusiness: invoiceFieldValue(row, CF_NEW_BUSINESS),
    serviceExpiry: invoiceFieldValue(row, CF_SERVICE_EXPIRY),
  };
}

/** The line items of an invoice detail. */
export function linesFromZoho(detail: Record<string, unknown>): ZohoLineRec[] {
  const items = Array.isArray(detail.line_items) ? (detail.line_items as Array<Record<string, unknown>>) : [];
  return items.map((li) => ({
    plan: str(li.name) ?? str(li.item_name) ?? "",
    quantity: num(li.quantity) ?? 0,
    itemTotal: num(li.item_total),
    rate: num(li.rate),
    description: (str(li.description) ?? "").slice(0, 2000),
  }));
}

const DEAD = new Set(["void", "draft"]);

export async function scanStep(run: ScanRun, deps: ScanDeps): Promise<StepResult> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const maxRequests = deps.maxRequests ?? 40;
  const maxMs = deps.maxMs ?? 40_000;
  const gapMs = deps.gapMs ?? 650;
  const started = now();
  let requests = 0;
  let last: number | null = null;
  const cur: ScanRun = { ...run };

  /** One Zoho call, paced. */
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    const wait = last === null ? 0 : last + gapMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    requests += 1;
    return fn();
  };
  const budgetLeft = () => requests < maxRequests && now() - started < maxMs;

  try {
    while (cur.phase !== "ready" && budgetLeft()) {
      if (cur.phase === "contacts") {
        const page = await call(() => listContactsPage(cur.org_id, deps.token, cur.next_page, f));
        const rows = page.rows.map(contactFromZoho).filter((c): c is ZohoContactRec => c !== null)
          .map((c) => ({ zoho_id: c.zohoId, data: c }));
        if (rows.length) await deps.store.upsertRecords("contact", rows);
        cur.contacts_read += rows.length;
        if (page.more) cur.next_page += 1;
        else { cur.phase = "invoices"; cur.next_page = 1; }
        await deps.store.saveRun({ phase: cur.phase, next_page: cur.next_page, contacts_read: cur.contacts_read, last_error: null });
      } else if (cur.phase === "invoices") {
        const page = await call(() => listInvoicesPage(cur.org_id, deps.token, cur.next_page, f));
        const keep: ScanRecord[] = [];
        for (const row of page.rows) {
          const inv = invoiceFromZoho(row);
          if (!inv || DEAD.has(inv.status.toLowerCase())) continue;
          const inWindow = Boolean(inv.date && inv.date >= cur.since);
          if (!inWindow && !isOpenInvoice(row)) continue;
          keep.push({ zoho_id: inv.zohoId, data: inv, needs_detail: inWindow && subsPeriodMonths(inv.subsPeriod) !== "one_time" });
        }
        if (keep.length) await deps.store.upsertRecords("invoice", keep);
        cur.invoices_read += page.rows.length;
        if (page.more) cur.next_page += 1;
        else {
          cur.phase = "details";
          cur.next_page = 1;
          cur.details_total = await deps.store.countPendingDetails();
          cur.details_done = 0;
        }
        await deps.store.saveRun({
          phase: cur.phase, next_page: cur.next_page, invoices_read: cur.invoices_read,
          details_total: cur.details_total, details_done: cur.details_done, last_error: null,
        });
      } else if (cur.phase === "details") {
        const ids = await deps.store.pendingDetails(Math.max(1, maxRequests - requests));
        if (ids.length === 0) {
          cur.phase = "ready";
          await deps.store.saveRun({ phase: "ready", scanned_at: new Date(now()).toISOString(), last_error: null });
          break;
        }
        for (const id of ids) {
          if (!budgetLeft()) break;
          let detail: Record<string, unknown>;
          try {
            detail = await call(() => getInvoiceDetail(cur.org_id, deps.token, id, f));
          } catch (e) {
            /* Deleted in Zoho since the list was read: no lines, move on (never loop on it). */
            if (e instanceof ZohoApiError && e.status === 404) detail = {};
            else throw e;
          }
          await deps.store.saveLines(id, linesFromZoho(detail));
          cur.details_done += 1;
        }
        await deps.store.saveRun({ details_done: cur.details_done, last_error: null });
      }
    }
    /* The last batch may have been the last one: say ready now rather than one empty step later. */
    if (cur.phase === "details" && (await deps.store.pendingDetails(1)).length === 0) {
      cur.phase = "ready";
      await deps.store.saveRun({ phase: "ready", scanned_at: new Date(now()).toISOString(), last_error: null });
    }
  } catch (e) {
    if (e instanceof ZohoApiError && e.status === 429) {
      await deps.store.saveRun({ details_done: cur.details_done, last_error: e.message });
      return { run: cur, rateLimited: true };
    }
    await deps.store.saveRun({ last_error: e instanceof ZohoApiError ? e.message : "Reading from Zoho stopped. Press Continue." }).catch(() => undefined);
    throw e;
  }
  return { run: cur, rateLimited: false };
}
