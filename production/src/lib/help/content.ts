/**
 * Help & Tutorial content — the single source for the /help center.
 *
 * Structured as sections → topics so the page can search + render it. Each
 * topic explains ONE feature: what it is, when to use it, the exact steps, and
 * a concrete example. Written in plain Hinglish-friendly English for a
 * non-technical reseller. Keep it grounded in what the app actually does.
 */

export interface HelpTopic {
  /** Short question-style title (also the search key). */
  q: string;
  /** What it is / why it matters — 1-3 sentences. */
  what: string;
  /** Exact click-path steps. */
  steps: string[];
  /** A concrete worked example. */
  example: string;
}

export interface HelpSection {
  id: string;
  title: string;
  icon: string;       // Icon registry name
  blurb: string;
  topics: HelpTopic[];
}

export const HELP_SECTIONS: HelpSection[] = [
  {
    id: "start",
    title: "Getting started",
    icon: "rocket",
    blurb: "What ResellerOS is, and how to find your way around.",
    topics: [
      {
        q: "What is ResellerOS and who is it for?",
        what: "ResellerOS runs your whole cloud-reselling business in one app — from a lead, to a quote, to payment, to the subscription, invoice and renewal, plus your accounting, GST, and payroll. It is built for Indian resellers of Google Workspace, Microsoft 365 and Zoho.",
        steps: [
          "Think of the left sidebar as your business, top to bottom: Sales → Revenue → Purchases → Accounting → Payroll → Engage.",
          "You don't need every module on day one — start with Sales + Revenue (the money flow).",
        ],
        example: "You get a WhatsApp enquiry for 10 Google Workspace seats → create a lead → send a quote → record the payment → the app auto-creates the customer, subscription, invoice, and sets the renewal reminder.",
      },
      {
        q: "First-time setup — what to fill in first",
        what: "A few one-time settings make every document correct: your business name, GSTIN, state, and bank account. Your GST state drives whether invoices show CGST+SGST or IGST.",
        steps: [
          "Go to Settings → fill business name, GSTIN, address, and state.",
          "Go to Accounting → Banking → Add account → add your main bank account (and Cash / Petty cash).",
          "Optional: Settings → integrations to connect WhatsApp, email (Resend), and Gemini AI.",
        ],
        example: "Set state = Delhi (07). Now a sale to a Delhi customer shows CGST 9% + SGST 9%; a sale to Maharashtra shows IGST 18% — automatically.",
      },
      {
        q: "Finding things — search and navigation",
        what: "The sidebar groups every screen; the top search bar jumps to any customer, lead, quote, or invoice.",
        steps: [
          "Click a sidebar group (e.g. Revenue) to expand its screens.",
          "Press the search bar (⌘K / Ctrl-K) and type a customer or invoice number.",
        ],
        example: "Type “Rakesh” in search → jump straight to that customer's 360 view with their subscriptions, invoices and activity.",
      },
    ],
  },
  {
    id: "sales",
    title: "Sales — leads to customers",
    icon: "target",
    blurb: "Capture enquiries, work the pipeline, and convert to customers.",
    topics: [
      {
        q: "Leads — capturing a new enquiry",
        what: "A lead is a potential customer you haven't billed yet. Leads come in from your enquiry form, forwarded emails (auto-read by AI), WhatsApp, or you add them manually.",
        steps: [
          "Sales → Leads → Add Lead — enter company, contact, plan, seats.",
          "Or share your enquiry form (Leads → Share) so enquiries create leads automatically.",
        ],
        example: "Add lead: “maal ji · 10 seats · Google Workspace Business Starter · ₹38,232”. It shows in Leads with a Call / WhatsApp / Email button.",
      },
      {
        q: "Deal Pipeline — moving a deal forward",
        what: "The pipeline is a drag-drop board of your qualified deals by stage (Quote Sent → Demo → Trial → Won). It shows what to chase.",
        steps: [
          "Sales → Deal Pipeline. Drag a card to a new stage to update it.",
          "Click a card to open the lead drawer — Call / WhatsApp / Record payment / Mark accepted are right there.",
        ],
        example: "A “Quote Sent” deal → click it → the drawer shows Record payment now, Mark accepted (no payment yet), and Mark rejected — so you act without leaving the page.",
      },
      {
        q: "Tasks — never forget a follow-up",
        what: "Tasks are reminders (call, follow up) tied to a lead, quote or customer. You can assign them to teammates and see everyone's workload.",
        steps: [
          "Sales → Tasks → Add task — set who it's for and when it's due.",
          "Use the chips (Everyone / Mine / per-person) to filter.",
        ],
        example: "Assign “Call maal ji about payment” to yourself, due tomorrow. It shows under Mine and on the lead.",
      },
    ],
  },
  {
    id: "money",
    title: "The money flow (core)",
    icon: "rupee",
    blurb: "Quote → payment → subscription → invoice → renewal. The heart of the app.",
    topics: [
      {
        q: "Creating and sending a quote",
        what: "A quote is a priced offer. Add catalog items (seats × rate), and the app computes GST automatically from the customer's state.",
        steps: [
          "Revenue → Quotes → New (or from a lead: “Send quote”).",
          "Pick the customer/prospect, Add item(s), choose billing cycle, then Save & send (email / WhatsApp).",
        ],
        example: "10 × Google Workspace Business Starter @ ₹3,240/yr = ₹32,400 + 18% GST = ₹38,232. Send via WhatsApp with the PDF.",
      },
      {
        q: "Recording a payment (the key step)",
        what: "When money lands, record it against the quote. This one action auto-creates the customer, starts the 1-year subscription, tracks any balance, and moves the lead to Won.",
        steps: [
          "Open the quote (or the lead drawer) → Record payment now.",
          "Enter amount received (defaults to full), method, and the bank account it landed in → Confirm.",
        ],
        example: "Record ₹38,232 on quote Q-…-0005 → customer “maal ji” is created, a Google Workspace subscription (10 seats) starts today, and its renewal is set for next year.",
      },
      {
        q: "Part-payments and TDS",
        what: "Customers can pay in instalments (partial), and B2B customers may deduct TDS. The app tracks the balance and records the TDS as a government receivable — atomically with the payment.",
        steps: [
          "Record payment → enter the partial amount → the quote shows “Partial”, balance tracked.",
          "If TDS was deducted, toggle TDS on and enter the section/amount before confirming.",
        ],
        example: "Invoice ₹10,000, customer deducts ₹1,000 TDS and pays ₹9,000. Record full ₹10,000 with TDS ₹1,000 → books show ₹1,000 TDS receivable + ₹9,000 in the bank.",
      },
      {
        q: "Invoices — issuing a GST tax invoice",
        what: "Once paid, generate a GST-compliant Tax Invoice. It gets a gap-free serial number (INV-<your code>-<financial year>-<number>), freezes its tax split, and is immutable (you never edit an issued invoice — you correct it with a credit/debit note).",
        steps: [
          "Before your first invoice, set your invoice code (2–4 letters) in Settings → Company → Invoice numbering. It locks once the first invoice is issued.",
          "Open the paid quote → Issue GST invoice (or Revenue → Invoices).",
          "View / Download PDF to share.",
        ],
        example: "INV-SHRM-27-0002 (code SHRM, FY 2026-27, second invoice) for ₹38,232 with CGST ₹2,916 + SGST ₹2,916 — the PDF shows the frozen split even if the customer's address changes later.",
      },
      {
        q: "Subscriptions and renewals",
        what: "Each annual sale becomes a subscription with a renewal date. The app emails timed renewal reminders automatically (T-15, T-12 … T-0) and can auto-suspend after grace.",
        steps: [
          "Revenue → Subscriptions to see MRR, seats, renewal date.",
          "Revenue → Renewals to see who's due; reminders send on their own via the daily job.",
        ],
        example: "A subscription renewing on 15 Sep starts getting reminder emails from 31 Aug; if a cron day is missed it still catches up so no reminder is skipped.",
      },
    ],
  },
  {
    id: "international",
    title: "International / export clients",
    icon: "globe",
    blurb: "Foreign customers, zero-rated GST, and billing in USD/EUR.",
    topics: [
      {
        q: "Selling to a customer outside India (export)",
        what: "A supply to a customer outside India is an export — zero-rated (no GST) when you've filed an LUT. Set the customer's country and the app stops charging GST and shows the export declaration on the invoice.",
        steps: [
          "On the customer (or lead) set Country to the foreign country (e.g. USA).",
          "Build the quote as usual — the totals show “Export → zero-rated under LUT, no GST”.",
        ],
        example: "A US customer, 10 seats = ₹32,400 with no GST added (a domestic quote would be ₹38,232). The invoice carries the LUT / export wording instead of a tax split.",
      },
      {
        q: "Billing in a foreign currency (USD, EUR…)",
        what: "Your books stay in ₹, but the customer can be shown the amount in their currency at your exchange rate.",
        steps: [
          "On an export quote, in the totals pick the currency (USD/EUR/…) and enter the ₹-per-unit rate.",
          "The quote shows the foreign amount; the books keep the ₹ figure.",
        ],
        example: "₹32,400 at ₹83/USD shows the customer $390.36, while your books record ₹32,400.",
      },
    ],
  },
  {
    id: "notes",
    title: "Credit & debit notes",
    icon: "receipt",
    blurb: "Correcting an issued invoice the GST-legal way.",
    topics: [
      {
        q: "Credit note — reducing an invoice",
        what: "You can't edit an issued invoice. To REDUCE it (post-sale discount, over-billing, seats reduced, cancellation) issue a credit note — it lowers what the customer owes and reverses that GST.",
        steps: [
          "Revenue → Invoices → the ⋯ menu on the invoice → Issue credit note.",
          "Enter the amount + reason. The GST split is worked out for you.",
        ],
        example: "Customer drops from 10 to 6 seats mid-term → issue a credit note for the 4 seats (₹5,900) → their balance and your output GST both drop.",
      },
      {
        q: "Debit note — increasing an invoice",
        what: "The opposite of a credit note — issue a debit note to ADD to an invoice when you under-charged or there's an extra charge.",
        steps: [
          "Revenue → Invoices → ⋯ → Issue debit note.",
          "Enter the additional amount + reason.",
        ],
        example: "You billed 8 seats but they actually used 10 → issue a debit note for 2 seats (₹2,360) → the amount owed goes up.",
      },
    ],
  },
  {
    id: "purchases",
    title: "Purchases & vendors",
    icon: "cart",
    blurb: "Vendor bills, payments made, expenses, and purchase orders.",
    topics: [
      {
        q: "Recording a vendor bill and paying it",
        what: "A vendor bill is what you owe a supplier (e.g. Google/Microsoft wholesale). Record the bill, then record the payment when you pay it.",
        steps: [
          "Purchases → Vendor Bills → add the bill (vendor, amount, GST).",
          "On the bill → ⋯ Record payment — enter amount, date, and the bank account it went from.",
        ],
        example: "A ₹27,000 wholesale bill from your distributor → record it → when you pay from HDFC, Record payment ₹27,000 → the bill shows Paid and your bank drops.",
      },
      {
        q: "Payments Made — all vendor payments in one place",
        what: "A consolidated feed of every payment you've made to vendors (the purchase-side mirror of Sales → Payments).",
        steps: ["Purchases → Payments Made."],
        example: "See all bill payments this month with vendor, amount, method and the account they were paid from.",
      },
      {
        q: "Expenses vs credit-card spends",
        what: "Day-to-day costs (hosting, software, travel) go under Expenses. If you pay them on a company credit card, add a Credit Card account in Banking and categorise the card spends as expenses.",
        steps: [
          "Purchases → Expenses → add the expense (category, amount, GST, paid-by).",
          "For card spends: Banking → Add account → Credit Card, then categorise its transactions as expenses.",
        ],
        example: "₹5,000 AWS on the company card → record as an expense; when you pay the card bill from the bank, use Transfer (bank → card), NOT a fresh expense (or it double-counts).",
      },
    ],
  },
  {
    id: "banking",
    title: "Banking & accounting",
    icon: "layout",
    blurb: "Accounts, credit cards, reconciliation, and reports.",
    topics: [
      {
        q: "Bank accounts, transfers and credit cards",
        what: "Add each bank + cash account; the balance builds from your opening balance + imported/recorded transactions. A credit card is a liability account — its balance is what you owe.",
        steps: [
          "Accounting → Banking → Add account (Current / Savings / Cash / Credit Card).",
          "Move money between accounts with “Move money / withdraw” (Transfer).",
        ],
        example: "Add HDFC Current + a Credit Card showing ₹0 owe. Spend on the card → owe goes up. Pay the card bill: Transfer HDFC → Card, so both drop and nothing double-counts.",
      },
      {
        q: "Reconciling a bank statement",
        what: "Import your bank statement (CSV) and match each line to a payment, bill, expense or transfer, so your app balance equals your real bank balance.",
        steps: [
          "Accounting → Banking → open an account → Import statement (CSV).",
          "For each line, accept the suggested match or categorise it.",
        ],
        example: "A ₹38,232 credit imports → the app suggests it matches maal ji's payment → accept, and it's reconciled.",
      },
      {
        q: "Reports — P&L, Balance Sheet, GST",
        what: "The app computes your Profit & Loss, Balance Sheet, and GST summary from your real records — no manual entry.",
        steps: [
          "Accounting → P&L Report / Balance Sheet / GST Reports.",
          "GST → export GSTR-1 ready figures from the invoices you issued.",
        ],
        example: "Balance Sheet auto-shows cash & bank, receivables, TDS receivable, and liabilities like GST payable, credit-card owed, and loans.",
      },
    ],
  },
  {
    id: "payroll",
    title: "Team & payroll",
    icon: "users",
    blurb: "Employees, salaries, ESI/PF, attendance and leave.",
    topics: [
      {
        q: "Running payroll (salary, ESI, PF)",
        what: "Add employees, then run payroll each month. The app computes ESI and PF (employee + employer), and posts the salary + statutory dues.",
        steps: [
          "Payroll → Employees → add each employee (mark ESI / PF applicable).",
          "Payroll → Payroll → run the month → pay from a bank account.",
        ],
        example: "Salary ₹20,000 with ESI/PF applicable → the app splits employee deductions + your employer contribution, and tracks the ESI/PF you owe the government.",
      },
      {
        q: "Attendance and leave",
        what: "Track attendance (including a kiosk mode) and leave balances, so payroll and leave stay in sync.",
        steps: [
          "Payroll → Attendance (or the Kiosk for a shared device).",
          "Payroll → Leave to manage balances.",
        ],
        example: "Mark a day's attendance in the kiosk; the month's leave and present-days feed into payroll.",
      },
    ],
  },
  {
    id: "engage",
    title: "Engage — WhatsApp & campaigns",
    icon: "send",
    blurb: "Reach customers on WhatsApp and email.",
    topics: [
      {
        q: "WhatsApp inbox and quote sending",
        what: "Once WhatsApp Business is connected, send quotes/reminders and see replies in one inbox.",
        steps: [
          "Connect it in Settings → integrations.",
          "Send from a quote (Send via WhatsApp) or reply from Engage → WhatsApp Inbox.",
        ],
        example: "Send a quote PDF to a customer on WhatsApp; their reply lands in the inbox against that customer.",
      },
      {
        q: "Email campaigns",
        what: "Send a bulk, personalised email to a group (e.g. all customers, or a stage) using a template with merge fields.",
        steps: [
          "Engage → Campaigns → compose (pick audience, template, offer).",
          "Preview, then send.",
        ],
        example: "A “Year-end offer” to all customers with {{name}} and a discount code — sent to everyone in one go, tracked per recipient.",
      },
    ],
  },
];
