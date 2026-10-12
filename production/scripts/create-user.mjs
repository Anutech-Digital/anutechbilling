/**
 * One-time script — create the first user + tenant for ResellerOS.
 * Uses service_role to bypass RLS + email confirmation.
 *
 * Run: node scripts/create-user.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// Read .env.local manually (no dotenv dep)
const env = Object.fromEntries(
  readFileSync(".env.local", "utf-8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const idx = l.indexOf("=");
      const k = l.slice(0, idx).trim();
      const v = l.slice(idx + 1).trim().replace(/^"|"$/g, "");
      return [k, v];
    })
);

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("❌ Missing env vars. Check .env.local");
  process.exit(1);
}

// Inputs
const USER_EMAIL = "pardeep@anutech.in";
/* R-059: never a password in source. Pass it for this one run:
     NEW_USER_PASSWORD='…' node scripts/create-user.mjs */
const USER_PASSWORD = process.env.NEW_USER_PASSWORD;
if (!USER_PASSWORD) {
  console.error("❌ Set NEW_USER_PASSWORD for this run (never write it in the file).");
  process.exit(1);
}
const USER_NAME = "Pardeep Sharma";
const COMPANY_NAME = "Demo Co Pvt Ltd";
const GSTIN = "27AABCE9876D1Z3";

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 1. Create auth user (with email_confirm: true to skip confirmation)
  console.log(`Creating auth user ${USER_EMAIL}…`);
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: USER_EMAIL,
    password: USER_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: USER_NAME },
  });

  if (authError) {
    console.error("❌ Auth create failed:", authError.message);
    process.exit(1);
  }
  console.log("✅ Auth user created:", authData.user.id);

  // 2. Create their own tenant (fresh start, NOT linked to any seeded tenant)
  console.log("Creating tenant…");
  const { data: tenant, error: tenantError } = await supabase
    .from("tenants")
    .insert({
      name: COMPANY_NAME,
      gstin: GSTIN,
      state: "Maharashtra",
      state_code: "27",
      email: USER_EMAIL,
    })
    .select()
    .single();

  if (tenantError) {
    console.error("❌ Tenant create failed:", tenantError.message);
    process.exit(1);
  }
  console.log("✅ Tenant created:", tenant.id);

  // 3. Link auth user to tenant via public.users
  console.log("Linking user to tenant…");
  const initials = USER_NAME.split(/\s+/).map((s) => s[0].toUpperCase()).slice(0, 2).join("");

  const { error: userError } = await supabase.from("users").insert({
    id: authData.user.id,
    tenant_id: tenant.id,
    email: USER_EMAIL,
    full_name: USER_NAME,
    initials,
    role: "owner",
    color: "amber",
  });

  if (userError) {
    console.error("❌ User link failed:", userError.message);
    process.exit(1);
  }

  console.log("\n✅ DONE!");
  console.log("─────────────────────────────────────");
  console.log("Email:    ", USER_EMAIL);
  console.log("Password: ", USER_PASSWORD);
  console.log("Tenant:   ", COMPANY_NAME);
  console.log("Tenant ID:", tenant.id);
  console.log("Role:     owner");
  console.log("─────────────────────────────────────");
  console.log("\n🚀 Now go to http://localhost:3000/login and sign in!");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
