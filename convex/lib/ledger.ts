import { ConvexError } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { nextNumber } from "./system";
import { r2 } from "./money";

/** Default chart of accounts. systemKey marks accounts used by automatic postings. */
export const DEFAULT_ACCOUNTS: Array<{
  code: string;
  name: string;
  type: string;
  subtype?: string;
  systemKey?: string;
  isCashOrBank?: boolean;
}> = [
  { code: "1000", name: "Cash on Hand", type: "asset", subtype: "cash", systemKey: "cash", isCashOrBank: true },
  { code: "1010", name: "Main Bank Account", type: "asset", subtype: "bank", systemKey: "bank", isCashOrBank: true },
  { code: "1020", name: "Mobile Money", type: "asset", subtype: "bank", isCashOrBank: true },
  { code: "1100", name: "Accounts Receivable", type: "asset", subtype: "receivable", systemKey: "ar" },
  { code: "1200", name: "Inventory", type: "asset", subtype: "inventory", systemKey: "inventory" },
  { code: "1210", name: "Inventory in Transit", type: "asset", subtype: "inventory", systemKey: "inventory_transit" },
  { code: "1300", name: "Recoverable Tax (Input)", type: "asset", subtype: "current", systemKey: "tax_input" },
  { code: "1350", name: "Supplier Advances", type: "asset", subtype: "current", systemKey: "supplier_advances" },
  { code: "1400", name: "Prepaid Expenses", type: "asset", subtype: "current" },
  { code: "1500", name: "Furniture & Equipment", type: "asset", subtype: "fixed" },
  { code: "1510", name: "Vehicles", type: "asset", subtype: "fixed" },
  { code: "2000", name: "Accounts Payable", type: "liability", subtype: "payable", systemKey: "ap" },
  { code: "2100", name: "Goods Received Not Invoiced", type: "liability", subtype: "current", systemKey: "grni" },
  { code: "2200", name: "Tax Payable (Output)", type: "liability", subtype: "current", systemKey: "tax_payable" },
  { code: "2300", name: "Customer Credits & Deposits", type: "liability", subtype: "current", systemKey: "customer_credits" },
  { code: "2400", name: "Accrued Expenses", type: "liability", subtype: "current" },
  { code: "2500", name: "Loans Payable", type: "liability", subtype: "long_term" },
  { code: "3000", name: "Owner's Capital", type: "equity", systemKey: "owner_equity" },
  { code: "3100", name: "Opening Balance Equity", type: "equity", systemKey: "opening_equity" },
  { code: "3200", name: "Retained Earnings", type: "equity", systemKey: "retained_earnings" },
  { code: "3300", name: "Owner's Drawings", type: "equity" },
  { code: "4000", name: "Sales Revenue", type: "revenue", systemKey: "sales" },
  { code: "4100", name: "Sales Returns", type: "revenue", subtype: "contra", systemKey: "sales_returns" },
  { code: "4200", name: "Sales Discounts", type: "revenue", subtype: "contra", systemKey: "sales_discounts" },
  { code: "5000", name: "Cost of Goods Sold", type: "cogs", systemKey: "cogs" },
  { code: "5100", name: "Inventory Adjustments & Shrinkage", type: "cogs", systemKey: "inventory_adjust" },
  { code: "5200", name: "Freight & Landed Costs", type: "cogs", systemKey: "freight_in" },
  { code: "5300", name: "Purchase Price Variance", type: "cogs", systemKey: "price_variance" },
  { code: "6000", name: "Rent", type: "expense" },
  { code: "6010", name: "Salaries & Wages", type: "expense" },
  { code: "6020", name: "Electricity & Water", type: "expense" },
  { code: "6030", name: "Transport & Fuel", type: "expense" },
  { code: "6040", name: "Office Supplies", type: "expense" },
  { code: "6050", name: "Repairs & Maintenance", type: "expense" },
  { code: "6060", name: "Communication & Internet", type: "expense" },
  { code: "6070", name: "Bank Charges", type: "expense", systemKey: "bank_charges" },
  { code: "6080", name: "Licenses & Government Fees", type: "expense" },
  { code: "6090", name: "Miscellaneous Expenses", type: "expense", systemKey: "misc_expense" },
  { code: "7000", name: "Other Income", type: "other_income", systemKey: "other_income" },
  { code: "8000", name: "Other Expenses", type: "other_expense" },
];

/** Debit-normal account types. */
export const DEBIT_NORMAL = new Set(["asset", "cogs", "expense", "other_expense"]);

export async function sysAccount(ctx: QueryCtx | MutationCtx, key: string): Promise<Id<"accounts">> {
  const acc = await ctx.db
    .query("accounts")
    .withIndex("by_systemKey", (q) => q.eq("systemKey", key))
    .first();
  if (!acc) throw new ConvexError(`System account "${key}" is missing from the chart of accounts.`);
  return acc._id;
}

export async function assertPeriodOpen(ctx: QueryCtx | MutationCtx, date: number) {
  const period = await ctx.db
    .query("fiscalPeriods")
    .withIndex("by_start", (q) => q.lte("startDate", date))
    .order("desc")
    .first();
  if (period && period.endDate >= date && period.status === "closed") {
    throw new ConvexError(`The period "${period.name}" is closed. Choose a date in an open period.`);
  }
}

export type JournalLineInput = {
  account: Id<"accounts"> | string; // Id or systemKey
  debit?: number;
  credit?: number;
  memo?: string;
  branchId?: Id<"branches">;
  partyType?: string;
  partyId?: string;
};

/**
 * Post a balanced journal entry. Throws if unbalanced or in a closed period.
 * Lines with zero amounts are dropped.
 */
export async function postJournal(
  ctx: MutationCtx,
  args: {
    date: number;
    memo: string;
    sourceType: string;
    sourceId?: string;
    branchId?: Id<"branches">;
    member?: Doc<"members"> | null;
    lines: JournalLineInput[];
  },
): Promise<Id<"journalEntries"> | undefined> {
  await assertPeriodOpen(ctx, args.date);

  const resolved: Array<{
    accountId: Id<"accounts">;
    debit: number;
    credit: number;
    memo?: string;
    branchId?: Id<"branches">;
    partyType?: string;
    partyId?: string;
  }> = [];

  for (const l of args.lines) {
    let debit = r2(l.debit ?? 0);
    let credit = r2(l.credit ?? 0);
    if (debit < 0) {
      credit = r2(credit - debit);
      debit = 0;
    }
    if (credit < 0) {
      debit = r2(debit - credit);
      credit = 0;
    }
    if (debit === 0 && credit === 0) continue;
    const accountId =
      typeof l.account === "string" && !(await isAccountId(ctx, l.account))
        ? await sysAccount(ctx, l.account)
        : (l.account as Id<"accounts">);
    resolved.push({
      accountId,
      debit,
      credit,
      memo: l.memo,
      branchId: l.branchId ?? args.branchId,
      partyType: l.partyType,
      partyId: l.partyId,
    });
  }

  if (resolved.length === 0) return undefined;

  const totalDebit = r2(resolved.reduce((a, l) => a + l.debit, 0));
  const totalCredit = r2(resolved.reduce((a, l) => a + l.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > 0.009) {
    throw new ConvexError(
      `Journal entry is not balanced (debits ${totalDebit} ≠ credits ${totalCredit}).`,
    );
  }

  const number = await nextNumber(ctx, "journal", "JE");
  const entryId = await ctx.db.insert("journalEntries", {
    number,
    date: args.date,
    memo: args.memo,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    branchId: args.branchId,
    status: "posted",
    totalDebit,
    createdBy: args.member?._id,
  });
  for (const l of resolved) {
    await ctx.db.insert("journalLines", { entryId, date: args.date, ...l });
  }
  return entryId;
}

async function isAccountId(ctx: QueryCtx | MutationCtx, s: string): Promise<boolean> {
  const id = ctx.db.normalizeId("accounts", s);
  return id !== null;
}

/** Controlled correction: posts an equal and opposite entry, marks the original reversed. */
export async function reverseJournal(
  ctx: MutationCtx,
  entryId: Id<"journalEntries">,
  member: Doc<"members"> | null,
  memo: string,
  date: number = Date.now(),
): Promise<Id<"journalEntries"> | undefined> {
  const entry = await ctx.db.get(entryId);
  if (!entry) throw new ConvexError("Journal entry not found.");
  if (entry.status === "reversed") throw new ConvexError("This entry has already been reversed.");
  const lines = await ctx.db
    .query("journalLines")
    .withIndex("by_entry", (q) => q.eq("entryId", entryId))
    .collect();
  const reversalId = await postJournal(ctx, {
    date,
    memo: `Reversal of ${entry.number}: ${memo}`,
    sourceType: "reversal",
    sourceId: entryId,
    branchId: entry.branchId,
    member,
    lines: lines.map((l) => ({
      account: l.accountId,
      debit: l.credit,
      credit: l.debit,
      branchId: l.branchId,
      partyType: l.partyType,
      partyId: l.partyId,
      memo: l.memo,
    })),
  });
  await ctx.db.patch(entryId, { status: "reversed", reversedById: reversalId });
  if (reversalId) await ctx.db.patch(reversalId, { reversalOfId: entryId });
  return reversalId;
}
