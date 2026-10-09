/**
 * Home FAQ — question-style headings with self-contained answers, so the page
 * both reassures a buyer and is quotable by search + AI answer engines (the
 * 5 Sep web research: lead with the answer, one fact per Q). Rendered on the
 * home (HomeV2) AND emitted as FAQPage JSON-LD by the home page — kept in this
 * plain data module so the server component can map over it (a client module's
 * exports can't be iterated from the server).
 */
export const HOME_FAQS: readonly { q: string; a: string }[] = [
  {
    q: "Does the price include GST?",
    a: "No — every rate on this page is exclusive of GST, and 18% GST (HSN 998313) is added and shown as a separate line on the invoice. You are invoiced in rupees by Anutech Digital Pvt Ltd (GSTIN 07ABDCA0298H1ZP), so registered businesses can claim input tax credit.",
  },
  {
    q: "Is there a minimum number of mailboxes, and can I mix editions?",
    a: "There is no seat minimum — start with one user. You can also mix editions on the same domain (for example Business Standard for the sales team and Business Starter for everyone else) and still receive one consolidated GST invoice.",
  },
  {
    q: "Where is my data stored?",
    a: "Google Workspace and Microsoft 365 data sits in each vendor's India region where the plan supports it; our own hosting runs on Google Cloud in Mumbai. Domain and mail routing is set up by us so nothing is misconfigured.",
  },
  {
    q: "When am I charged?",
    a: "Nothing is charged until you approve a quote. You pick an edition and seat count, we send a GST quote in rupees, and payment happens by Razorpay (UPI, card or netbanking) only after you say yes. Renewal is at the same published rate — no surprise increase.",
  },
  {
    q: "Who answers when I need help?",
    a: "Support is on WhatsApp in working hours (Mon–Sat, 10:00–19:00 IST), and it is someone who can actually change your account — not a ticket queue or a chatbot. Migrations are done by us, free, at any size.",
  },
];
