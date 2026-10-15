import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requirePerm, assertBranch, filterByBranch, has, getCompany } from "./lib/access";
import { postJournal, reverseJournal } from "./lib/ledger";
import { audit, nextNumber, notifyPermission } from "./lib/system";
import { r2 } from "./lib/money";

export const list = query({
  args: { status: v.optional(v.string()), branchId: v.optional(v.id("branches")), from: v.optional(v.number()), to: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "expenses.create").catch(() => requirePerm(ctx, "reports.view"));
    let rows = args.status
      ? await ctx.db.query("expenses").withIndex("by_status", (q) => q.eq("status", args.status!)).collect()
      : await ctx.db.query("expenses").collect();
    rows = filterByBranch(member, rows, args.branchId).filter((e) => (!args.from || e.date >= args.from) && (!args.to || e.date <= args.to));
    const accounts = await ctx.db.query("accounts").collect();
    const branches = await ctx.db.query("branches").collect();
    const members = await ctx.db.query("members").collect();
    const out = [];
    for (const e of rows.sort((a, b) => b.date - a.date)) {
      out.push({
        ...e,
        total: r2(e.amount + e.taxAmount),
        category: accounts.find((a) => a._id === e.expenseAccountId)?.name ?? "",
        paidFrom: accounts.find((a) => a._id === e.paymentAccountId)?.name ?? "",
        branchName: branches.find((b) => b._id === e.branchId)?.name ?? "",
        createdByName: members.find((m) => m._id === e.createdBy)?.name ?? "",
        receiptUrl: e.receiptStorageId ? await ctx.storage.getUrl(e.receiptStorageId) : null,
      });
    }
    return out;
  },
});

async function post(ctx: MutationCtx, e: Doc<"expenses">, member: Doc<"members">) {
  const journalEntryId = await postJournal(ctx, {
    date: e.date,
    memo: `Expense ${e.number} — ${e.payee}: ${e.description}`,
    sourceType: "expense",
    sourceId: e._id,
    branchId: e.branchId,
    member,
    lines: [
      { account: e.expenseAccountId, debit: e.amount },
      { account: "tax_input", debit: e.taxAmount },
      { account: e.paymentAccountId, credit: r2(e.amount + e.taxAmount) },
    ],
  });
  await ctx.db.patch(e._id, { status: "posted", approvedBy: member._id, journalEntryId });
}

export const create = mutation({
  args: {
    branchId: v.id("branches"),
    date: v.number(),
    expenseAccountId: v.id("accounts"),
    paymentAccountId: v.id("accounts"),
    payee: v.string(),
    supplierId: v.optional(v.id("suppliers")),
    amount: v.number(),
    taxAmount: v.number(),
    method: v.string(),
    reference: v.optional(v.string()),
    description: v.string(),
    receiptStorageId: v.optional(v.id("_storage")),
    recurring: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "expenses.create");
    assertBranch(member, args.branchId);
    if (args.amount <= 0) throw new ConvexError("Amount must be greater than zero.");
    const pay = await ctx.db.get(args.paymentAccountId);
    if (!pay?.isCashOrBank) throw new ConvexError("Pay from a cash or bank account.");
    const company = await getCompany(ctx);
    const number = await nextNumber(ctx, "expense", "EXP");
    const id = await ctx.db.insert("expenses", { ...args, amount: r2(args.amount), taxAmount: r2(args.taxAmount), number, status: "pending_approval", createdBy: member._id });
    const total = r2(args.amount + args.taxAmount);
    const selfApprove = has(member, "expenses.approve") && (total <= company.requireApprovalAbove || has(member, "approvals.high_value"));
    if (selfApprove) {
      await post(ctx, (await ctx.db.get(id))!, member);
    } else {
      await notifyPermission(ctx, "expenses.approve", `Expense ${number} needs approval`, `${args.payee}: ${total}`, "/approvals", args.branchId, member._id);
    }
    await audit(ctx, member, selfApprove ? "expense.posted" : "expense.submitted", "expenses", id, { number, total }, args.branchId);
    return id;
  },
});

export const approve = mutation({
  args: { id: v.id("expenses") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "expenses.approve");
    const e = await ctx.db.get(id);
    if (!e) throw new ConvexError("Expense not found.");
    assertBranch(member, e.branchId);
    if (e.status !== "pending_approval") throw new ConvexError(`Expense is ${e.status}.`);
    const company = await getCompany(ctx);
    if (e.amount + e.taxAmount > company.requireApprovalAbove && !has(member, "approvals.high_value")) {
      throw new ConvexError("This expense needs General Manager approval.");
    }
    await post(ctx, e, member);
    await audit(ctx, member, "expense.approved", "expenses", id, e.number, e.branchId);
  },
});

export const reject = mutation({
  args: { id: v.id("expenses"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "expenses.approve");
    const e = await ctx.db.get(id);
    if (!e) throw new ConvexError("Expense not found.");
    assertBranch(member, e.branchId);
    if (e.status !== "pending_approval") throw new ConvexError(`Expense is ${e.status}.`);
    await ctx.db.patch(id, { status: "rejected", approvedBy: member._id });
    await audit(ctx, member, "expense.rejected", "expenses", id, reason, e.branchId);
  },
});

export const voidExpense = mutation({
  args: { id: v.id("expenses"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "expenses.approve");
    const e = await ctx.db.get(id);
    if (!e) throw new ConvexError("Expense not found.");
    assertBranch(member, e.branchId);
    if (e.status !== "posted") throw new ConvexError("Only posted expenses can be voided.");
    if (e.journalEntryId) await reverseJournal(ctx, e.journalEntryId, member, reason);
    await ctx.db.patch(id, { status: "void" });
    await audit(ctx, member, "expense.voided", "expenses", id, reason, e.branchId);
  },
});

/** Copy a recurring expense to a new date (e.g. this month's rent). */
export const repeat = mutation({
  args: { id: v.id("expenses"), date: v.number() },
  handler: async (ctx, { id, date }) => {
    const member = await requirePerm(ctx, "expenses.create");
    const e = await ctx.db.get(id);
    if (!e) throw new ConvexError("Expense not found.");
    assertBranch(member, e.branchId);
    const number = await nextNumber(ctx, "expense", "EXP");
    const newId = await ctx.db.insert("expenses", {
      number,
      branchId: e.branchId,
      date,
      expenseAccountId: e.expenseAccountId,
      paymentAccountId: e.paymentAccountId,
      payee: e.payee,
      supplierId: e.supplierId,
      amount: e.amount,
      taxAmount: e.taxAmount,
      method: e.method,
      description: e.description,
      recurring: e.recurring,
      status: "pending_approval",
      createdBy: member._id,
    });
    await notifyPermission(ctx, "expenses.approve", `Expense ${number} needs approval`, `${e.payee}: ${r2(e.amount + e.taxAmount)}`, "/approvals", e.branchId, member._id);
    await audit(ctx, member, "expense.repeated", "expenses", newId, { from: e.number }, e.branchId);
    return newId;
  },
});
