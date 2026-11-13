import { describe, it, expect } from "vitest";

describe("Salaried Pro — Personal Expenses & Bank Statement Parsing", () => {
  it("verifies whole rupees calculation rule for personal expenses", () => {
    // Workspace Rule 4: All money in whole rupees, no paise
    const cleanAmount = (raw: string) => {
      const cleaned = raw.replace(/[₹,\s"'\r\n]/g, "").replace(/[Cc][Rr]$/, "").replace(/[Dd][Rr]$/, "");
      const n = parseFloat(cleaned);
      return isNaN(n) ? 0 : Math.round(n);
    };

    expect(cleanAmount("₹1,18,500.00")).toBe(118500);
    expect(cleanAmount("6,450")).toBe(6450);
    expect(cleanAmount("3,500.40")).toBe(3500);
    expect(cleanAmount("22000 Cr")).toBe(22000);
  });

  it("verifies date parsing for Indian bank statement formats (DD/MM/YYYY)", () => {
    const parseIndianDate = (raw: string) => {
      const s = raw.trim().replace(/"/g, "");
      const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
      if (m) {
        const dd = m[1].padStart(2, "0");
        const mm = m[2].padStart(2, "0");
        let yyyy = m[3];
        if (yyyy.length === 2) yyyy = `20${yyyy}`;
        return `${yyyy}-${mm}-${dd}`;
      }
      return s;
    };

    expect(parseIndianDate("01/11/2026")).toBe("2026-11-01");
    expect(parseIndianDate("5/4/2026")).toBe("2026-04-05");
    expect(parseIndianDate("15-08-2026")).toBe("2026-08-15");
  });

  it("accurately categorizes Indian personal banking narrations", () => {
    const categorize = (narration: string, debit: number, credit: number) => {
      const norm = narration.toUpperCase();
      if (credit > 0 && (norm.includes("SALARY") || norm.includes("PAYROLL") || credit >= 30000)) {
        return { cat: "Salary Income", isSalary: true };
      }
      if (debit > 0) {
        if (norm.includes("RENT") || norm.includes("LANDLORD")) return { cat: "Housing & Rent", isSalary: false };
        if (norm.includes("SWIGGY") || norm.includes("DMART") || norm.includes("BLINKIT")) return { cat: "Food & Groceries", isSalary: false };
        if (norm.includes("PETROL") || norm.includes("HPCL") || norm.includes("UBER")) return { cat: "Fuel & Commute", isSalary: false };
        if (norm.includes("AIRTEL") || norm.includes("ELECTRIC") || norm.includes("BILLDESK")) return { cat: "Utilities & Bills", isSalary: false };
        if (norm.includes("NETFLIX") || norm.includes("SPOTIFY")) return { cat: "Subscriptions & OTT", isSalary: false };
      }
      return { cat: "Miscellaneous", isSalary: false };
    };

    // Salary Credit
    expect(categorize("NEFT CR-TECH CORP-SALARY-NOV26", 0, 118500)).toEqual({
      cat: "Salary Income",
      isSalary: true,
    });

    // Rent
    expect(categorize("UPI-RENT PAYMENT TO SURESH KUMAR", 22000, 0)).toEqual({
      cat: "Housing & Rent",
      isSalary: false,
    });

    // Grocery / Food
    expect(categorize("POS-DMART SUPERMARKET", 6450, 0)).toEqual({
      cat: "Food & Groceries",
      isSalary: false,
    });
    expect(categorize("UPI-SWIGGY FOOD ORDER", 840, 0)).toEqual({
      cat: "Food & Groceries",
      isSalary: false,
    });

    // Fuel & Commute
    expect(categorize("POS-HPCL PETROL BUNK", 3500, 0)).toEqual({
      cat: "Fuel & Commute",
      isSalary: false,
    });

    // Utilities
    expect(categorize("BILLDESK-AIRTEL XSTREAM BROADBAND", 1179, 0)).toEqual({
      cat: "Utilities & Bills",
      isSalary: false,
    });

    // Subscriptions
    expect(categorize("NETFLIX ENTERTAINMENT SERVICES", 649, 0)).toEqual({
      cat: "Subscriptions & OTT",
      isSalary: false,
    });
  });

  it("calculates net monthly savings and savings percentage correctly", () => {
    const monthlySalary = 118500;
    const expenses = [
      { amount: 22000 }, // Rent
      { amount: 6450 },  // Groceries
      { amount: 3500 },  // Fuel
      { amount: 1179 },  // Broadband
      { amount: 840 },   // Swiggy
    ];

    const totalSpent = expenses.reduce((sum, e) => sum + e.amount, 0);
    expect(totalSpent).toBe(33969);

    const netSavings = monthlySalary - totalSpent;
    expect(netSavings).toBe(84531);

    const savingsRate = Math.round((netSavings / monthlySalary) * 100);
    expect(savingsRate).toBe(71); // 71% savings rate
  });

  it("handles both income credits and expense debits in the financial ledger", () => {
    interface Txn {
      type: "income" | "expense";
      amountRupees: number;
      category: string;
    }

    const ledger: Txn[] = [
      { type: "income", amountRupees: 85000, category: "Salary" },
      { type: "income", amountRupees: 4500, category: "Freelance / Side Gig" },
      { type: "expense", amountRupees: 22000, category: "Housing & Rent" },
      { type: "expense", amountRupees: 6450, category: "Food & Groceries" },
      { type: "expense", amountRupees: 3500, category: "Fuel & Commute" },
    ];

    const totalIncome = ledger
      .filter((t) => t.type === "income")
      .reduce((sum, t) => sum + t.amountRupees, 0);

    const totalExpense = ledger
      .filter((t) => t.type === "expense")
      .reduce((sum, t) => sum + t.amountRupees, 0);

    expect(totalIncome).toBe(89500);
    expect(totalExpense).toBe(31950);

    const surplus = totalIncome - totalExpense;
    expect(surplus).toBe(57550);

    const savingsRate = Math.round((surplus / totalIncome) * 100);
    expect(savingsRate).toBe(64); // 64% savings
  });
});
