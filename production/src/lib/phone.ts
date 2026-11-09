/**
 * R-2639: one place that turns a customer's saved phone into an international number.
 *
 * Before: the quote page, `toWhatsAppDigits` and `formatWhatsAppPhone` each put 91 in front of
 * any bare 10-digit number — a US / Canada customer (also 10 digits) was sent to India on
 * WhatsApp. Now the dialling code comes from the customer's country (the R-2180 ISO list);
 * India or an empty country keeps 91, an unknown country text gets no invented code, and a
 * number that already carries a code ("+44 …", "0044 …", "447911…") is never given a second one.
 */
import { countryIsoCode, normalizeCountry } from "@/lib/gst/countries";

/** ISO 3166-1 alpha-2 → international dialling code (ITU E.164), digits only. */
const DIAL: Record<string, string> = {
  AF: "93", AX: "358", AL: "355", DZ: "213", AS: "1", AD: "376", AO: "244", AI: "1", AQ: "672",
  AG: "1", AR: "54", AM: "374", AW: "297", AU: "61", AT: "43", AZ: "994", BS: "1", BH: "973",
  BD: "880", BB: "1", BY: "375", BE: "32", BZ: "501", BJ: "229", BM: "1", BT: "975", BO: "591",
  BQ: "599", BA: "387", BW: "267", BV: "47", BR: "55", IO: "246", VG: "1", BN: "673", BG: "359",
  BF: "226", BI: "257", CV: "238", KH: "855", CM: "237", CA: "1", KY: "1", CF: "236", TD: "235",
  CL: "56", CN: "86", CX: "61", CC: "61", CO: "57", KM: "269", CG: "242", CD: "243", CK: "682",
  CR: "506", CI: "225", HR: "385", CU: "53", CW: "599", CY: "357", CZ: "420", DK: "45", DJ: "253",
  DM: "1", DO: "1", EC: "593", EG: "20", SV: "503", GQ: "240", ER: "291", EE: "372", SZ: "268",
  ET: "251", FK: "500", FO: "298", FJ: "679", FI: "358", FR: "33", GF: "594", PF: "689", TF: "262",
  GA: "241", GM: "220", GE: "995", DE: "49", GH: "233", GI: "350", GR: "30", GL: "299", GD: "1",
  GP: "590", GU: "1", GT: "502", GG: "44", GN: "224", GW: "245", GY: "592", HT: "509", HM: "672",
  VA: "39", HN: "504", HK: "852", HU: "36", IS: "354", IN: "91", ID: "62", IR: "98", IQ: "964",
  IE: "353", IM: "44", IL: "972", IT: "39", JM: "1", JP: "81", JE: "44", JO: "962", KZ: "7",
  KE: "254", KI: "686", KP: "850", KR: "82", KW: "965", KG: "996", LA: "856", LV: "371", LB: "961",
  LS: "266", LR: "231", LY: "218", LI: "423", LT: "370", LU: "352", MO: "853", MG: "261", MW: "265",
  MY: "60", MV: "960", ML: "223", MT: "356", MH: "692", MQ: "596", MR: "222", MU: "230", YT: "262",
  MX: "52", FM: "691", MD: "373", MC: "377", MN: "976", ME: "382", MS: "1", MA: "212", MZ: "258",
  MM: "95", NA: "264", NR: "674", NP: "977", NL: "31", NC: "687", NZ: "64", NI: "505", NE: "227",
  NG: "234", NU: "683", NF: "672", MK: "389", MP: "1", NO: "47", OM: "968", PK: "92", PW: "680",
  PS: "970", PA: "507", PG: "675", PY: "595", PE: "51", PH: "63", PN: "64", PL: "48", PT: "351",
  PR: "1", QA: "974", RE: "262", RO: "40", RU: "7", RW: "250", BL: "590", SH: "290", KN: "1",
  LC: "1", MF: "590", PM: "508", VC: "1", WS: "685", SM: "378", ST: "239", SA: "966", SN: "221",
  RS: "381", SC: "248", SL: "232", SG: "65", SX: "1", SK: "421", SI: "386", SB: "677", SO: "252",
  ZA: "27", GS: "500", SS: "211", ES: "34", LK: "94", SD: "249", SR: "597", SJ: "47", SE: "46",
  CH: "41", SY: "963", TW: "886", TJ: "992", TZ: "255", TH: "66", TL: "670", TG: "228", TK: "690",
  TO: "676", TT: "1", TN: "216", TR: "90", TM: "993", TC: "1", TV: "688", UG: "256", UA: "380",
  AE: "971", GB: "44", US: "1", UM: "1", UY: "598", UZ: "998", VU: "678", VE: "58", VN: "84",
  VI: "1", WF: "681", EH: "212", YE: "967", ZM: "260", ZW: "263",
};

/**
 * Countries whose national number has one fixed length — a number of exactly that length is
 * national even when it happens to start with the code (an Indian mobile "91234 56789").
 */
const NATIONAL_LENGTH: Record<string, number> = { "91": 10, "1": 10 };

/** Fewest digits a full international number has (code + subscriber). */
const MIN_INTERNATIONAL = 8;

/**
 * The dialling code for a customer's country: India / empty → "91"; a known country → its
 * code ("United States" / "USA" / "US" → "1"); unknown text → null (never guessed).
 */
export function dialCodeForCountry(country: string | null | undefined): string | null {
  if (!normalizeCountry(country)) return "91";
  const iso = countryIsoCode(country);
  return iso ? DIAL[iso] ?? null : null;
}

/**
 * The phone as international digits without "+" ("15551234567"), using the customer's country
 * for a number typed without a code. Null when there is no usable number.
 */
export function phoneDigitsForCountry(
  phone: string | null | undefined,
  country?: string | null,
): string | null {
  if (!phone) return null;
  const raw = phone.trim();
  let d = raw.replace(/\D/g, "");
  if (!d) return null;

  // Written with its code: "+44 …" or "00 44 …" — keep exactly that code.
  if (raw.startsWith("+")) return d.length >= MIN_INTERNATIONAL ? d : null;
  if (d.startsWith("00")) {
    d = d.slice(2);
    return d.length >= MIN_INTERNATIONAL ? d : null;
  }

  const code = dialCodeForCountry(country);
  // Unknown country: no code invented; the digits as saved (old rule: at least 10).
  if (code === null) return d.length >= 10 ? d : null;

  // Already starts with the country's code ("447911123456", "919876543210")?
  const nationalLen = NATIONAL_LENGTH[code];
  const hasCode = d.startsWith(code)
    && d.length - code.length >= 7
    && (nationalLen === undefined ? d.length >= MIN_INTERNATIONAL + 2 : d.length === code.length + nationalLen);
  if (hasCode) return d;

  // National number: drop the trunk 0 ("07911…", "050…", "098765…"), then add the code.
  d = d.replace(/^0+/, "");
  if (nationalLen !== undefined ? d.length !== nationalLen : d.length < 6) {
    // India / NANP numbers have one length; anything else is not a number we can dial.
    if (nationalLen !== undefined && d.length > nationalLen) return d; // e.g. a longer number saved without "+"
    return null;
  }
  return code + d;
}

/** Same number as "+<digits>" for display / `tel:` links; "" when there is none. */
export function phoneE164ForCountry(phone: string | null | undefined, country?: string | null): string {
  const d = phoneDigitsForCountry(phone, country);
  return d ? `+${d}` : "";
}
