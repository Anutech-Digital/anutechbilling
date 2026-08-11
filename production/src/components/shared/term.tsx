/**
 * <Term> — inline glossary tooltip for accounting jargon.
 *
 * Wrap a jargon word so a non-CA owner can hover/tap for a one-line plain-English
 * explanation. Definitions live in one dictionary here so wording stays consistent
 * everywhere. Usage: <Term k="cogs" /> (uses the default label) or
 * <Term k="cogs">COGS</Term> to override the visible text.
 */
"use client";

import * as React from "react";

import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

type Def = { label: string; hint: string };

export const GLOSSARY = {
  cogs:            { label: "COGS", hint: "Cost of Goods Sold — what you paid for the licenses/products you resell (Google/MS/Zoho). Sits above gross margin." },
  gross_margin:    { label: "Gross margin", hint: "Revenue minus COGS — your profit before running-the-business (operating) expenses." },
  opex:            { label: "Operating expenses", hint: "Costs to run the business — rent, salaries, software, marketing. Deducted after gross margin." },
  net_profit:      { label: "Net profit", hint: "What's left after ALL costs — COGS + operating expenses. The real bottom line." },
  accrual:         { label: "Accrual", hint: "Counted when the invoice/bill is dated, not when cash actually moves. P&L uses this; Cash Flow uses real cash." },
  output_gst:      { label: "Output GST", hint: "GST you collected from customers on your sales. You owe this to the government." },
  input_gst:       { label: "Input GST (ITC)", hint: "GST you PAID to vendors. It's Input Tax Credit — subtracted from output GST, so you pay only the difference." },
  itc:             { label: "ITC", hint: "Input Tax Credit — the GST you paid on purchases, which you can set off against the GST you owe on sales." },
  net_liability:   { label: "Net GST liability", hint: "Output GST − Input GST. Positive = payable to govt; negative = credit carried forward." },
  receivables:     { label: "Receivables", hint: "Money customers still owe you — invoiced but not yet paid." },
  payables:        { label: "Payables", hint: "Money you still owe vendors — bills/expenses recorded but not yet paid." },
  retained:        { label: "Retained earnings", hint: "Accumulated profit kept in the business. Here it's a balancing figure so Assets = Liabilities + Equity." },
  tds:             { label: "TDS", hint: "Tax Deducted at Source — tax withheld from a payment and deposited with the government on the payee's behalf." },
  tds_receivable:  { label: "TDS receivable", hint: "TDS your customers deducted from YOUR payments — you claim it as credit in your income-tax return." },
  mrr:             { label: "MRR", hint: "Monthly Recurring Revenue — the subscription revenue you can expect every month." },
  arr:             { label: "ARR", hint: "Annual Recurring Revenue — MRR × 12." },
  churn:           { label: "Churn", hint: "The rate at which customers cancel/don't renew — lost recurring revenue." },
  reconcile:       { label: "Reconcile", hint: "Match a bank line to the payment/expense it belongs to — so your books agree with the bank." },
  net_worth:       { label: "Net worth", hint: "Total assets − total liabilities. What the business is worth on paper." },
} as const satisfies Record<string, Def>;

export type GlossaryKey = keyof typeof GLOSSARY;

export function Term({ k, children, className = "" }: { k: GlossaryKey; children?: React.ReactNode; className?: string }) {
  const def = GLOSSARY[k];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={`cursor-help underline decoration-dotted decoration-ink-3/50 underline-offset-2 ${className}`}
        >
          {children ?? def.label}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[16rem] text-[12px] leading-relaxed">{def.hint}</TooltipContent>
    </Tooltip>
  );
}
