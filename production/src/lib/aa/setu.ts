/**
 * Setu — Account Aggregator (AA) client.
 *
 * Setu is a TSP (Technical Service Provider) under India's RBI-regulated
 * Account Aggregator framework. They expose a REST API that, with the user's
 * one-time consent, can pull bank account transactions on a schedule.
 *
 * This file is the THIN provider wrapper. Higher-level orchestration
 * (consent creation, FI data parsing, mapping to bank_transactions rows)
 * lives in the /api/aa/setu/* routes.
 *
 * Env vars required for production use:
 *   SETU_AA_BASE_URL    e.g. https://aa-sandbox.setu.co (or https://aa.setu.co for prod)
 *   SETU_AA_CLIENT_ID   from Setu dashboard
 *   SETU_AA_SECRET      from Setu dashboard
 *   SETU_AA_REDIRECT_URL  where Setu redirects after consent approval (our callback)
 *
 * When any of these are missing, the module operates in MOCK MODE — every
 * call returns a deterministic fake that lets the UI demo work end-to-end
 * without provider keys. Useful for dev + for showing the flow to users
 * before they sign up with a real AA TSP.
 */

// ─── Config ────────────────────────────────────────────────────────────────

const BASE_URL     = process.env.SETU_AA_BASE_URL     ?? "";
const CLIENT_ID    = process.env.SETU_AA_CLIENT_ID    ?? "";
const SECRET       = process.env.SETU_AA_SECRET       ?? "";
const REDIRECT_URL = process.env.SETU_AA_REDIRECT_URL ?? "";

export function isSetuConfigured(): boolean {
  return Boolean(BASE_URL && CLIENT_ID && SECRET && REDIRECT_URL);
}

// ─── Response shapes (subset of Setu's API) ────────────────────────────────

export interface CreateConsentResponse {
  id:              string;            // consent_handle_id
  url:             string;            // redirect URL — open in browser
  status:          "PENDING" | "REJECTED" | "ACTIVE" | "REVOKED" | "EXPIRED";
  vua:             string;
  consent_expires_at?: string;
}

export interface ConsentStatusResponse {
  id:                  string;
  status:              "PENDING" | "ACTIVE" | "REJECTED" | "REVOKED" | "EXPIRED";
  consent_id?:         string;        // populated once user approves
  linked_accounts?:    Array<{
    accountRef:        string;
    accountType:       string;
    maskedAccNumber:   string;
    ifsc:              string;
    fipName:           string;        // "HDFC Bank", "ICICI Bank" etc.
  }>;
  rejection_reason?:   string;
}

export interface FiDataTransaction {
  txnId:             string;
  type:              "CREDIT" | "DEBIT";
  amount:            number;          // in rupees (Setu returns decimal, we round)
  date:              string;          // ISO YYYY-MM-DD
  narration:         string;
  reference:         string | null;
  balance_after:     number | null;
}

export interface FetchFiDataResponse {
  status:            "PENDING" | "READY" | "FAILED";
  transactions:      FiDataTransaction[];
  fetched_at:        string;
  next_token?:       string;
}

// ─── Calls ─────────────────────────────────────────────────────────────────

/**
 * Step 1 — initiate consent. User will be redirected to {response.url}
 * where they approve sharing their bank data with us.
 */
export async function createConsent(input: {
  vua:               string;
  bank_ifsc:         string;
  fetch_window_from: string;    // ISO date
  fetch_window_to:   string;
  purpose?:          string;
  /** R-879: signed state (lib/aa/consent-state.ts) the callback must get back. */
  state:             string;
}): Promise<CreateConsentResponse> {
  if (!isSetuConfigured()) {
    return mockCreateConsent(input);
  }
  const body = {
    vua:              input.vua,
    purpose:          input.purpose ?? "Reseller bookkeeping (101 — Wealth management)",
    fiTypes:          ["DEPOSIT"],
    fetchPeriod:      { from: input.fetch_window_from, to: input.fetch_window_to },
    redirect_url:     withState(REDIRECT_URL, input.state),
    filter_ifsc:      input.bank_ifsc,
  };
  const res = await fetch(`${BASE_URL}/consents`, {
    method:  "POST",
    headers: setuHeaders(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Setu createConsent failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as CreateConsentResponse;
}

/** Step 2 — poll consent status (or process Setu's callback POST). */
export async function getConsentStatus(consentHandleId: string): Promise<ConsentStatusResponse> {
  if (!isSetuConfigured()) {
    return mockGetConsentStatus(consentHandleId);
  }
  const res = await fetch(`${BASE_URL}/consents/${consentHandleId}`, {
    headers: setuHeaders(),
  });
  if (!res.ok) throw new Error(`Setu getConsentStatus failed: ${res.status}`);
  return (await res.json()) as ConsentStatusResponse;
}

/**
 * Step 3 — request FI Data. Once consent is active, ask Setu to fetch
 * transactions for the given date window. Returns a session you poll
 * with fetchFiData until status='READY'.
 */
export async function requestFiData(input: {
  consent_id:        string;
  account_ref:       string;
  from_date:         string;
  to_date:           string;
}): Promise<{ session_id: string }> {
  if (!isSetuConfigured()) {
    return { session_id: `mock_sess_${Date.now()}` };
  }
  const res = await fetch(`${BASE_URL}/sessions`, {
    method:  "POST",
    headers: setuHeaders(),
    body:    JSON.stringify({
      consent_id:  input.consent_id,
      account_ref: input.account_ref,
      from:        input.from_date,
      to:          input.to_date,
    }),
  });
  if (!res.ok) throw new Error(`Setu requestFiData failed: ${res.status}`);
  return (await res.json()) as { session_id: string };
}

/** Step 4 — fetch the actual transactions (polling). */
export async function fetchFiData(sessionId: string): Promise<FetchFiDataResponse> {
  if (!isSetuConfigured()) {
    return mockFetchFiData(sessionId);
  }
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}`, {
    headers: setuHeaders(),
  });
  if (!res.ok) throw new Error(`Setu fetchFiData failed: ${res.status}`);
  return (await res.json()) as FetchFiDataResponse;
}

// ─── Internal ──────────────────────────────────────────────────────────────

function setuHeaders(): HeadersInit {
  return {
    "Content-Type":  "application/json",
    "x-client-id":   CLIENT_ID,
    "x-client-secret": SECRET,
  };
}

// ─── Mocks (mock mode — no Setu keys) ──────────────────────────────────────

/** R-879: the callback URL carrying the signed state back to us. */
export function withState(url: string, state: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}state=${encodeURIComponent(state)}`;
}

function mockCreateConsent(input: { vua: string; state: string }): CreateConsentResponse {
  const id = `mock_handle_${Math.random().toString(36).slice(2, 10)}`;
  // In mock mode the "redirect URL" is our own simulate-approval page so
  // the operator can see the whole flow without leaving localhost.
  return {
    id,
    url:    withState(`/aa/simulate-approval?handle=${id}`, input.state),
    status: "PENDING",
    vua:    input.vua,
    consent_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function mockGetConsentStatus(handleId: string): ConsentStatusResponse {
  // Default mock returns ACTIVE so callers can proceed to fetch.
  // Real flow: callback updates the row when user approves on phone.
  return {
    id:         handleId,
    status:     "ACTIVE",
    consent_id: `mock_cid_${handleId.slice(-8)}`,
    linked_accounts: [{
      accountRef:      "mock_acc_ref",
      accountType:     "SAVINGS",
      maskedAccNumber: "XXXX1234",
      ifsc:            "HDFC0001234",
      fipName:         "HDFC Bank",
    }],
  };
}

function mockFetchFiData(_sessionId: string): FetchFiDataResponse {
  // Return realistic-looking mock transactions for demo
  const today = new Date();
  const day   = (offset: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset).toISOString().slice(0, 10);
  return {
    status: "READY",
    fetched_at: new Date().toISOString(),
    transactions: [
      { txnId: "mock_t1", type: "CREDIT", amount: 118000, date: day(3), narration: "UPI/CUSTOMER-MOCK/INV-PAYMENT", reference: "UPI/MOCK/0001", balance_after: 1118000 },
      { txnId: "mock_t2", type: "DEBIT",  amount:   8500, date: day(2), narration: "IMPS/MOCK-CLOUD-SERVICES",      reference: "IMPS/MOCK/9881", balance_after: 1109500 },
      { txnId: "mock_t3", type: "CREDIT", amount: 250000, date: day(1), narration: "NEFT/MOCK-ENTERPRISE/PMT",      reference: "NEFT/MOCK/AX22", balance_after: 1359500 },
      { txnId: "mock_t4", type: "DEBIT",  amount:   1180, date: day(0), narration: "INTERNETBANKING-CHRG/MOCK",     reference: null,             balance_after: 1358320 },
    ],
  };
}
