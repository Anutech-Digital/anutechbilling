import { createClient } from "@supabase/supabase-js";

const url = "https://ontpnqjoysjgrlsukecm.supabase.co";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9udHBucWpveXNqZ3Jsc3VrZWNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyNjc1NjcsImV4cCI6MjA5NDg0MzU2N30.tulYYDQSzq7IpEQCFbP7qjsSUxg4c-0ku5uO80-TKXI";

const supabase = createClient(url, key);

async function main() {
  console.log("=== ANUTECH DIGITAL 50 SEATS WORKFLOW AUDIT ===");

  // 1. Check Customers
  const { data: customers } = await supabase.from("customers").select("*").ilike("name", "%Anutech%");
  console.log("\n1. CUSTOMERS MATCHING 'Anutech':", customers?.length || 0);
  if (customers && customers.length > 0) {
    customers.forEach(c => console.log(`   - ID: ${c.id} | Name: ${c.name} | Email: ${c.contact_email} | GSTIN: ${c.gstin}`));
  }

  // 2. Check Leads
  const { data: leads } = await supabase.from("leads").select("*").ilike("company_name", "%Anutech%");
  console.log("\n2. LEADS MATCHING 'Anutech':", leads?.length || 0);
  if (leads && leads.length > 0) {
    leads.forEach(l => console.log(`   - ID: ${l.id} | Company: ${l.company_name} | Status: ${l.status}`));
  }

  // 3. Check Quotes
  const { data: quotes } = await supabase.from("quotes").select("*").order("created_at", { ascending: false }).limit(20);
  const anutechQuotes = quotes?.filter(q => q.customer_name?.toLowerCase().includes("anutech") || (customers && customers.some(c => c.id === q.customer_id)));
  console.log("\n3. QUOTES FOR ANUTECH:", anutechQuotes?.length || 0);
  if (anutechQuotes && anutechQuotes.length > 0) {
    anutechQuotes.forEach(q => console.log(`   - Quote ID: ${q.id} | Customer: ${q.customer_name} | Amount: ₹${q.amount} | Status: ${q.status} | Payment: ${q.payment_status}`));
  }

  // 4. Check Payments
  const { data: payments } = await supabase.from("payments").select("*").order("created_at", { ascending: false }).limit(20);
  console.log("\n4. RECENT PAYMENTS IN SYSTEM:", payments?.length || 0);
  if (payments && payments.length > 0) {
    payments.slice(0, 5).forEach(p => console.log(`   - Payment ID: ${p.id} | Receipt #: ${p.receipt_number} | Amount: ₹${p.amount} | Method: ${p.method} | Status: ${p.status}`));
  }

  // 5. Check Subscriptions
  const { data: subs } = await supabase.from("subscriptions").select("*").order("created_at", { ascending: false }).limit(20);
  console.log("\n5. RECENT SUBSCRIPTIONS PROVISIONED:", subs?.length || 0);
  if (subs && subs.length > 0) {
    subs.slice(0, 5).forEach(s => console.log(`   - Sub ID: ${s.id} | Product: ${s.product_name} | Seats: ${s.seats} | Status: ${s.status} | Start: ${s.service_start_date} | Renewal: ${s.renewal_date}`));
  }

  // 6. Check Invoices
  const { data: invoices } = await supabase.from("invoices").select("*").order("created_at", { ascending: false }).limit(20);
  console.log("\n6. RECENT INVOICES GENERATED:", invoices?.length || 0);
  if (invoices && invoices.length > 0) {
    invoices.slice(0, 5).forEach(i => console.log(`   - Inv ID: ${i.id} | Customer: ${i.customer_name} | Amount: ₹${i.amount} | Status: ${i.status}`));
  }
}

main().catch(console.error);
