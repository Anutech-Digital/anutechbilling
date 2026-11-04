/**
 * Country list for the customer / lead / prospect "Country" selector.
 *
 * A picker (not free text) so the value is consistent — `isExportSupply`
 * (place-of-supply.ts) treats anything that isn't India as an export (zero-rated
 * under LUT), so a typo like "U.S.A" vs "USA" must never decide GST.
 *
 * R-2180: the full ISO 3166-1 list (249 countries and territories), common English
 * short names — the old ~60 hand-picked names had no Estonia or Cayman Islands, so
 * real export customers could not be added. Order: India first (the default), then
 * the common export markets the old list pinned (same names — saved rows stay valid),
 * then everyone else A–Z. The stored value is the display name; `normalizeCountry`
 * maps old short forms ("USA") and ISO codes to it.
 */

/** [ISO 3166-1 alpha-2, display name] — the display name is what is saved. */
const ISO_COUNTRIES: ReadonlyArray<readonly [string, string]> = [
  ["AF", "Afghanistan"], ["AX", "Åland Islands"], ["AL", "Albania"], ["DZ", "Algeria"],
  ["AS", "American Samoa"], ["AD", "Andorra"], ["AO", "Angola"], ["AI", "Anguilla"],
  ["AQ", "Antarctica"], ["AG", "Antigua and Barbuda"], ["AR", "Argentina"], ["AM", "Armenia"],
  ["AW", "Aruba"], ["AU", "Australia"], ["AT", "Austria"], ["AZ", "Azerbaijan"],
  ["BS", "Bahamas"], ["BH", "Bahrain"], ["BD", "Bangladesh"], ["BB", "Barbados"],
  ["BY", "Belarus"], ["BE", "Belgium"], ["BZ", "Belize"], ["BJ", "Benin"],
  ["BM", "Bermuda"], ["BT", "Bhutan"], ["BO", "Bolivia"], ["BQ", "Caribbean Netherlands"],
  ["BA", "Bosnia and Herzegovina"], ["BW", "Botswana"], ["BV", "Bouvet Island"], ["BR", "Brazil"],
  ["IO", "British Indian Ocean Territory"], ["VG", "British Virgin Islands"], ["BN", "Brunei"], ["BG", "Bulgaria"],
  ["BF", "Burkina Faso"], ["BI", "Burundi"], ["CV", "Cape Verde"], ["KH", "Cambodia"],
  ["CM", "Cameroon"], ["CA", "Canada"], ["KY", "Cayman Islands"], ["CF", "Central African Republic"],
  ["TD", "Chad"], ["CL", "Chile"], ["CN", "China"], ["CX", "Christmas Island"],
  ["CC", "Cocos (Keeling) Islands"], ["CO", "Colombia"], ["KM", "Comoros"], ["CG", "Congo"],
  ["CD", "Congo (DRC)"], ["CK", "Cook Islands"], ["CR", "Costa Rica"], ["CI", "Côte d'Ivoire"],
  ["HR", "Croatia"], ["CU", "Cuba"], ["CW", "Curaçao"], ["CY", "Cyprus"],
  ["CZ", "Czechia"], ["DK", "Denmark"], ["DJ", "Djibouti"], ["DM", "Dominica"],
  ["DO", "Dominican Republic"], ["EC", "Ecuador"], ["EG", "Egypt"], ["SV", "El Salvador"],
  ["GQ", "Equatorial Guinea"], ["ER", "Eritrea"], ["EE", "Estonia"], ["SZ", "Eswatini"],
  ["ET", "Ethiopia"], ["FK", "Falkland Islands"], ["FO", "Faroe Islands"], ["FJ", "Fiji"],
  ["FI", "Finland"], ["FR", "France"], ["GF", "French Guiana"], ["PF", "French Polynesia"],
  ["TF", "French Southern Territories"], ["GA", "Gabon"], ["GM", "Gambia"], ["GE", "Georgia"],
  ["DE", "Germany"], ["GH", "Ghana"], ["GI", "Gibraltar"], ["GR", "Greece"],
  ["GL", "Greenland"], ["GD", "Grenada"], ["GP", "Guadeloupe"], ["GU", "Guam"],
  ["GT", "Guatemala"], ["GG", "Guernsey"], ["GN", "Guinea"], ["GW", "Guinea-Bissau"],
  ["GY", "Guyana"], ["HT", "Haiti"], ["HM", "Heard Island and McDonald Islands"], ["VA", "Vatican City"],
  ["HN", "Honduras"], ["HK", "Hong Kong"], ["HU", "Hungary"], ["IS", "Iceland"],
  ["IN", "India"], ["ID", "Indonesia"], ["IR", "Iran"], ["IQ", "Iraq"],
  ["IE", "Ireland"], ["IM", "Isle of Man"], ["IL", "Israel"], ["IT", "Italy"],
  ["JM", "Jamaica"], ["JP", "Japan"], ["JE", "Jersey"], ["JO", "Jordan"],
  ["KZ", "Kazakhstan"], ["KE", "Kenya"], ["KI", "Kiribati"], ["KP", "North Korea"],
  ["KR", "South Korea"], ["KW", "Kuwait"], ["KG", "Kyrgyzstan"], ["LA", "Laos"],
  ["LV", "Latvia"], ["LB", "Lebanon"], ["LS", "Lesotho"], ["LR", "Liberia"],
  ["LY", "Libya"], ["LI", "Liechtenstein"], ["LT", "Lithuania"], ["LU", "Luxembourg"],
  ["MO", "Macao"], ["MG", "Madagascar"], ["MW", "Malawi"], ["MY", "Malaysia"],
  ["MV", "Maldives"], ["ML", "Mali"], ["MT", "Malta"], ["MH", "Marshall Islands"],
  ["MQ", "Martinique"], ["MR", "Mauritania"], ["MU", "Mauritius"], ["YT", "Mayotte"],
  ["MX", "Mexico"], ["FM", "Micronesia"], ["MD", "Moldova"], ["MC", "Monaco"],
  ["MN", "Mongolia"], ["ME", "Montenegro"], ["MS", "Montserrat"], ["MA", "Morocco"],
  ["MZ", "Mozambique"], ["MM", "Myanmar"], ["NA", "Namibia"], ["NR", "Nauru"],
  ["NP", "Nepal"], ["NL", "Netherlands"], ["NC", "New Caledonia"], ["NZ", "New Zealand"],
  ["NI", "Nicaragua"], ["NE", "Niger"], ["NG", "Nigeria"], ["NU", "Niue"],
  ["NF", "Norfolk Island"], ["MK", "North Macedonia"], ["MP", "Northern Mariana Islands"], ["NO", "Norway"],
  ["OM", "Oman"], ["PK", "Pakistan"], ["PW", "Palau"], ["PS", "Palestine"],
  ["PA", "Panama"], ["PG", "Papua New Guinea"], ["PY", "Paraguay"], ["PE", "Peru"],
  ["PH", "Philippines"], ["PN", "Pitcairn Islands"], ["PL", "Poland"], ["PT", "Portugal"],
  ["PR", "Puerto Rico"], ["QA", "Qatar"], ["RE", "Réunion"], ["RO", "Romania"],
  ["RU", "Russia"], ["RW", "Rwanda"], ["BL", "Saint Barthélemy"], ["SH", "Saint Helena, Ascension and Tristan da Cunha"],
  ["KN", "Saint Kitts and Nevis"], ["LC", "Saint Lucia"], ["MF", "Saint Martin"], ["PM", "Saint Pierre and Miquelon"],
  ["VC", "Saint Vincent and the Grenadines"], ["WS", "Samoa"], ["SM", "San Marino"], ["ST", "São Tomé and Príncipe"],
  ["SA", "Saudi Arabia"], ["SN", "Senegal"], ["RS", "Serbia"], ["SC", "Seychelles"],
  ["SL", "Sierra Leone"], ["SG", "Singapore"], ["SX", "Sint Maarten"], ["SK", "Slovakia"],
  ["SI", "Slovenia"], ["SB", "Solomon Islands"], ["SO", "Somalia"], ["ZA", "South Africa"],
  ["GS", "South Georgia and the South Sandwich Islands"], ["SS", "South Sudan"], ["ES", "Spain"], ["LK", "Sri Lanka"],
  ["SD", "Sudan"], ["SR", "Suriname"], ["SJ", "Svalbard and Jan Mayen"], ["SE", "Sweden"],
  ["CH", "Switzerland"], ["SY", "Syria"], ["TW", "Taiwan"], ["TJ", "Tajikistan"],
  ["TZ", "Tanzania"], ["TH", "Thailand"], ["TL", "Timor-Leste"], ["TG", "Togo"],
  ["TK", "Tokelau"], ["TO", "Tonga"], ["TT", "Trinidad and Tobago"], ["TN", "Tunisia"],
  ["TR", "Turkey"], ["TM", "Turkmenistan"], ["TC", "Turks and Caicos Islands"], ["TV", "Tuvalu"],
  ["UG", "Uganda"], ["UA", "Ukraine"], ["AE", "United Arab Emirates"], ["GB", "United Kingdom"],
  ["US", "United States"], ["UM", "U.S. Minor Outlying Islands"], ["UY", "Uruguay"], ["UZ", "Uzbekistan"],
  ["VU", "Vanuatu"], ["VE", "Venezuela"], ["VN", "Vietnam"], ["VI", "U.S. Virgin Islands"],
  ["WF", "Wallis and Futuna"], ["EH", "Western Sahara"], ["YE", "Yemen"], ["ZM", "Zambia"],
  ["ZW", "Zimbabwe"],
];

/** The common export markets the old list showed first — kept on top, in this order. */
const PINNED = [
  // Gulf / Middle East — the most common export market for Indian resellers
  "United Arab Emirates", "Saudi Arabia", "Kuwait", "Qatar", "Oman", "Bahrain",
  // English-speaking / large SaaS markets
  "United States", "United Kingdom", "Canada", "Australia", "New Zealand", "Singapore", "Ireland",
];

/** Lower case, accents off, single spaces — "Côte d'Ivoire" and "cote d'ivoire" match. */
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export const COUNTRIES: string[] = [
  "India",
  ...PINNED,
  ...ISO_COUNTRIES.map(([, name]) => name)
    .filter((n) => n !== "India" && !PINNED.includes(n))
    .sort((a, b) => fold(a).localeCompare(fold(b))),
];

/** Other ways people write a country (old saved values, Zoho exports) → the list name. */
const ALIASES: Record<string, string> = {
  "usa": "United States", "u.s.a": "United States", "u.s.a.": "United States", "u.s.": "United States",
  "united states of america": "United States", "america": "United States",
  "uk": "United Kingdom", "u.k.": "United Kingdom", "great britain": "United Kingdom", "britain": "United Kingdom", "england": "United Kingdom",
  "uae": "United Arab Emirates", "u.a.e": "United Arab Emirates", "u.a.e.": "United Arab Emirates", "emirates": "United Arab Emirates", "dubai": "United Arab Emirates",
  "ksa": "Saudi Arabia",
  "bharat": "India", "ind": "India",
  "korea": "South Korea", "republic of korea": "South Korea", "korea, republic of": "South Korea",
  "viet nam": "Vietnam", "czech republic": "Czechia", "turkiye": "Turkey",
  "ivory coast": "Côte d'Ivoire", "macau": "Macao", "burma": "Myanmar", "swaziland": "Eswatini",
  "cabo verde": "Cape Verde", "east timor": "Timor-Leste", "holland": "Netherlands",
  "russian federation": "Russia", "macedonia": "North Macedonia", "vatican": "Vatican City", "holy see": "Vatican City",
  "democratic republic of the congo": "Congo (DRC)", "dr congo": "Congo (DRC)", "drc": "Congo (DRC)",
  "republic of the congo": "Congo", "brunei darussalam": "Brunei", "lao pdr": "Laos",
  "iran, islamic republic of": "Iran", "syrian arab republic": "Syria", "tanzania, united republic of": "Tanzania",
  "moldova, republic of": "Moldova", "bolivia, plurinational state of": "Bolivia", "venezuela, bolivarian republic of": "Venezuela",
  "bvi": "British Virgin Islands", "virgin islands, british": "British Virgin Islands", "virgin islands, u.s.": "U.S. Virgin Islands",
};

const BY_KEY = new Map<string, string>();
for (const [code, name] of ISO_COUNTRIES) {
  BY_KEY.set(fold(name), name);
  BY_KEY.set(code.toLowerCase(), name);
}
for (const [alias, name] of Object.entries(ALIASES)) BY_KEY.set(fold(alias), name);

/**
 * The list name for a country as typed or saved: "USA" → "United States", "EE" → "Estonia",
 * "estonia" → "Estonia". Unknown text is returned trimmed, unchanged — never guessed.
 */
export function normalizeCountry(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (raw === "") return "";
  return BY_KEY.get(fold(raw)) ?? raw;
}

/** Search keys per country: its folded name first, then ISO code and aliases. */
const KEYS = new Map<string, string[]>();
for (const [code, name] of ISO_COUNTRIES) KEYS.set(name, [fold(name), code.toLowerCase()]);
for (const [alias, name] of Object.entries(ALIASES)) KEYS.get(name)?.push(fold(alias));

/**
 * Countries for what the user typed, best first: an exact code/alias ("usa"), then names
 * that start with it ("Est" → Estonia), then a word that starts with it ("isl" →
 * Cayman Islands), then any match inside. Accents and case are ignored. Empty → all.
 */
export function searchCountries(query: string): string[] {
  const q = fold(query);
  if (!q) return COUNTRIES;
  const rank = (name: string): number => {
    const keys = KEYS.get(name) ?? [fold(name)];
    if (keys.some((k) => k === q)) return 0;
    if (keys[0].startsWith(q)) return 1;
    if (keys.some((k) => k.split(/[\s(),.-]+/).some((w) => w.startsWith(q)))) return 2;
    if (keys.some((k) => k.includes(q))) return 3;
    return -1;
  };
  return COUNTRIES
    .map((name, i) => ({ name, i, r: rank(name) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.name);
}
