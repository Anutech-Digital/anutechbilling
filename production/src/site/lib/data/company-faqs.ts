/**
 * Home FAQ since 5 Oct 2026 (R-155): questions a business asks before a custom software
 * project, plus the two about the rest of what Anutech sells. Plain data so the server page
 * can emit it as FAQPage JSON-LD. Every answer is a fact about how we work — no prices,
 * durations or claims we cannot back (the email FAQ lives in home-faqs.ts, on /email).
 */
export const COMPANY_FAQS: readonly { q: string; a: string }[] = [
  {
    q: "How much does custom software cost?",
    a: "It depends on what the software has to do, so we quote after the first call: a fixed price in rupees plus GST, split into milestones with dates. Part is paid in advance and the rest as each milestone is shown to you and accepted — you never pay for work you have not seen.",
  },
  {
    q: "What happens on the first call?",
    a: "You show us how the work is done today — the Excel sheets, registers and WhatsApp groups. We ask questions, then send the requirements back in writing for you to correct. The call is free and there is no obligation.",
  },
  {
    q: "Can it work with what we already use?",
    a: "Usually, yes: Excel and Google Sheets, Gmail or Google Workspace, your website's forms and WhatsApp. We check each one on the first call and write down in the quote exactly what connects to what.",
  },
  {
    q: "Who fixes it when something goes wrong?",
    a: "The same team that built it, on WhatsApp — a person, not a ticket queue — Mon–Sat, 10:00–19:00 IST. After go-live you can take an optional monthly support plan for changes and new features.",
  },
  {
    q: "Do you give a GST invoice?",
    a: "Yes, for every project and every order. You are invoiced in rupees by Anutech Digital Pvt Ltd (GSTIN 07ABDCA0298H1ZP), so a registered business can claim input tax credit.",
  },
  {
    q: "Do you also provide business email, domains and hosting?",
    a: "Yes. We have sold Google Workspace, Microsoft 365 and Zoho since 2014 as a Google Premier Partner, along with domains, web hosting and SSL — published prices, free email migration, and support from the same team.",
  },
];
