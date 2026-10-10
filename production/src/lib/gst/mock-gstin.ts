/**
 * The GSTIN lookup's MOCK answer (no provider configured) — deterministic from the GSTIN.
 *
 * R-526 (9 Oct 2026): the mock always filled "Plot 14, BKC, Mumbai 400051", so a Delhi GSTIN
 * (07…) came back with a Mumbai address and a Maharashtra PIN on the customer form — the AI
 * tester's customer was saved with a city and PIN from the wrong state. The address now
 * follows the GSTIN's own state (first two digits): its capital city and a PIN that belongs
 * to that state. A state not in the short list gets its name as the city and NO PIN — a
 * blank the user fills is better than a PIN from somewhere else.
 *
 * Still a mock: `source: "mock"` and "(Mock)" in the jurisdiction say so on screen.
 */
import { GST_STATE_BY_CODE } from "@/lib/utils";
import type { GstinVerification } from "@/lib/supabase/database.types";

/** Capital (or main business city) and a real PIN in that state, by GST state code. */
const MOCK_CITY_BY_STATE: Readonly<Record<string, { city: string; pin: string }>> = {
  "03": { city: "Ludhiana",    pin: "141001" },
  "04": { city: "Chandigarh",  pin: "160017" },
  "06": { city: "Gurugram",    pin: "122001" },
  "07": { city: "New Delhi",   pin: "110001" },
  "08": { city: "Jaipur",      pin: "302001" },
  "09": { city: "Noida",       pin: "201301" },
  "10": { city: "Patna",       pin: "800001" },
  "19": { city: "Kolkata",     pin: "700001" },
  "21": { city: "Bhubaneswar", pin: "751001" },
  "23": { city: "Indore",      pin: "452001" },
  "24": { city: "Ahmedabad",   pin: "380009" },
  "27": { city: "Mumbai",      pin: "400051" },
  "29": { city: "Bengaluru",   pin: "560001" },
  "30": { city: "Panaji",      pin: "403001" },
  "32": { city: "Kochi",       pin: "682011" },
  "33": { city: "Chennai",     pin: "600002" },
  "36": { city: "Hyderabad",   pin: "500001" },
  "37": { city: "Visakhapatnam", pin: "530002" },
};

export function mockGstinVerification(gstin: string): GstinVerification {
  const stateCode  = gstin.slice(0, 2);
  const panLetters = gstin.slice(2, 7);
  const stateName  = GST_STATE_BY_CODE[stateCode] ?? null;
  const place      = MOCK_CITY_BY_STATE[stateCode];
  const city       = place?.city ?? stateName ?? "";
  const pin        = place?.pin ?? null;
  const principal_address = {
    building:   "Plot 14",
    street:     "Main Road",
    locality:   "Business District",
    city,
    district:   city,
    state:      stateName ?? stateCode,
    pin_code:   pin,
  };
  return {
    status:             "Active",
    legal_name:         `${panLetters} Technologies Private Limited`,
    trade_name:         `${panLetters} Technologies`,
    constitution:       "Private Limited Company",
    registration_type:  "Regular",
    valid_from:         "2017-07-01",
    valid_upto:         null,
    last_return_filed:  "2026-04-20",
    jurisdiction:       `State - ${stateCode} (Mock)`,
    state_code:         stateCode,
    principal_address,
    address:            ["Plot 14, Main Road, Business District", city, pin].filter(Boolean).join(", "),
    source:             "mock",
  };
}
