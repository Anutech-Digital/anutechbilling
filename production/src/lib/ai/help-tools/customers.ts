/**
 * Help AI read tool: find_customer (R-2776 / H-03, G-HELPAI).
 *
 * The first tool that takes a free-text argument from the model: a search word. It goes ONLY
 * through the reader's containsPattern() — % _ * and \ in it match themselves (R-2882) — and never
 * into in() / not(). One query, tenant-scoped by the reader, owner's own login (RLS).
 *
 * Mirrors the Customers list (/customers): the same `customers` rows, searched by name. The row
 * shows only what the list shows — name, number, type, state, active, since. Never the GSTIN, PAN,
 * TAN, phone, e-mail or address (the help path does not send those to the model, help-facts.ts).
 * Its result gives the model the customer ids it needs for the next tool (list_invoices).
 */
import { z } from "zod";
import type { UserRole } from "@/lib/auth/roles";
import { defineHelpTool, type HelpSourceRef } from "./types";
import { containsPattern } from "./reader";
import { cleanHelpText } from "./untrusted";

const OWNER = ["owner"] as const satisfies readonly UserRole[];

/** Longest search word the model may send (names are short; the reader allows 100). */
export const FIND_CUSTOMER_WORD_MAX = 60;
/** Most customers one answer lists. */
export const FIND_CUSTOMER_ROWS_MAX = 20;
const FIND_CUSTOMER_ROWS_DEFAULT = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CustomerRow {
  id: string;
  name: string | null;
  customer_number: string | null;
  customer_type: string | null;
  state: string | null;
  is_active: boolean | null;
  since: string | null;
}

export const findCustomer = defineHelpTool({
  name: "find_customer",
  describe: "find customers by a word from their name (e.g. 'sharma'); returns up to 20 matches with their customer id — use the id for the next lookup (list_invoices)",
  input: z.object({
    search: z.string().min(1).max(FIND_CUSTOMER_WORD_MAX),
    limit: z.number().int().min(1).max(FIND_CUSTOMER_ROWS_MAX).optional(),
  }).strict(),
  roles: OWNER,
  tier: "read",
  page: "/customers",
  label: "Open Customers",
  maxRows: FIND_CUSTOMER_ROWS_MAX,
  async run({ search, limit }, { db }) {
    /* The word as plain text: hidden / control characters gone, one line. Nothing left → no search. */
    const word = cleanHelpText(search, FIND_CUSTOMER_WORD_MAX);
    if (!word) return { text: "No customer search was run: the search word was empty.", sources: [] };
    const cap = limit ?? FIND_CUSTOMER_ROWS_DEFAULT;
    const r = await db.read<CustomerRow>("customers", "id, name, customer_number, customer_type, state, is_active, since", { count: "exact" })
      .ilike("name", containsPattern(word))
      .order("name", { ascending: true }).order("id", { ascending: true })
      .limit(cap);
    if (r.error) throw r.error;
    const found = r.data ?? [];
    const total = Math.max(r.count ?? 0, found.length);
    if (!found.length) {
      return { text: `No customer's name contains "${word}".`, rows: [], total: 0, sources: [] };
    }
    const lines = [`Customers whose name contains "${word}": ${total}${total > found.length ? ` (listing ${found.length})` : ""}.`];
    const sources: HelpSourceRef[] = [];
    const rows = found.map((c) => {
      const name = cleanHelpText(c.name) || "Unnamed customer";
      const number = cleanHelpText(c.customer_number, 40);
      const state = cleanHelpText(c.state, 40);
      const active = c.is_active !== false;
      lines.push(`- ${name}${number ? ` (${number})` : ""}${state ? ` — ${state}` : ""}${active ? "" : " — inactive"} — customer id ${cleanHelpText(c.id, 40)}`);
      if (typeof c.id === "string" && UUID.test(c.id)) {
        sources.push({ table: "customers", ids: [c.id], href: `/customers/${c.id}`, label: `Open customer ${name}` });
      }
      return {
        id: c.id, name, customer_number: number || null, customer_type: cleanHelpText(c.customer_type, 40) || null,
        state: state || null, active, since: c.since ?? null,
      };
    });
    return { text: lines.join("\n"), rows, total, sources };
  },
});

export const CUSTOMER_TOOLS = [findCustomer] as const;
