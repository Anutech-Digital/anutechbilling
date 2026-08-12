import { createClient } from "@supabase/supabase-js";

const url = "https://ontpnqjoysjgrlsukecm.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9udHBucWpveXNqZ3Jsc3VrZWNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjc1NjcsImV4cCI6MjA5NDg0MzU2N30.tulYYDQSzq7IpEQCFbP7qjsSUxg4c-0ku5uO80-TKXI";

const supabase = createClient(url, key);
const TENANT_ID = "fbb976f1-9090-4f10-9726-0901bd144e42"; // Production tenant

async function main() {
  console.log("=== EXECUTING ANUTECH DIGITAL 50 SEATS REAL TRANSACTION ===");

  // 1. Create or fetch Customer: Anutech Digital
  let customerId;
  const { data: existingCust } = await supabase
    .from("customers")
    .select("id")
    .eq("tenant_id", TENANT_ID)
    .ilike("name", "%Anutech Digital%")
    .maybeSingle();

  if (existingCust) {
    customerId = existingCust.id;
    console.log("1. Existing Customer found:", customerId);
  } else {
    const { data: newCust, error: cErr } = await supabase
      .from("customers")
      .insert({
        tenant_id: TENANT_ID,
        name: "Anutech Digital",
        contact_email: "billing@anutechdigital.com",
        contact_phone: "+91 99999 30300",
        gstin: "07ABDCA0298H1ZP",
        state: "Delhi",
        state_code: "07",
        address: "Plot no. B-9/54 Sector 5, Rohini, Delhi, 110085",
      })
      .select()
      .single();

    if (cErr) throw new Error("Customer insert failed: " + cErr.message);
    customerId = newCust.id;
    console.log("1. Customer created:", customerId, newCust.name);
  }

  // 2. Create Quote for 50 Seats @ 2000 = 100,000 + 18% GST = 118,000
  const quoteId = `Q-ET-2026-27-${Math.floor(1000 + Math.random() * 9000)}`;
  const subtotal = 100000; // 50 seats * 2000
  const taxRate = 18;
  const tax = Math.round(subtotal * 0.18);
  const total = subtotal + tax; // 118,000

  const lineItems = [
    {
      id: "item-gws-starter",
      name: "Google Workspace Business Starter",
      description: "50 Seats Google Workspace Business Email IDs",
      qty: 50,
      rate: 2000,
      cost: 1600,
      commitment: "annual_yearly",
      hsn_sac: "998313",
      domain: "anutechdigital.com",
    },
  ];

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .insert({
      id: quoteId,
      tenant_id: TENANT_ID,
      customer_id: customerId,
      customer_name: "Anutech Digital",
      line_items: lineItems,
      subtotal: subtotal,
      tax_rate: taxRate,
      tax: tax,
      amount: total,
      status: "accepted",
      payment_status: "received",
      payment_amount: total,
      payment_received_at: "2026-08-10T10:30:00Z",
      first_advance_at: "2026-08-10T10:30:00Z",
      created_at: "2026-08-10T10:00:00Z",
    })
    .select()
    .single();

  if (qErr) throw new Error("Quote insert failed: " + qErr.message);
  console.log("2. Quote created:", quote.id, "Amount: ₹" + quote.amount);

  // 3. Record Payment & Receipt Voucher (10 Aug 2026 into Bank Account)
  const rvId = `RV-ET-2026-27-${Math.floor(1000 + Math.random() * 9000)}`;
  const { data: payment, error: pErr } = await supabase
    .from("payments")
    .insert({
      tenant_id: TENANT_ID,
      quote_id: quote.id,
      customer_id: customerId,
      receipt_number: rvId,
      amount: total,
      method: "bank_transfer",
      reference: "NEFT-20260810-ANUTECH-BK",
      notes: "Received ₹1,18,000 into Anutech Digital bank account on 10 Aug 2026 for 50 Google Workspace seats",
      status: "received",
      created_at: "2026-08-10T10:30:00Z",
    })
    .select()
    .single();

  if (pErr) console.log("Payment notice:", pErr.message);
  else console.log("3. Payment Receipt created:", payment.receipt_number, "Amount: ₹" + payment.amount);

  // 4. Provision Subscription (50 Seats, Start: 10 Aug 2026, Renewal: 10 Aug 2027)
  const { data: sub, error: sErr } = await supabase
    .from("subscriptions")
    .insert({
      tenant_id: TENANT_ID,
      customer_id: customerId,
      quote_id: quote.id,
      product_name: "Google Workspace Business Starter",
      seats: 50,
      unit_selling_price: 2000,
      unit_cost_price: 1600,
      annual_value: total,
      mrr_ex_gst: Math.round(subtotal / 12),
      status: "active",
      service_start_date: "2026-08-10",
      renewal_date: "2027-08-10",
      domain: "anutechdigital.com",
      created_at: "2026-08-10T10:30:00Z",
    })
    .select()
    .single();

  if (sErr) console.log("Sub notice:", sErr.message);
  else console.log("4. Subscription provisioned:", sub.id, "50 Seats | Renews: " + sub.renewal_date);

  // 5. Generate Tax Invoice (INV-ET-2026-27-XXXX)
  const invId = `INV-ET-2026-27-${Math.floor(1000 + Math.random() * 9000)}`;
  const { data: inv, error: iErr } = await supabase
    .from("invoices")
    .insert({
      id: invId,
      tenant_id: TENANT_ID,
      quote_id: quote.id,
      customer_id: customerId,
      customer_name: "Anutech Digital",
      amount: total,
      net_payable: 0, // 100% advance adjusted!
      tax_rate: 18,
      status: "paid",
      invoice_date: "2026-08-10",
      due_date: "2026-08-10",
      paid_date: "2026-08-10",
      adjusted_advances: [{ rv_id: rvId, amount: total, date: "2026-08-10" }],
      created_at: "2026-08-10T10:35:00Z",
    })
    .select()
    .single();

  if (iErr) console.log("Invoice notice:", iErr.message);
  else console.log("5. GST Tax Invoice generated:", inv.id, "Amount: ₹" + inv.amount, "Net Payable: ₹" + inv.net_payable);

  console.log("\n=== TRANSACTION SEEDED SUCCESSFULLY ===");
}

main().catch(console.error);
