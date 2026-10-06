// @vitest-environment jsdom
//
// "Payment Received" must NOT create the subscription. This is the guard on a double-bill.
//
// ─── THE HAZARD ─────────────────────────────────────────────────────────────
// `record_payment` creates the subscription itself — that is the money spine: paid
// quote → customer → subscription → renewal date, in one transaction. Asked on
// 9 Sep 2026 to route "Payment Received" through the Record payment sheet, the obvious
// implementation (create the subscription here, then open the sheet) produces TWO
// subscriptions for one sale, and the renewal cron bills the customer twice a year for
// one service.
//
// Nothing would have caught it. record_payment skips creating one only for a RENEWAL
// quote, which it detects via a subscription whose `renewal_quote_id` points at the
// quote — and this dialog sets `quote_id`, a different column. The guard never fires.
//
// So the paid path creates customer + quote and stops, handing off. These tests assert
// the *absence* of the subscription insert, which is the kind of thing no screen shows
// and no toast mentions.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddSubscriptionDialog } from "./add-subscription-dialog";

vi.mock("@/lib/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ data: { id: "u1", tenantId: "t1", role: "owner" } }),
}));
vi.mock("@/lib/queries/items", () => ({ useItems: () => ({ data: [], isLoading: false }) }));

/** Every table written to, in order, with the row. */
const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
/** Rows the mocked `quotes` SELECT returns — the unpaid quote this sale already has. */
const existingQuotes: Array<{ id: string }> = [];
/** Rows the mocked `customers` SELECT returns — the customer this sale already has. */
const existingCustomerRows: Array<{ id: string; name: string; domain: string | null }> = [];
/** Rows the mocked `contacts` SELECT returns — people already on file. Also answers the
 *  "who already holds this email" pre-flight lookup, so a row with a customer_id that
 *  does not match the sale is how a duplicate-email clash is simulated. */
const existingContactRows: Array<{ id: string; full_name?: string; customer_id?: string | null }> = [];
/** Rows the mocked `customer_contacts` SELECT returns — who is already linked to the
 *  customer being sold to. Non-empty means savePrimaryContact leaves them alone. */
const existingLinkRows: Array<{ id: string }> = [];

/**
 * A thenable query chain, because the dialog uses two different shapes against the same
 * client: `select().order()` awaited directly for the customer list, and
 * `select().eq()...order().limit()` for the reusable-quote lookup. Making the chain
 * itself awaitable covers both without pretending to be a real query builder.
 */
function chainOf(rows: unknown[]) {
  const settled = Promise.resolve({ data: rows, error: null });
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq:     () => chain,
    or:     () => chain,
    /* Added 18 Sep 2026 with the duplicate-email pre-flight check, which matches the
       address case-insensitively. Its absence did not fail loudly — the call threw, the
       handler's catch swallowed it into a toast, and SEVEN unrelated tests went red
       reporting "nothing was written". A stand-in that is missing a method the code uses
       looks like a bug in the code. */
    ilike:  () => chain,
    order:  () => chain,
    limit:  () => chain,
    then:   (...a: unknown[]) => (settled.then as (...x: unknown[]) => unknown)(...a),
  };
  return chain;
}

/** Numbers the mocked `next_document_number` hands out, oldest first. */
const mintedNumbers: string[] = [];
/** The `p_doc_type` each call asked for — which series was drawn from. */
const mintedDocTypes: unknown[] = [];
/** Set to make the RPC fail, so the refusal path can be asserted. */
let mintFails: string | null = null;
/** Set to a table name to make its INSERT fail, so the undo path can be asserted. */
let insertFailsOn: string | null = null;
/** Every DELETE issued, in order — how "nothing was created" is proved. */
const deletes: Array<{ table: string; id: unknown }> = [];

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    /* The real RPC is atomic, per-tenant and per-fiscal-year. All this stand-in has to
       be is a SEQUENCE, because that is the property the code under test must use
       instead of Math.random(). */
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "next_document_number") return { data: null, error: null };
      mintedDocTypes.push(args.p_doc_type);
      if (mintFails) return { data: null, error: { message: mintFails } };
      const n = String(mintedNumbers.length + 1).padStart(4, "0");
      const id = `Q-ADPL-2026-27-${n}`;
      mintedNumbers.push(id);
      return { data: id, error: null };
    },
    from: (table: string) => ({
      ...chainOf(
        table === "quotes"    ? existingQuotes
        : table === "customers" ? existingCustomerRows
        : table === "contacts"  ? existingContactRows
        : table === "customer_contacts" ? existingLinkRows
        : [],
      ),
      insert: async (row: Record<string, unknown>) => {
        if (insertFailsOn === table) return { error: { message: `${table} refused` } };
        writes.push({ table, row });
        return { error: null };
      },
      /* Only ever used to UNDO a customer this same submit created. Recorded rather than
         silently accepted, because "the customer was removed" is the claim the toast
         makes to the operator and it has to be true. */
      delete: () => ({
        eq: async (_col: string, value: unknown) => {
          deletes.push({ table, id: value });
          return { error: null };
        },
      }),
      /* The quote is UPSERTed so a retry corrects its row instead of colliding on the
         primary key — see findOrMintQuoteId in the dialog. */
      upsert: async (row: Record<string, unknown>) => {
        writes.push({ table, row });
        return { error: null };
      },
    }),
  }),
}));

afterEach(() => {
  cleanup();
  writes.length = 0;
  existingQuotes.length = 0;
  existingCustomerRows.length = 0;
  existingContactRows.length = 0;
  existingLinkRows.length = 0;
  mintedNumbers.length = 0;
  mintedDocTypes.length = 0;
  mintFails = null;
  insertFailsOn = null;
  deletes.length = 0;
});

function fill(paid: boolean, onNeedsPayment?: (h: unknown) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AddSubscriptionDialog
        open
        onOpenChange={() => {}}
        onNeedsPayment={onNeedsPayment ?? (() => {})}
      />
    </QueryClientProvider>,
  );
  const set = (id: string, value: string) => {
    const el = document.querySelector<HTMLInputElement>(`#${id}`)!;
    fireEvent.change(el, { target: { value } });
  };
  set("custName", "Accesstel");
  set("subDomain", "accesstel.in");
  /* A NEW customer must arrive with a COMPLETE person since 11 Sep 2026 — name, email,
     phone and role, all refused blank — so the harness supplies what an operator would.
     Role needs no keystroke: the dropdown opens on "Point of contact". */
  set("contactName", "Ranjeet Kumar");
  set("contactEmail", "ranjeet@accesstel.in");
  set("contactPhone", "+91 98765 43210");
  set("newCustState", "07"); // R-174: a new customer needs a state
  set("pricePerSeat", "1632");
  set("seats", "10");
  /* Postpaid requires a payment due date since 11 Sep 2026 — blank is refused, so the
     harness supplies one. The "paid" path never shows the field. */
  if (!paid) set("paymentDueDate", "2026-10-11");
  if (paid) {
    /* The two terms are buttons, not a native control — pick by its label. */
    const btn = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.textContent ?? "").includes("Payment Received"))!;
    fireEvent.click(btn);
  }
  const form = document.querySelector("form")!;
  fireEvent.submit(form);
}

const tables = () => writes.map((w) => w.table);

describe("Payment Received — hands off instead of creating the subscription", () => {
  it("writes the customer and the quote, and NO subscription", async () => {
    fill(true);
    await waitFor(() => expect(tables()).toContain("quotes"));
    expect(tables()).toContain("customers");
    /* THE assertion. A subscription here is a second one, and a double annual bill. */
    expect(tables()).not.toContain("subscriptions");
  });

  it("leaves the quote AWAITING — it has not been paid yet", async () => {
    fill(true);
    await waitFor(() => expect(tables()).toContain("quotes"));
    const quote = writes.find((w) => w.table === "quotes")!.row;
    expect(quote.payment_status).toBe("awaiting");
  });

  it("hands the payment sheet the GST-INCLUSIVE amount", async () => {
    const handoff = vi.fn();
    fill(true, handoff);
    await waitFor(() => expect(handoff).toHaveBeenCalled());
    const arg = handoff.mock.calls[0][0] as { expectedAmount: number; quoteId: string };
    /* 10 seats × ₹1,632/yr = ₹16,320 ex-GST → ₹19,258 incl 18%. The sheet must expect
       what the customer actually owes, not the taxable figure. */
    expect(arg.expectedAmount).toBe(19_258);
    expect(arg.quoteId).toMatch(/^Q-/);
  });
});

describe("Postpaid — unchanged, still creates the subscription here", () => {
  it("writes customer, quote AND subscription", async () => {
    fill(false);
    await waitFor(() => expect(tables()).toContain("subscriptions"));
    /* `contacts` + its LINK sit between the customer and the quote on purpose — see
       Step 1b: the paid path returns before the quote, so a contact written any later
       would exist for postpaid sales only. The link row is what actually attaches the
       person to the customer (migration 20260918090000); the contact row alone serves
       nobody. */
    expect(tables()).toEqual(["customers", "contacts", "customer_contacts", "quotes", "subscriptions"]);
  });

  it("carries the full GST-inclusive balance as outstanding", async () => {
    fill(false);
    await waitFor(() => expect(tables()).toContain("subscriptions"));
    const sub = writes.find((w) => w.table === "subscriptions")!.row;
    expect(sub.outstanding_amount).toBe(19_258);
    expect(sub.status).toBe("active");
    /* Written explicitly now rather than left to the DB defaults. */
    expect(sub.billing_cycle).toBe("yearly");
    expect(sub.term_months).toBe(12);
  });
});

/**
 * Retrying the same sale must REUSE the quote, not mint another.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Reported 9 Sep 2026: "why quote keep generating again and again". The paid path hands
 * off to Record payment, that sheet was refusing to submit (a required UTR field above
 * the fold), and each retry pressed this button again — inserting a fresh quote every
 * time. Four attempts on one sale left four accepted, unpaid quotes in the tenant's
 * books: Q-2026-2884, 3624, 3670 and 5099, three of them identical at ₹18,691.
 *
 * Unpaid duplicates are not harmless. They are accepted quotes, so they show up as
 * pipeline and as money owed, and any of them can still be paid — each one creating its
 * own subscription.
 */
describe("Retrying the same sale reuses the quote", () => {
  it("reuses the unpaid quote this sale already has, instead of minting another", async () => {
    /* What the database holds after the first attempt was abandoned. */
    existingQuotes.push({ id: "Q-2026-7395" });
    const handoff = vi.fn();
    fill(true, handoff);
    await waitFor(() => expect(handoff).toHaveBeenCalled());

    const arg = handoff.mock.calls[0][0] as { quoteId: string };
    expect(arg.quoteId).toBe("Q-2026-7395");
    /* And the write targets that same row, so the books hold ONE quote. */
    const quote = writes.find((w) => w.table === "quotes")!;
    expect(quote.row.id).toBe("Q-2026-7395");
  });

  it("mints a fresh id when the sale has no reusable quote", async () => {
    /* Nothing reusable — either a genuinely new sale, or the only candidates are paid
       or invoiced, which the query filters out on purpose. */
    const handoff = vi.fn();
    fill(true, handoff);
    await waitFor(() => expect(handoff).toHaveBeenCalled());
    const arg = handoff.mock.calls[0][0] as { quoteId: string };
    /* From the SERIES, not from Math.random(). This used to assert /^Q-\d{4}-\d{4}$/ —
       the shape of the random id that put #4193, #3724 and #2482 in the books. */
    expect(arg.quoteId).toBe("Q-ADPL-2026-27-0001");
    expect(arg.quoteId).not.toBe("Q-2026-7395");
  });

  it("survives a remount — the lookup is not held in component state", async () => {
    /* The previous implementation kept this in a React ref, so closing the dialog and
       coming back (or reloading the page) lost it. The database does not forget. */
    existingQuotes.push({ id: "Q-2026-7395" });
    const first = vi.fn();
    fill(true, first);
    await waitFor(() => expect(first).toHaveBeenCalled());
    cleanup();
    writes.length = 0;
    const second = vi.fn();
    fill(true, second);
    await waitFor(() => expect(second).toHaveBeenCalled());
    expect((second.mock.calls[0][0] as { quoteId: string }).quoteId).toBe("Q-2026-7395");
  });
});

/**
 * Postpaid gets a payment due date; nothing else does.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * "Postpaid / Credit Terms" activates a subscription and books the full GST-inclusive
 * balance as owed, and until 10 Sep 2026 nothing recorded WHEN that money was expected —
 * so an unpaid credit sale simply went quiet. The app's reminder ladder hangs off an
 * invoice due date, and this path raises no invoice by the owner's decision (a tax
 * invoice creates a GST liability on money that sometimes never arrives).
 *
 * The date is typed in, defaults to start + 30, and is counted from the START DATE, so
 * back-dating carries it back too — deliberately, because the money really is that late.
 */
describe("Postpaid — the payment due date is REQUIRED and starts blank", () => {
  const dueField = () => document.querySelector<HTMLInputElement>("#paymentDueDate");
  const openPostpaid = () => render(
    <QueryClientProvider client={new QueryClient()}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
    </QueryClientProvider>,
  );
  const setField = (id: string, v: string) =>
    fireEvent.change(document.querySelector<HTMLInputElement>(`#${id}`)!, { target: { value: v } });

  it("starts BLANK — no guessed date", () => {
    /* It used to pre-fill start + 30. That let a subscription be activated against a
       date nobody had agreed, which then drove a countdown and, later, a reminder. */
    openPostpaid();
    expect(dueField()).not.toBeNull();
    expect(dueField()!.value).toBe("");
  });

  it("does NOT follow the start date any more", () => {
    openPostpaid();
    setField("startDate", "2026-04-01");
    expect(dueField()!.value).toBe("");
  });

  it("is marked required", () => {
    openPostpaid();
    expect(dueField()!.required).toBe(true);
  });

  it("REFUSES to submit postpaid with the date blank, and writes nothing", async () => {
    openPostpaid();
    setField("custName", "Accesstel");
    setField("subDomain", "accesstel.in");
    /* The contact is filled in FULLY on purpose. Leaving any of it blank would make the
       contact guard fire first, and this test would pass while proving nothing about the
       due date. */
    setField("contactName", "Ranjeet Kumar");
    setField("contactEmail", "ranjeet@accesstel.in");
    setField("contactPhone", "+91 98765 43210");
    setField("newCustState", "07"); // R-174: a new customer needs a state
    setField("pricePerSeat", "1632");
    setField("seats", "10");
    fireEvent.submit(document.querySelector("form")!);
    /* Nothing at all — not a customer, not a contact, not a quote. A credit sale with no
       agreed date is the state this whole feature exists to prevent. */
    await new Promise((r) => setTimeout(r, 50));
    expect(writes).toHaveLength(0);
  });

  it("writes exactly the date typed", async () => {
    openPostpaid();
    setField("custName", "Accesstel");
    setField("subDomain", "accesstel.in");
    setField("contactName", "Ranjeet Kumar");
    setField("contactEmail", "ranjeet@accesstel.in");
    setField("contactPhone", "+91 98765 43210");
    setField("newCustState", "07"); // R-174: a new customer needs a state
    setField("pricePerSeat", "1632");
    setField("seats", "10");
    setField("paymentDueDate", "2026-12-31");
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(tables()).toContain("subscriptions"));
    expect(writes.find((w) => w.table === "subscriptions")!.row.payment_due_date)
      .toBe("2026-12-31");
  });

  it("HIDES the field once Payment Received is chosen — nothing is owed", () => {
    openPostpaid();
    expect(dueField()).not.toBeNull();
    const paidBtn = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.textContent ?? "").includes("Payment Received"))!;
    fireEvent.click(paidBtn);
    expect(dueField()).toBeNull();
  });
});

/**
 * A new customer arrives WITH a person, or not at all.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * Until 11 Sep 2026 this dialog had one "Contact Email (Optional)" box whose value was
 * typed into React state and used NOWHERE: no `contacts` row, not even the legacy
 * `customers.contact_email`. So every customer onboarded here — which is how this
 * tenant's customers are actually created — arrived with zero contacts. A postpaid
 * subscription could then carry a due date, a countdown and an overdue highlight with
 * nobody to send the reminder to, and the customer's own page showed the amber "This
 * customer has no contact" warning for a company the app had just created itself.
 *
 * Abhishek's design, 10 Sep 2026: "for a customer one contact is must". The customer
 * page could hold several with roles from that day; this was the front door.
 *
 * The discarded-email bug is the reason the FIRST test here asserts the written row and
 * not merely that a `contacts` write happened: a box that collects a value and drops it
 * looks identical, from outside, to one that works.
 */
describe("A new customer gets a primary contact", () => {
  const contactRow = () => writes.find((w) => w.table === "contacts")?.row;

  it("writes the person, with the name and email typed", async () => {
    fill(false);
    await waitFor(() => expect(tables()).toContain("contacts"));
    expect(contactRow()).toMatchObject({
      full_name:   "Ranjeet Kumar",
      customer_id: expect.any(String),
      tenant_id:   "t1",
      /* THE point of the whole change: it lands on the customer, not in the void. */
      is_primary:  true,
      role:        "poc",
      source:      "manual",
      status:      "engaged",
      /* So a contact read on its own still says who it belongs to. */
      company:     "Accesstel",
    });
  });

  it("carries the email and phone exactly as typed", async () => {
    fill(false);
    await waitFor(() => expect(tables()).toContain("contacts"));
    expect(contactRow()).toMatchObject({
      email: "ranjeet@accesstel.in",
      phone: "+91 98765 43210",
    });
  });

  /**
   * All four fields are mandatory — Abhishek, 11 Sep 2026, overriding the first cut
   * where email and phone were optional.
   *
   * His call is the right one: the email is how an invoice and a payment reminder
   * actually leave the building, and the phone is what the chase uses when the email
   * goes unanswered. A contact with neither satisfies "one contact is must" and still
   * leaves nobody reachable.
   *
   * Each of these asserts that NOTHING is written — not the customer, not the quote.
   * Refusing the whole sale is the point: a half-recorded customer is the state this
   * change exists to end, and the alternative (write the sale, skip the contact) is
   * precisely the silent discard that was there before.
   */
  describe("every field is refused blank", () => {
    /** Fill the form, omitting whichever contact field is under test. */
    const submitWithout = (omit: "contactName" | "contactEmail" | "contactPhone" | "newCustState") => {
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
        </QueryClientProvider>,
      );
      const set = (id: string, v: string) =>
        fireEvent.change(document.querySelector<HTMLInputElement>(`#${id}`)!, { target: { value: v } });
      const fields: Record<string, string> = {
        custName: "Accesstel",
        subDomain: "accesstel.in",
        contactName: "Ranjeet Kumar",
        contactEmail: "ranjeet@accesstel.in",
        contactPhone: "+91 98765 43210",
        newCustState: "07", // R-174
        pricePerSeat: "1632",
        seats: "10",
        paymentDueDate: "2026-10-11",
      };
      for (const [id, v] of Object.entries(fields)) if (id !== omit) set(id, v);
      fireEvent.submit(document.querySelector("form")!);
    };

    /* R-174: a new customer with no state could never be invoiced ("no state on record"). */
    it.each(["contactName", "contactEmail", "contactPhone", "newCustState"] as const)(
      "writes nothing at all when %s is blank", async (omit) => {
        submitWithout(omit);
        await new Promise((r) => setTimeout(r, 50));
        expect(writes).toHaveLength(0);
      });

    it("refuses an email that is missing its domain", async () => {
      /* Shape only — nobody can prove an address exists without sending to it. But
         "ranjeet" in an email column is a reminder that will never arrive, and the
         operator should hear that now rather than in three weeks. */
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
        </QueryClientProvider>,
      );
      const set = (id: string, v: string) =>
        fireEvent.change(document.querySelector<HTMLInputElement>(`#${id}`)!, { target: { value: v } });
      set("custName", "Accesstel");
      set("subDomain", "accesstel.in");
      set("contactName", "Ranjeet Kumar");
      set("contactEmail", "ranjeet");
      set("contactPhone", "+91 98765 43210");
      set("newCustState", "07"); // R-174: a new customer needs a state
      set("pricePerSeat", "1632");
      set("seats", "10");
      set("paymentDueDate", "2026-10-11");
      fireEvent.submit(document.querySelector("form")!);
      await new Promise((r) => setTimeout(r, 50));
      expect(writes).toHaveLength(0);
    });

    it("accepts an address with no dot after the @ — a real intranet address", async () => {
      /* The check is deliberately permissive. A stricter pattern requiring a dot would
         eventually refuse somebody's real address, and refusing a real address costs a
         real sale. */
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
        </QueryClientProvider>,
      );
      const set = (id: string, v: string) =>
        fireEvent.change(document.querySelector<HTMLInputElement>(`#${id}`)!, { target: { value: v } });
      set("custName", "Accesstel");
      set("subDomain", "accesstel.in");
      set("contactName", "Ranjeet Kumar");
      set("contactEmail", "ranjeet@intranet");
      set("contactPhone", "9876543210");
      set("newCustState", "07"); // R-174: a new customer needs a state
      set("pricePerSeat", "1632");
      set("seats", "10");
      set("paymentDueDate", "2026-10-11");
      fireEvent.submit(document.querySelector("form")!);
      await waitFor(() => expect(tables()).toContain("contacts"));
      expect(contactRow()!.email).toBe("ranjeet@intranet");
    });

    it("does NOT police the phone format — Indian numbers are irregular", async () => {
      /* +91 and bare mobiles, landlines with a 2-to-4 digit STD code, extensions. Any
         pattern strict enough to be worth having refuses a real customer eventually. */
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
        </QueryClientProvider>,
      );
      const set = (id: string, v: string) =>
        fireEvent.change(document.querySelector<HTMLInputElement>(`#${id}`)!, { target: { value: v } });
      set("custName", "Accesstel");
      set("subDomain", "accesstel.in");
      set("contactName", "Ranjeet Kumar");
      set("contactEmail", "ranjeet@accesstel.in");
      set("contactPhone", "011-4155 2200 x21");
      set("newCustState", "07"); // R-174: a new customer needs a state
      set("pricePerSeat", "1632");
      set("seats", "10");
      set("paymentDueDate", "2026-10-11");
      fireEvent.submit(document.querySelector("form")!);
      await waitFor(() => expect(tables()).toContain("contacts"));
      expect(contactRow()!.phone).toBe("011-4155 2200 x21");
    });

    it("marks all three inputs required, so the browser flags them too", () => {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
        </QueryClientProvider>,
      );
      for (const id of ["contactName", "contactEmail", "contactPhone"]) {
        expect(document.querySelector<HTMLInputElement>(`#${id}`)!.required).toBe(true);
      }
    });

    it("needs no keystroke for the role — it opens on Point of contact", async () => {
      /* Required in the guard, but never blank: Radix seeds it and offers no way to
         clear it. fill() types nothing into it and the write still carries 'poc'. */
      fill(false);
      await waitFor(() => expect(tables()).toContain("contacts"));
      expect(contactRow()!.role).toBe("poc");
    });
  });

  it("does NOT add a second contact to a customer who already has people", async () => {
    /* `contacts_one_primary_per_customer` is a partial UNIQUE index, so a second
       is_primary row for the same customer fails with 23505 — and even if it did not,
       the people on that customer's page were curated there and this dialog knows less
       about them. Reachable because a TYPED name can match a company already on file,
       which is exactly what produced four "Chandan Trading" rows on 10 Sep 2026. */
    existingCustomerRows.push({ id: "cust-existing", name: "Accesstel", domain: "accesstel.in" });
    /* customer_id MATTERS here, and did not used to. The duplicate-email pre-flight
       (18 Sep 2026) reads this same row to answer "who already holds that address", and
       a contact with no customer_id is genuinely held by somebody else as far as
       `contacts_unique_email_per_tenant` is concerned — it is a tenant-wide index. So a
       fixture without it now describes a clash, not the same customer. */
    existingContactRows.push({
      id: "C-ALREADY", full_name: "Ranjeet Kumar", customer_id: "cust-existing",
    });
    existingLinkRows.push({ id: "LINK-EXISTING" });
    fill(false);
    await waitFor(() => expect(tables()).toContain("subscriptions"));
    expect(tables()).not.toContain("contacts");
    /* And the sale still goes through against the customer already on file. */
    expect(tables()).not.toContain("customers");
  });

  it("FILLS THE GAP for an existing customer who has nobody", async () => {
    /* The Accesstel case: a customer created before the contacts feature existed, with
       ₹7,476 owed and no one to chase. Selling them something is the natural moment to
       finally record a person. */
    existingCustomerRows.push({ id: "cust-existing", name: "Accesstel", domain: "accesstel.in" });
    fill(false);
    await waitFor(() => expect(tables()).toContain("contacts"));
    expect(contactRow()).toMatchObject({ full_name: "Ranjeet Kumar", is_primary: true });
  });

  it("asks for nobody when an EXISTING customer is picked from the dropdown", async () => {
    /* They already have their people. Re-asking on every repeat sale is both a nuisance
       and a route to duplicates. */
    existingCustomerRows.push({ id: "cust-existing", name: "Accesstel", domain: "accesstel.in" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
      </QueryClientProvider>,
    );
    /* The dialog's customer picker is a Radix Select. Driving it in jsdom needs its
       hidden native <select>, which Radix only renders inside a <form> — this one is, so
       the option can be chosen the way the operator does.

       Found by the OPTION rather than by position: this form holds five Selects (vendor,
       plan, billing period, contact role and this one), and a test that depends on which
       comes first in the DOM breaks the next time a field moves. The list itself arrives
       from an async effect, hence the wait. */
    const picker = async () => {
      let found: HTMLSelectElement | undefined;
      await waitFor(() => {
        found = Array.from(document.querySelectorAll<HTMLSelectElement>("form select"))
          .find((s) => Array.from(s.options).some((o) => o.value === "cust-existing"));
        expect(found).toBeDefined();
      });
      return found!;
    };
    fireEvent.change(await picker(), { target: { value: "cust-existing" } });
    expect(document.querySelector("#contactName")).toBeNull();
    expect(document.querySelector("#contactEmail")).toBeNull();
  });
});

/**
 * Quote numbers come from the SERIES, never from Math.random().
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * This dialog minted its own ids:
 *
 *     `Q-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`
 *
 * which is what put #4193, #3724, #2482, #7395 and #9937 in the books, sitting next to
 * the add-seats quotes numbered #0001 and #0002 by the proper route. Spotted by
 * Abhishek on 12 Sep 2026 — "why random number assign to quote, there should be a
 * specific series". CLAUDE.md §17 forbids exactly this shape, and the dialog was
 * written against the rule.
 *
 * The cosmetic half is that nothing tells you which quote came first. The dangerous
 * half is COLLISIONS: nine thousand possible values, and the id is the quotes PRIMARY
 * KEY written with `.upsert()`. A repeat does not error — it OVERWRITES the quote that
 * already holds that number, which at ~35 quotes is more likely than not (birthday
 * problem), and the row it destroys belongs to a different customer.
 */
describe("Quote numbering — from the document series, not random", () => {
  const quoteId = () => writes.find((w) => w.table === "quotes")!.row.id;

  it("takes its number from next_document_number", async () => {
    fill(false);
    await waitFor(() => expect(tables()).toContain("quotes"));
    expect(quoteId()).toBe("Q-ADPL-2026-27-0001");
  });

  it("never mints a random-looking id again", async () => {
    /* The exact shape of the bug: Q-<4 digits>-<4 digits>. Pinned so a future
       "temporary fallback" cannot quietly bring it back. */
    fill(false);
    await waitFor(() => expect(tables()).toContain("quotes"));
    expect(String(quoteId())).not.toMatch(/^Q-\d{4}-\d{4}$/);
  });

  it("ASKS FOR A QUOTE NUMBER, not an invoice number", async () => {
    /* p_doc_type picks which series is drawn from. Asking for 'invoice' here would burn
       a number out of the statutory GST sequence for a document that is not a tax
       invoice — and CGST Rule 46 requires that sequence to be gap-free. */
    fill(false);
    await waitFor(() => expect(tables()).toContain("quotes"));
    expect(mintedDocTypes).toEqual(["quote"]);
  });

  it("consumes ONE number per sale, and consecutive sales get consecutive numbers", async () => {
    fill(false);
    await waitFor(() => expect(tables()).toContain("quotes"));
    expect(quoteId()).toBe("Q-ADPL-2026-27-0001");
    cleanup();
    writes.length = 0;
    fill(false);
    await waitFor(() => expect(tables()).toContain("quotes"));
    expect(quoteId()).toBe("Q-ADPL-2026-27-0002");
  });

  it("does NOT burn a number when the sale reuses an existing quote", async () => {
    /* Retrying an abandoned sale corrects the quote it already has. Allocating a fresh
       number there would leave a gap for every abandoned Record-payment sheet — and
       gaps in a series are the thing a series exists to prevent. */
    existingQuotes.push({ id: "Q-2026-7395" });
    fill(false);
    await waitFor(() => expect(tables()).toContain("quotes"));
    expect(quoteId()).toBe("Q-2026-7395");
    expect(mintedNumbers).toHaveLength(0);
  });

  it("REFUSES the sale when a number cannot be allocated — no random fallback", async () => {
    /* The tempting shortcut is to fall back to a random id when the RPC fails, which
       would quietly reintroduce the collision this change removed. Better to stop and
       say so (§24: the message names the next step). */
    mintFails = "document series not configured";
    fill(false);
    await new Promise((r) => setTimeout(r, 60));
    /* It was asked for, and refused — no quote, no subscription. */
    expect(mintedDocTypes).toEqual(["quote"]);
    expect(tables()).not.toContain("quotes");
    expect(tables()).not.toContain("subscriptions");
  });
});

/**
 * Picking a customer and then typing a DIFFERENT one must not skip the contact.
 *
 * ─── THE BUG THIS PINS ──────────────────────────────────────────────────────
 * Reported 17 Sep 2026: "FF Impex" was created with no contact at all, on a form that
 * is supposed to refuse exactly that.
 *
 * The contact block was shown or hidden by `needsContact = !selectedCustomerId` — a UI
 * flag meaning "did the operator use the dropdown". That is NOT the same question as
 * "is a new customer about to be created", and the two came apart the moment somebody
 * picked a customer from the dropdown and then typed over the name and domain: the
 * selection id stayed behind, the block stayed hidden, the required-name guard never
 * fired, and the live lookup — correctly — found no match for the new domain and
 * created a customer with nobody on it.
 *
 * Two fixes, and this file asserts both:
 *   · editing the name or the domain DETACHES the dropdown selection, so the block
 *     comes back;
 *   · the real invariant now sits next to the customer INSERT, where it cannot be
 *     bypassed by any future change to the form.
 */
describe("Selecting a customer then typing a different one", () => {
  const renderDialog = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
    </QueryClientProvider>,
  );
  const set = (id: string, v: string) =>
    fireEvent.change(document.querySelector<HTMLInputElement>(`#${id}`)!, { target: { value: v } });

  /** Choose the customer dropdown by the option it offers, not by DOM position. */
  const pickExisting = async (id: string) => {
    let sel: HTMLSelectElement | undefined;
    await waitFor(() => {
      sel = Array.from(document.querySelectorAll<HTMLSelectElement>("form select"))
        .find((s) => Array.from(s.options).some((o) => o.value === id));
      expect(sel).toBeDefined();
    });
    fireEvent.change(sel!, { target: { value: id } });
  };

  it("brings the contact block BACK when the name is typed over", async () => {
    existingCustomerRows.push({ id: "cust-acme", name: "Acme", domain: "acme.in" });
    renderDialog();
    await pickExisting("cust-acme");
    /* Picked from the dropdown — no contact needed, they already have people. */
    expect(document.querySelector("#contactName")).toBeNull();

    /* Now type a different company. This is a NEW customer, whatever the dropdown says. */
    set("custName", "FF Impex");
    expect(document.querySelector("#contactName")).not.toBeNull();
  });

  it("brings it back when the DOMAIN is typed over too", async () => {
    existingCustomerRows.push({ id: "cust-acme", name: "Acme", domain: "acme.in" });
    renderDialog();
    await pickExisting("cust-acme");
    set("subDomain", "ffimpex.in");
    expect(document.querySelector("#contactName")).not.toBeNull();
  });

  it("REFUSES to create a new customer with no contact, even with a stale selection", async () => {
    /* The belt-and-braces half. The dropdown row exists but matches NOTHING that gets
       typed, so the live lookup returns no customer — exactly the FF Impex case. The
       write must not happen. */
    existingCustomerRows.push({ id: "cust-acme", name: "Acme", domain: "acme.in" });
    renderDialog();
    await pickExisting("cust-acme");

    /* Type the new identity, then blank the contact name the detach just revealed. */
    set("custName", "FF Impex");
    set("subDomain", "ffimpex.in");
    set("contactName", "");
    set("pricePerSeat", "1632");
    set("seats", "1");
    set("paymentDueDate", "2026-10-11");
    fireEvent.submit(document.querySelector("form")!);

    await new Promise((r) => setTimeout(r, 60));
    /* No customer, no quote, no subscription — nothing at all. */
    expect(writes).toHaveLength(0);
  });
});

/**
 * An email already on file LINKS that person — it does not refuse, and does not duplicate.
 *
 * ─── HOW THIS CHANGED, TWICE, IN ONE DAY ────────────────────────────────────
 * `contacts_unique_email_per_tenant` says one email is one person. Until 18 Sep 2026
 * `contacts.customer_id` also said one person serves one customer, and the two together
 * made a real arrangement unrepresentable — the same human working for two of your
 * customers. Abhishek hit it creating FF Impex with an address already on Doodh Sang.
 *
 * The morning fix refused the sale before writing anything, which was the right answer
 * to that model. The afternoon fix changed the model: `customer_contacts` links a person
 * to MANY customers, so the same address now attaches the existing person to this
 * customer as well. His words: "a contact can serve multiple customers … existing
 * contact get picked".
 *
 * What these pin is that it LINKS rather than doing either of the two wrong things:
 * refusing (the old behaviour) or inserting a second row for the same human (which the
 * unique index would reject anyway, loudly, at the worst moment).
 */
describe("Duplicate contact email — links the existing person", () => {
  it("attaches the existing person instead of creating a second contact row", async () => {
    /* Somebody else in this tenant already has that address. */
    existingContactRows.push({
      id: "C-EXISTING", full_name: "Anjali Tomar", customer_id: "cust-doodh-sang",
    });
    fill(false);
    await waitFor(() => expect(tables()).toContain("subscriptions"));
    /* A LINK was written, and no new contact row: one email is still one person. */
    expect(tables()).toContain("customer_contacts");
    expect(tables()).not.toContain("contacts");
    const link = writes.find((w) => w.table === "customer_contacts")!.row;
    expect(link.contact_id).toBe("C-EXISTING");
    expect(link.is_primary).toBe(true);
  });

  it("the sale completes — the old behaviour refused it outright", async () => {
    existingContactRows.push({
      id: "C-EXISTING", full_name: "Anjali Tomar", customer_id: "cust-doodh-sang",
    });
    fill(false);
    await waitFor(() => expect(tables()).toContain("subscriptions"));
    expect(tables()).toContain("customers");
    expect(tables()).toContain("quotes");
  });

  it("does NOT link twice when the customer already has contacts", async () => {
    /* Selling again to a customer who already has people: savePrimaryContact stops at
       the "already linked" check, so no second primary is attempted — which the unique
       index would reject. */
    existingCustomerRows.push({ id: "cust-acme", name: "Accesstel", domain: "accesstel.in" });
    existingContactRows.push({
      id: "C-EXISTING", full_name: "Ranjeet Kumar", customer_id: "cust-acme",
    });
    /* A LINK is what "already has people" means since 20260918090000. */
    existingLinkRows.push({ id: "LINK-1" });
    fill(false);
    await waitFor(() => expect(tables()).toContain("subscriptions"));
    expect(tables()).not.toContain("customer_contacts");
    expect(tables()).not.toContain("contacts");
  });

  it("creates the person AND the link when nobody matches", async () => {
    fill(false);
    await waitFor(() => expect(tables()).toContain("subscriptions"));
    expect(tables()).toContain("contacts");
    expect(tables()).toContain("customer_contacts");
    /* A contact with no link serves nobody — the invoice-recipient resolver reads the
       link table, so the pair must be written together. */
    const link = writes.find((w) => w.table === "customer_contacts")!.row;
    const person = writes.find((w) => w.table === "contacts")!.row;
    expect(link.contact_id).toBe(person.id);
  });
});

describe("Selecting a customer then typing a different one", () => {
  const renderDialog = () => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AddSubscriptionDialog open onOpenChange={() => {}} onNeedsPayment={() => {}} />
    </QueryClientProvider>,
  );
  const set = (id: string, v: string) =>
    fireEvent.change(document.querySelector<HTMLInputElement>(`#${id}`)!, { target: { value: v } });

  /** Choose the customer dropdown by the option it offers, not by DOM position. */
  const pickExisting = async (id: string) => {
    let sel: HTMLSelectElement | undefined;
    await waitFor(() => {
      sel = Array.from(document.querySelectorAll<HTMLSelectElement>("form select"))
        .find((s) => Array.from(s.options).some((o) => o.value === id));
      expect(sel).toBeDefined();
    });
    fireEvent.change(sel!, { target: { value: id } });
  };

  it("brings the contact block BACK when the name is typed over", async () => {
    existingCustomerRows.push({ id: "cust-acme", name: "Acme", domain: "acme.in" });
    renderDialog();
    await pickExisting("cust-acme");
    /* Picked from the dropdown — no contact needed, they already have people. */
    expect(document.querySelector("#contactName")).toBeNull();

    /* Now type a different company. This is a NEW customer, whatever the dropdown says. */
    set("custName", "FF Impex");
    expect(document.querySelector("#contactName")).not.toBeNull();
  });

  it("brings it back when the DOMAIN is typed over too", async () => {
    existingCustomerRows.push({ id: "cust-acme", name: "Acme", domain: "acme.in" });
    renderDialog();
    await pickExisting("cust-acme");
    set("subDomain", "ffimpex.in");
    expect(document.querySelector("#contactName")).not.toBeNull();
  });

  it("REFUSES to create a new customer with no contact, even with a stale selection", async () => {
    /* The belt-and-braces half. The dropdown row exists but matches NOTHING that gets
       typed, so the live lookup returns no customer — exactly the FF Impex case. The
       write must not happen. */
    existingCustomerRows.push({ id: "cust-acme", name: "Acme", domain: "acme.in" });
    renderDialog();
    await pickExisting("cust-acme");

    /* Type the new identity, then blank the contact name the detach just revealed. */
    set("custName", "FF Impex");
    set("subDomain", "ffimpex.in");
    set("contactName", "");
    set("pricePerSeat", "1632");
    set("seats", "1");
    set("paymentDueDate", "2026-10-11");
    fireEvent.submit(document.querySelector("form")!);

    await new Promise((r) => setTimeout(r, 60));
    /* No customer, no quote, no subscription — nothing at all. */
    expect(writes).toHaveLength(0);
  });
});

/**
 * ─── NO CONTACT, NO CUSTOMER — AND NO CUSTOMER, NO SUBSCRIPTION ──────────────
 *
 * Abhishek, 18 Sep 2026: "make sure without contact customer not created and without
 * customer subscription not be created".
 *
 * The blanks are already covered above, and they are the easy half: nothing has been
 * written when the form refuses. The hard half is the contact step failing AFTER the
 * customer row is in — a DB refusal, a dropped connection, a policy. The browser cannot
 * wrap these inserts in a transaction, so the rule is kept by compensating: the customer
 * created moments ago by this same submit is deleted again.
 *
 * Without this the failure mode is silent and permanent. The customer sits on the books
 * looking complete, and the first sign of trouble is a payment reminder that goes to
 * nobody — which is exactly what "the contact was quietly discarded" cost before.
 */
describe("Without a contact, the customer is not created either", () => {
  it("DELETES the customer it just created when the contact insert fails", async () => {
    insertFailsOn = "contacts";
    fill(false);

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0].table).toBe("customers");
    /* The very row this submit wrote — not some other customer. */
    expect(deletes[0].id).toBe(writes.find((w) => w.table === "customers")!.row.id);
  });

  it("writes no quote and no subscription when the contact fails", async () => {
    insertFailsOn = "contacts";
    fill(false);

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(tables()).not.toContain("quotes");
    expect(tables()).not.toContain("subscriptions");
  });

  it("also undoes the customer when the LINK fails, not just the person", async () => {
    /* The nastiest shape: contacts accepted, customer_contacts refused. The customer
       page would show a person while the invoice lookup — which reads only the link —
       finds nobody. A contact that serves nobody is not a contact. */
    insertFailsOn = "customer_contacts";
    fill(false);

    await waitFor(() => expect(deletes).toHaveLength(1));
    expect(deletes[0].table).toBe("customers");
    expect(tables()).not.toContain("subscriptions");
  });

  it("NEVER deletes a customer that already existed", async () => {
    /* An existing customer has history — subscriptions, invoices, payments. Whatever
       went wrong with a contact, removing them is never the answer. Here they already
       have people, so the contact step is a no-op and the sale goes through. */
    existingCustomerRows.push({ id: "CUST-OLD", name: "Accesstel", domain: "accesstel.in" });
    existingLinkRows.push({ id: "LINK-EXISTING" });
    insertFailsOn = "contacts";
    fill(false);

    await waitFor(() => expect(tables()).toContain("subscriptions"));
    expect(deletes).toHaveLength(0);
    expect(writes.find((w) => w.table === "subscriptions")!.row.customer_id).toBe("CUST-OLD");
  });
});

describe("Without a customer, no subscription", () => {
  it("every subscription written carries the customer that was just resolved", async () => {
    /* The guard itself is unreachable through the UI by design — customerId is either
       an existing match or a row this submit inserted. This asserts the property it
       protects, which is the thing that must stay true however the code above changes. */
    fill(false);

    await waitFor(() => expect(tables()).toContain("subscriptions"));
    const sub = writes.find((w) => w.table === "subscriptions")!.row;
    const cust = writes.find((w) => w.table === "customers")!.row;
    expect(sub.customer_id).toBe(cust.id);
    expect(sub.customer_id).toBeTruthy();
  });

  it("writes the customer BEFORE the subscription, never the other way round", async () => {
    fill(false);

    await waitFor(() => expect(tables()).toContain("subscriptions"));
    const order = tables();
    expect(order.indexOf("customers")).toBeLessThan(order.indexOf("subscriptions"));
    /* And the contact lands between them, so a subscription can never exist before
       somebody is on the hook to receive its invoice. */
    expect(order.indexOf("customer_contacts")).toBeLessThan(order.indexOf("subscriptions"));
  });
});
