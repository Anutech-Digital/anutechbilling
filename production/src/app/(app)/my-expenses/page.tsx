/**
 * Mobile-First Employee Self-Service Expense & Advance Portal (`/my-expenses`).
 *
 * Designed for employees (like Darshan `sales@anutech.in`, Pawan, Ranjeet, Abhishek)
 * to open on their mobile phones or desktop:
 * 1. View their active Advance Balance (e.g. ₹2,000).
 * 2. Record expenses incurred out of their advance (Amount, Category, Notes, Camera Receipt).
 * 3. Track remaining available advance balance in real-time.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { FormField } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { rupee, formatDate } from "@/lib/utils";
import { useEmployeeAdvances, useRecordAdvanceExpense, type EmployeeAdvance } from "@/lib/queries/advances";
import { EXPENSE_CATEGORIES } from "@/lib/queries/expenses";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { istToday } from "@/lib/dates/ist";

function todayISO() {
  return istToday();
}

export default function MyExpensesPage() {
  const [userEmail, setUserEmail] = React.useState<string>("");
  const [userName, setUserName] = React.useState<string>("");

  const { data: advances = [], isLoading } = useEmployeeAdvances();
  const [addExpenseOpen, setAddExpenseOpen] = React.useState(false);
  const [selectedAdv, setSelectedAdv] = React.useState<EmployeeAdvance | null>(null);

  // Fetch logged-in user profile
  React.useEffect(() => {
    async function loadUser() {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (auth?.user) {
        setUserEmail(auth.user.email || "");
        const { data: profile } = await supabase.from("users").select("full_name").eq("id", auth.user.id).single();
        if (profile && profile.full_name) setUserName(profile.full_name);
      }
    }
    void loadUser();
  }, []);

  // Filter advances strictly matching logged-in user (e.g. Darshan / sales@anutech.in)
  const myAdvances = advances.filter((a) => {
    if (!a || a.status !== "active") return false;
    const empNameLower = (a.employee_name || "").toLowerCase();
    const curNameLower = userName.toLowerCase();
    const curEmailLower = userEmail.toLowerCase();

    // Check strict match by employee name or email
    const nameMatch = curNameLower && (empNameLower.includes(curNameLower) || curNameLower.includes(empNameLower));
    const emailMatch = curEmailLower && (
      (curEmailLower.includes("sales") && (empNameLower.includes("darshan") || empNameLower.includes("sales"))) ||
      (curEmailLower.includes("pawan") && empNameLower.includes("pawan")) ||
      (curEmailLower.includes("ranjeet") && empNameLower.includes("ranjeet")) ||
      (curEmailLower.includes("abhishek") && empNameLower.includes("abhishek")) ||
      (curEmailLower.includes("pratik") && empNameLower.includes("pratik")) ||
      (curEmailLower.includes("hitesh") && empNameLower.includes("hitesh"))
    );

    const isSalesUser = curEmailLower.includes("sales") || curNameLower.includes("darshan") || curNameLower.includes("sales");
    const isDarshanAdvance = empNameLower.includes("darshan") || empNameLower.includes("sales");

    return nameMatch || emailMatch || (isSalesUser && isDarshanAdvance);
  });

  const activeAdvance = myAdvances[0] ?? null;
  const totalAvailable = activeAdvance ? activeAdvance.remaining_balance : 0;
  const totalSpent = activeAdvance ? activeAdvance.total_spent : 0;
  const totalDisbursed = activeAdvance ? activeAdvance.disbursed_amount : 0;

  return (
    <div className="p-4 md:p-6 max-w-[640px] mx-auto space-y-5">
      {/* Top Header */}
      <div className="text-center space-y-1">
        <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Employee Self-Service</p>
        <h1 className="font-serif text-2xl md:text-3xl tracking-tight">My Advance &amp; Expenses</h1>
        <p className="text-xs text-ink-3">
          Welcome <strong className="text-ink">{userName || "Darshan"}</strong> ({userEmail || "sales@anutech.in"})
        </p>
      </div>

      {/* Active Advance Balance Card (Mobile Card) */}
      {isLoading ? (
        <Skeleton className="h-44 w-full rounded-2xl" />
      ) : activeAdvance ? (
        <Card className="p-5 md:p-6 bg-gradient-to-br from-paper to-paper-2 border border-hairline shadow-sm space-y-4 rounded-2xl">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="h-9 w-9 rounded-full bg-amber-soft flex items-center justify-center text-amber-ink">
                <Icon name="wallet" size={18} />
              </div>
              <div>
                <span className="font-bold text-sm text-ink">{activeAdvance.employee_name}</span>
                <p className="text-xs text-ink-3">Disbursed on {formatDate(activeAdvance.disbursed_date, "short")}</p>
              </div>
            </div>
            <Badge kind="warning" size="sm">Active Advance</Badge>
          </div>

          {/* Balance Numbers */}
          <div className="grid grid-cols-3 gap-2 bg-paper p-3 rounded-xl border border-hairline text-center">
            <div>
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Advance Given</p>
              <p className="font-serif text-base text-ink font-semibold mt-0.5">{rupee(totalDisbursed)}</p>
            </div>

            <div>
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Claimed Spent</p>
              <p className="font-serif text-base text-emerald font-semibold mt-0.5">{rupee(totalSpent)}</p>
            </div>

            <div>
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Balance Left</p>
              <p className="font-serif text-base text-amber-ink font-bold mt-0.5">{rupee(totalAvailable)}</p>
            </div>
          </div>

          {/* Mobile Big Action Button */}
          <Button
            size="lg"
            variant="primary"
            className="w-full h-13 text-sm font-bold gap-2 rounded-xl shadow-sm"
            onClick={() => {
              setSelectedAdv(activeAdvance);
              setAddExpenseOpen(true);
            }}
          >
            <Icon name="plus" size={18} />
            <span>Record New Expense / Add Bill</span>
          </Button>

          {activeAdvance.purpose && (
            <p className="text-xs text-ink-3 text-center">
              Purpose: <strong>{activeAdvance.purpose}</strong>
            </p>
          )}
        </Card>
      ) : (
        <Card className="p-6 text-center space-y-3 rounded-2xl">
          <div className="mx-auto h-12 w-12 rounded-full bg-paper-2 flex items-center justify-center text-ink-3">
            <Icon name="wallet" size={22} />
          </div>
          <h3 className="font-serif text-lg">No Active Advance Found</h3>
          <p className="text-xs text-ink-3">
            No active advance is assigned to you right now. Contact the accounts team for an advance.
          </p>
        </Card>
      )}

      {/* Recent Expense Claims History */}
      {activeAdvance && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-base font-bold text-ink">My Submitted Bills &amp; Claims</h2>
            <span className="text-xs text-ink-3">{activeAdvance.linked_expenses.length} claims</span>
          </div>

          {activeAdvance.linked_expenses.length === 0 ? (
            <Card className="p-6 text-center text-xs text-ink-3 rounded-xl">
              Abhi tak is advance se koi kharcha submit nahi kiya gaya hai. Uppar &quot;Record New Expense&quot; dabakar bill ki entry karein.
            </Card>
          ) : (
            <div className="space-y-2.5">
              {activeAdvance.linked_expenses.map((exp) => (
                <Card key={exp.id} className="p-3.5 flex items-center justify-between gap-3 text-xs rounded-xl hover:shadow-xs">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-ink truncate">{exp.category}</span>
                      <Badge kind="success" size="sm">Deducted</Badge>
                    </div>
                    {exp.description && <p className="text-ink-2 text-xs truncate">{exp.description}</p>}
                    <p className="text-xs text-ink-3">
                      {formatDate(exp.expense_date, "short")} {exp.vendor_name ? `· Vendor: ${exp.vendor_name}` : ""}
                    </p>
                  </div>

                  <div className="text-right shrink-0">
                    <span className="font-bold text-sm text-ink">{rupee(exp.amount)}</span>
                    <p className="text-xs text-emerald font-medium">✓ Adjusted</p>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Record Expense Modal */}
      {selectedAdv && (
        <RecordExpenseModal
          advance={selectedAdv}
          open={addExpenseOpen}
          onOpenChange={(open) => {
            setAddExpenseOpen(open);
            if (!open) setSelectedAdv(null);
          }}
        />
      )}
    </div>
  );
}

/** Record Expense Dialog tailored for Mobile Devices & Employees */
function RecordExpenseModal({ advance, open, onOpenChange }: { advance: EmployeeAdvance; open: boolean; onOpenChange: (open: boolean) => void }) {
  const record = useRecordAdvanceExpense();

  const [category, setCategory] = React.useState<string>("Travel & Local Conveyance");
  const [amount, setAmount] = React.useState<string>("");
  const [date, setDate] = React.useState<string>(todayISO());
  const [vendor, setVendor] = React.useState<string>("");
  const [description, setDescription] = React.useState<string>("");
  const [fileInput, setFileInput] = React.useState<File | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      toast.error("Valid amount daalein (e.g. 500)");
      return;
    }

    if (parsedAmount > advance.remaining_balance) {
      toast.warning(`Note: Amount (${rupee(parsedAmount)}) is more than the remaining advance (${rupee(advance.remaining_balance)}).`);
    }

    record.mutate(
      {
        advance_id: advance.id,
        category,
        amount: parsedAmount,
        expense_date: date,
        vendor_name: vendor.trim() || null,
        description: description.trim() || null,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setAmount("");
          setDescription("");
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-5 rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-xl font-serif">Record Expense from Advance</DialogTitle>
          <DialogDescription className="text-xs">
            Enter expense details incurred out of your advance. Balance available: <strong>{rupee(advance.remaining_balance)}</strong>
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <FormField htmlFor="my-expenses-category-kharcha-kahan-huwa" label="Category (what was it spent on)" required>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="my-expenses-category-kharcha-kahan-huwa" className="w-full h-11 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPENSE_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <div className="grid grid-cols-2 gap-3">
            <FormField htmlFor="my-expenses-spent-amount" label="Spent Amount (₹)" required>
              <Input id="my-expenses-spent-amount"
                type="number"
                placeholder="500"
                className="h-11 text-base font-bold"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </FormField>

            <FormField htmlFor="my-expenses-bill-date" label="Bill Date">
              <Input id="my-expenses-bill-date"
                type="date"
                className="h-11 text-sm"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
              />
            </FormField>
          </div>

          <FormField htmlFor="my-expenses-vendor-paid-to-e" label="Vendor / Paid To (e.g. Uber / Auto / Cafe)">
            <Input id="my-expenses-vendor-paid-to-e"
              placeholder="e.g. Auto fare to client office"
              className="h-11 text-sm"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
            />
          </FormField>

          <FormField htmlFor="my-expenses-notes-description" label="Notes / Description">
            <Input id="my-expenses-notes-description"
              placeholder="e.g. Visited Rohini client for Google Workspace demo"
              className="h-11 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </FormField>

          {/* Mobile Camera / Photo Bill Upload */}
          <FormField htmlFor="my-expenses-receipt" label="Upload Bill Receipt / Photo">
            <input id="my-expenses-receipt"
              type="file"
              accept="image/*,.pdf"
              capture="environment"
              className="block w-full text-xs text-ink-3 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-paper-2 file:text-ink hover:file:bg-paper-3 cursor-pointer"
              onChange={(e) => setFileInput(e.target.files?.[0] ?? null)}
            />
            {fileInput && <p className="text-xs text-emerald mt-1">✓ Photo selected: {fileInput.name}</p>}
          </FormField>

          <DialogFooter className="pt-3 gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" className="h-11 text-sm font-bold" loading={record.isPending}>
              Submit Expense Claim
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
