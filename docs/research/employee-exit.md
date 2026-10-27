# Employee exit and full & final settlement (R-1896)

Research note, 25 Oct 2026. Pardeep asked: "employee jab job chhodkar jayega to usko logically manage karne ka bhi system banao".

This note is a working summary for building the feature. It is not legal advice. Before a rule goes into a calculation, check it against the Act or a CA (Hitesh).

## 1. Indian rules that shape the flow

| Topic | Rule | What it means for the app |
|---|---|---|
| **F&F deadline** | Code on Wages 2019, s.17(2). In force from 21 Nov 2025 together with the other three labour codes. When an employee is removed, dismissed, retrenched, resigns or becomes unemployed because the establishment closes, their **wages must be paid within 2 working days**. The old Payment of Wages Act applied this to fewer cases. | Show a deadline of last working day + 2 working days on the F&F and on Today. Gratuity (30 days, below) and PF have their own clocks. |
| **Notice period** | Comes from the appointment letter or company policy, usually 30 days or 1–3 months. If the employee serves less, the employer may recover pay for the short days ("notice pay recovery" or buyout). The employer can also waive the shortfall. | Store the notice days in policy. When the exit is started, shortfall = notice days − (last working day − resignation date + 1). F&F recovery = shortfall × monthly gross ÷ 30 (or ÷ days in the month, set by policy). Allow a waiver. |
| **Final month's salary** | Pay pro-rata up to the last working day, less LOP. | Use `lib/payroll/proration.ts` `prorateSalary(gross, days to the last working day, days in the month)`. |
| **Leave encashment** | Unused earned leave is paid at basic (+DA) ÷ 26 or ÷ 30, per policy. On retirement or resignation it is tax-exempt up to ₹25 lakh over the person's lifetime under **s.10(10AA)(ii)** (limit raised from ₹3 lakh by CBDT notification, 24 May 2023). Government employees get full exemption. Under the new tax regime, s.10(10AA) for non-government employees stays available. | Balance = the leave allowance this financial year (pro-rata, already in screens.tsx) − leave taken. Encashment = balance × (basic + DA) ÷ 26. The taxable part goes into the TDS calculation. |
| **Gratuity** | Payment of Gratuity Act 1972: eligible after **5 years** of continuous service. A year counts if the person worked 240 days in it, and a final part-year of more than 6 months counts as a full year. Death or disablement needs no minimum. Formula for a covered establishment: **15 ÷ 26 × last drawn (basic + DA) × completed years**. The statutory ceiling is **₹20 lakh**, and the tax-exempt limit under s.10(10)(ii) is also ₹20 lakh. Payment is due **within 30 days** of it becoming payable, with interest after that. The Code on Social Security 2020 (also in force from 21 Nov 2025) makes **fixed-term employees eligible after 1 year**, and its 50% "wages" definition can raise the base. | `gratuityFor({ basicDa, joining, lastDay, reason, fixedTerm })` returns eligibility, years and amount, with the ₹20 lakh cap. Owner example: 6 years at ₹1,05,000 gross with basic ₹52,500 gives 15/26 × 52,500 × 6 = **₹1,81,731**. |
| **Advances and loans** | An outstanding salary advance or loan may be deducted from F&F with the employee's consent, which the loan agreement usually gives. Code on Wages s.18 allows deductions for advances and loans. | Take the open balance from `employee_loans` (R-1871 / R-1873) and record the recovery as a repayment row in the same RPC. Keep the existing `pay_salary` rule: a deduction never exceeds what is outstanding. |
| **Unreturned assets** | Recover from F&F only with consent or under policy, and record the value. | Read the open rows of `employee_assets` (lost or damaged items carry a value). |
| **TDS on F&F** | **s.192**: the F&F is salary. Compute tax for the whole year (salary paid so far + F&F, less the exemptions above), deduct the balance, report it in the 24Q for that quarter, and issue **Form 16** after the year ends (due by 15 June). | `lib/payroll/income-tax.ts` already projects the year's tax. For F&F, project the actual paid-to-date plus the F&F, not 12 months. |
| **PF exit** | The employer enters the **date of exit** and a reason code (C cessation / S superannuation / R retirement / D death / P permanent disablement) on the EPFO unified portal, or in the ECR for the month after exit. Without that the employee cannot withdraw or transfer. | Put the exit date and reason on the employee, show them in the ECR/PF register (`lib/payroll/ecr.ts`), and add a checklist item "Mark exit on EPFO". |
| **ESI exit** | The IP stays covered until the end of the contribution period. The employer records the date of leaving on the ESIC portal. | Add a checklist item, and stop ESI from the month after exit. |
| **Letters** | A relieving letter (the release from duty, with the last working day) and an experience letter (tenure and role). These are customary rather than statutory in most states. State Shops & Establishments Acts and the Industrial Employment (Standing Orders) Act require a **service certificate** when asked. | Generate PDFs from the company letterhead and save them to the employee's Documents (`relieving_letter` type, already there). |
| **Records** | Wage and attendance records must be kept for years (3–8 depending on the law), so an exit must **never delete** the employee. | Exit is a state change; the history stays. A person can be rehired. |

Sources (checked 25 Oct 2026):
- Code on Wages s.17(2) and the 21 Nov 2025 commencement: [LiveLaw — "Two working days"](https://www.livelaw.in/articles/two-working-days-code-wages-employee-final-settlement-552780), [PocketHRMS — 2-day F&F under the labour codes](https://www.pockethrms.com/blog/2-day-full-and-final-settlement-under-new-labour-codes-2025/), [PocketHRMS F&F guide 2026](https://www.pockethrms.com/blog/full-and-final-settlement/). These are vendor and legal blogs, so check the Gazette text before quoting the deadline to a client.
- Gratuity, leave encashment, TDS and PF: Payment of Gratuity Act 1972 s.4; Income-tax Act s.10(10), s.10(10AA) (CBDT Notification 31/2023, 24 May 2023), s.192; EPFO unified portal "Mark Exit". These are written from known statute and were not re-fetched today. **Hitesh/CA to confirm the ₹ limits before the F&F card ships.**

## 2. How others do it

Taken from their public help docs, not hands-on.

- **Zoho Payroll**: on the employee, "Initiate Exit" asks for the last working day, the reason and a "personal email". Then "Settle via Final Settlement" runs a one-off pay run for that employee: pro-rata salary, leave encashment, gratuity, notice pay, and other earnings or deductions. It is approved and paid like a pay run, the employee is excluded from later pay runs, and the payslip and Form 16 stay available.
- **RazorpayX Payroll**: "Dismiss employee" asks for the last working day. The final month's salary is pro-rated automatically, an F&F section adds leave encashment, gratuity and deductions, and access to the payroll portal ends after the last day.
- **Keka**: an exit request (by the employee or HR) goes through approvals. Then come an exit interview, a **clearance checklist by department** (IT assets, finance dues, access), an F&F settlement screen (salary, encashment, gratuity, recoveries, TDS), letters from templates, and the employee is moved to "Exited". This is the most complete flow and our model.
- **greytHR**: resignation, then notice-period tracking, then F&F with a settlement letter, PF exit and ESI exit.

All of them share one pattern: **exit is one guided flow on the employee**, the final month is pro-rated to the last day by itself, F&F is a single settlement document with lines, and nothing is deleted.

## 3. Audit of our app (25 Oct 2026, `anutech/manager-pardeep` b88f1eed)

| Area | Today | Gap |
|---|---|---|
| Employee record (`employees`) | `is_active`, `joining_date`, `leave_allowance`, `basic_monthly` / `da_monthly`. | **No exit date, last working day, reason, resignation date or notice days.** The only way to show someone left is to untick "Active employee". |
| Payroll tab (`accounting/payroll/screens.tsx` PayrollTab) | Lists `is_active` employees; pro-rates only for the current month (`daysElapsedInPeriod`). | A person leaving on 15 Oct either stays "active" (and shows up in Nov, Dec and later) or is unticked, which drops them from **Oct** before their last salary is paid. Nothing pro-rates to the last day. The `pay_salary` RPC does not check exit at all. |
| Login (`users.employee_id`, `users.is_active`) | R-722: `users.is_active = false` sets `current_tenant_id()` to NULL and the middleware ends the session. | **Unticking the employee does not touch their login.** The owner must separately deactivate them on /team on the right day; there is no "on the last day" option. **Proven** in `supabase/tests/r1896_employee_exit.test.sql` part 0: an inactive employee whose linked login is still active still gets their tenant. |
| Vault (`vault_passwords`, personal vault) | RLS uses `current_tenant_id()` plus owner/manager role; the middleware blocks deactivated users. | It follows the login, so it has the same gap. `vaultGate` (`api/vault/vault-access.ts`) did not check `is_active`. |
| Advances and loans (R-1871/R-1873) | Outstanding balance and recovery in `pay_salary`. | No F&F step recovers the balance; the exit checklist only shows it. |
| Assets (`employee_assets`, `lib/payroll/employee-assets.ts`) | Exit checklist for devices, logins/SIM, keys and loan, with F&F meaning "unpaid payslips" and relieving letter meaning "upload". | Not tied to an exit date or to F&F; no letter generation. |
| Customers/leads/tasks | R-1528 reassign pattern exists for leads. | Exit has no handover step; an exited rep keeps owning leads. |
| Attendance kiosk, public expense-claim page | Filter on `employees.is_active`. | They do not know the exit date (handled in a card). |

## 4. One flow (the design)

On Employee → **Start exit** (owner only):

1. **Last working day** (default: today + notice days), **reason** (Resigned / Terminated / Retired / Absconding / Death / Contract ended / Other), resignation date, optional note.
2. **Notice**: notice days from policy (default 30) → shortfall days shown, with a recover/waive choice (card).
3. **Checklist** (one screen, grows card by card):
   - login, sessions and vault end on the last day (slice 1, automatic);
   - company assets returned (existing `employee_assets`);
   - customers/leads/tasks handed to a teammate (R-1528 pattern).
4. **F&F sheet**, auto-calculated: pro-rata salary to the last day + leave encashment + gratuity (if eligible) + bonus/incentive − notice recovery − advance/loan − unreturned assets − TDS = **net payable**, line by line.
5. **Approve** → one atomic RPC (§17b): salary expense and liabilities, loan repayments, the F&F payslip row (`salary_payments` kind `fnf`). Payment is matched to the bank line later in reconcile (R-1831/R-1895 link).
6. **Letters**: relieving and experience letters as PDF on the letterhead, saved to Documents.
7. The employee shows **Exited** after the last day, is left out of every later payroll, and keeps all history (rehire = cancel exit / new joining date).

Primary button at each stage = the next step (Start exit → Settle F&F → Pay → Letters). English UI, fits 1280 px.

## 5. Slice 1 (built under R-1896)

- `employees.exit_date` (last working day), `exit_reason`, `resignation_date`, `exit_note`, `exit_started_at`.
- `users.access_ends_on`: the linked login works through that IST day and is off from the next. This needs **no cron**: `current_tenant_id()` and the middleware compare it with the IST date on every request. The vault, every RLS policy and every SECURITY DEFINER guard follow automatically.
- RPCs `start_employee_exit` and `cancel_employee_exit` (owner only, atomic). The salary guard trigger refuses a payslip for any month after the exit month.
- Payroll lists an employee up to and including the exit month only, and pro-rates that month to the last working day.

## 6. Next cards (on the board, ranks 0.351–0.357 right after R-1896)

| Card | Slice |
|---|---|
| R-1945 | Notice period policy + shortfall recovery / waiver |
| R-1946 | F&F calculator (pro-rata, leave encashment, gratuity, recoveries, TDS) |
| R-1947 | F&F approve → one atomic RPC + bank reconcile + 2-working-day deadline on Today |
| R-1948 | Relieving + experience letter PDF → Documents |
| R-1949 | After the exit day: kiosk / expense-claim / pickers, PF-ESI exit date, Form 16 |
| R-1950 | Hand over leads / customers / tasks (R-1528 pattern) |
| R-1951 | Exit checklist tied to exit date + F&F status |
