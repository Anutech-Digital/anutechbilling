# Online payment fee (Razorpay) — who pays it

Spec started 3 Nov 2026 (manager session: app audit + web research). Owner ask (Pardeep):
"Razorpay fee customer ko deni chahiye, par kai cases me hum dete hai — isko manage karne ka system."

## Goal

The owner sets once who pays the online payment fee, with exceptions per customer and per bill;
every online payment records who bore the fee; when the customer bears it, they pay bill + fee
and our net cost is about ₹0. Bank transfer stays free.

## Users & flows

1. **Owner** — Settings → Company → *Online payment fee*: default bearer (Customer / We pay),
   rate % (default 2), optional "We pay when bill ≥ ₹X", line text. Example on screen:
   ₹11,800 bill → fee ₹242 + GST ₹44 → customer pays ₹12,086.
2. **Owner / manager** — Customer page → *Online fee*: Default / We absorb for this customer (+ reason).
3. **Owner / manager** — Quote or invoice → *Waive online fee for this bill* (+ reason).
4. **Customer** — pay page / pay link / reminder shows "₹X bill + ₹Y online fee = ₹Z — or pay ₹X
   by bank transfer (free)".
5. **Accountant** — monthly fee report: absorbed vs recovered, by customer and method (R-2418).

## Rules

1. One pure function `onlineFeeFor(bill, customer, settings) → {bearer, fee, gst, reason}`
   (`src/lib/payments/online-fee.ts`) decides; order: bill waiver > customer absorbs >
   company default "We pay" > "we pay when bill ≥ ₹X" > customer pays (reasons `bill_waived`,
   `customer_absorbs`, `company_default`, `above_threshold`, `customer_pays`).
2. **Gross-up** so Razorpay's fee on the fee is covered too: fee base f = r·B ÷ (1 − r·1.18),
   r = rate (2%) → about 2.05% of the bill; GST 18% on the fee; rupee rounding tested.
3. The recovered fee is an **incidental charge** (CGST s.15(2)(c)) — part of the value of the same
   supply: same SAC and GST rate as the bill. Our bills are 18% today, so the code uses 18%
   (`ONLINE_FEE_GST_PCT`) in the fee and the gross-up; a bill at another rate (0% / export /
   exempt) needs that rate passed in before R-2417 charges it.
4. Paid online **before** the invoice (quote → pay → invoice): the fee is a line on that invoice.
   Invoice **already issued**, then paid by link: issue a **debit note** (s.34) — never edit an issued invoice.
5. On capture the bill is paid for the bill amount exactly (no extra credit left); fee income +
   its GST booked once; a refund reverses the fee too.
6. Absorbed fee keeps today's booking: Razorpay's fee = Bank Charges expense, GST as input credit.
7. Customer deducts TDS on the fee → TDS receivable, like other TDS. No TDS (194H) on gateway fees we pay.
8. Book gross, never net: receipt in full; gateway fee a separate expense.

## Data

- Built (R-045): `payments.gateway_fee`, `gateway_fee_gst`; one expense per payment
  `EXP-RZPFEE-<payment>` (Bank Charges); settlement section reconciles one payout to many payments.
- R-2416 (built): `online_fee_waived` / `online_fee_waive_reason` on quotes and invoices; tenant columns
  `online_fee_bearer`, `online_fee_rate_pct`, `online_fee_waive_above`, `online_fee_line_text`;
  `customers.online_fee_override` / `_reason`; `payments.fee_bearer` and `payments.fee_charged`
  (filled on capture by the webhook); `src/lib/payments/online-fee.ts`.
- R-2417: order / link amount = bill + fee when the customer bears it; fee line or debit note.

## Constraints

- Razorpay "Customer Fee Bearer" is account-wide (Support enables it), has no per-order switch and
  breaks UPI Payment Links → Razorpay stays merchant-bears; **the app adds the fee** before
  creating the order or link.
- Standard plan: 2% (UPI, cards, netbanking, wallets), 2.15% corporate cards, about 3% international,
  plus 18% GST. The method is picked inside Razorpay checkout after the amount is fixed, so the app
  uses one rate for every online payment.
- Zero-MDR law binds businesses above ₹50 Cr only — not us.
- Card networks: a convenience fee must be disclosed, separate and not above the real cost.
- If the Razorpay vendor has no GSTIN on the tenant, input credit shows as blocked (R-2418 warns).

## Owner decisions

| Question | Answer | Who / when |
|---|---|---|
| Who pays by default? | Customer, with exceptions per customer / per bill | Pardeep, 3 Nov |
| GST rule, invoice line or debit note, gross-up | Delegated ("jo tumhe sahi lage wo karo but logical"): rules 2–4 above | decided in session, 3 Nov |
| UPI free, only cards charged? | No — method unknown before checkout; one rate online, bank transfer free | decided in session, 3 Nov |
| CA check before live | Hitesh to **check** (not decide): s.15(2)(c) view, SAC on the fee line, debit-note route, no TDS (194H/194J) on gateway fees, ITC from Razorpay's monthly invoice | open |

## Cards graph

```
R-2416 Fee policy + exceptions + fee_bearer ──┬──► R-2417 Charge the fee (checkout, quote pay, links)
                                              ├──► R-2418 Fee report + ITC check
R-2412 (G-COLLECT) ──► R-2415 Pay link per bill ──► R-2417
```

- R-2416 first (no money moves). Then R-2415 and R-2418 in parallel (separate files), R-2417 last.
- R-2415 links are for issued invoices / statements: when the customer bears the fee, the link
  amount is due + fee and the fee goes on a debit note (rule 4) — R-2417 owns that booking.
- Board status is the truth for what is built; this spec does not track it.
- All money cards use Razorpay **test mode** keys on localhost only.
