import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePerm, assertBranch, filterByBranch } from "./lib/access";
import { postJournal, reverseJournal } from "./lib/ledger";
import { audit, nextNumber } from "./lib/system";
import { r2 } from "./lib/money";

const allocation = v.object({ docId: v.string(), amount: v.number() });

async function assertCashAccount(ctx: MutationCtx, accountId: Id<"accounts">) {
  const acc = await ctx.db.get(accountId);
  if (!acc || !acc.isCashOrBank) throw new ConvexError("Choose a cash or bank account.");
}

/** Shared by the payments screen and "invoice + pay now". */
export async function recordCustomerPayment(
  ctx: MutationCtx,
  member: Doc<"members">,
  args: {
    customerId: Id<"customers">;
    branchId: Id<"branches">;
    date: number;
    amount: number;
    accountId: Id<"accounts">;
    method: string;
    reference?: string;
    note?: string;
    allocations: Array<{ docId: string; amount: number }>;
  },
): Promise<Id<"payments">> {
  assertBranch(member, args.branchId);
  await assertCashAccount(ctx, args.accountId);
  const customer = await ctx.db.get(args.customerId);
  if (!customer) throw new ConvexError("Customer not found.");
  const amount = r2(args.amount);
  if (amount <= 0) throw new ConvexError("Amount must be greater than zero.");
  const allocated = r2(args.allocations.reduce((a, x) => a + x.amount, 0));
  if (allocated > amount + 0.001) throw new ConvexError("Allocations exceed the payment amount.");

  for (const a of args.allocations) {
    if (a.amount <= 0) continue;
    const id = ctx.db.normalizeId("salesDocs", a.docId);
    const inv = id ? await ctx.db.get(id) : null;
    if (!inv || inv.kind !== "invoice" || inv.customerId !== args.customerId) throw new ConvexError("Invalid invoice allocation.");
    if (inv.status !== "open" && inv.status !== "partial") throw new ConvexError(`${inv.number} is ${inv.status}.`);
    const due = r2(inv.total - inv.amountPaid);
    if (a.amount > due + 0.001) throw new ConvexError(`${inv.number}: allocating ${a.amount} but only ${due} is due.`);
    const paid = r2(inv.amountPaid + a.amount);
    await ctx.db.patch(inv._id, { amountPaid: paid, status: paid >= inv.total - 0.001 ? "paid" : "partial" });
  }

  const number = await nextNumber(ctx, "receipt", "RCT");
  const paymentId = await ctx.db.insert("payments", {
    number,
    direction: "received",
    partyType: "customer",
    customerId: args.customerId,
    branchId: args.branchId,
    date: args.date,
    amount,
    accountId: args.accountId,
    method: args.method,
    reference: args.reference,
    allocations: args.allocations.filter((a) => a.amount > 0),
    unallocated: r2(amount - allocated),
    note: args.note,
    createdBy: member._id,
  });
  const journalEntryId = await postJournal(ctx, {
    date: args.date,
    memo: `Receipt ${number} — ${customer.name}`,
    sourceType: "payment",
    sourceId: paymentId,
    branchId: args.branchId,
    member,
    lines: [
      { account: args.accountId, debit: amount },
      { account: "ar", credit: amount, partyType: "customer", partyId: customer._id },
    ],
  });
  await ctx.db.patch(paymentId, { journalEntryId });
  await ctx.db.patch(customer._id, { balance: r2(customer.balance - amount) });
  await audit(ctx, member, "payment.received", "payments", paymentId, { number, amount }, args.branchId);
  return paymentId;
}

export const list = query({
  args: { partyType: v.string() },
  handler: async (ctx, { partyType }) => {
    const member = await requirePerm(ctx, partyType === "customer" ? "sales.view" : "purchasing.view");
    const rows = filterByBranch(member, (await ctx.db.query("payments").collect()).filter((p) => p.partyType === partyType));
    const customers = await ctx.db.query("customers").collect();
    const suppliers = await ctx.db.query("suppliers").collect();
    const accounts = await ctx.db.query("accounts").collect();
    return rows
      .sort((a, b) => b.date - a.date || b._creationTime - a._creationTime)
      .map((p) => ({
        ...p,
        partyName:
          (p.customerId && customers.find((c) => c._id === p.customerId)?.name) ||
          (p.supplierId && suppliers.find((s) => s._id === p.supplierId)?.name) ||
          "",
        accountName: accounts.find((a) => a._id === p.accountId)?.name ?? "",
      }));
  },
});

export const receiveFromCustomer = mutation({
  args: {
    customerId: v.id("customers"),
    branchId: v.id("branches"),
    date: v.number(),
    amount: v.number(),
    accountId: v.id("accounts"),
    method: v.string(),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    allocations: v.array(allocation),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "customer_payments.manage");
    return await recordCustomerPayment(ctx, member, args);
  },
});

export const paySupplier = mutation({
  args: {
    supplierId: v.id("suppliers"),
    branchId: v.id("branches"),
    date: v.number(),
    amount: v.number(),
    accountId: v.id("accounts"),
    method: v.string(),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    allocations: v.array(allocation),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "supplier_payments.manage");
    assertBranch(member, args.branchId);
    await assertCashAccount(ctx, args.accountId);
    const supplier = await ctx.db.get(args.supplierId);
    if (!supplier) throw new ConvexError("Supplier not found.");
    const amount = r2(args.amount);
    if (amount <= 0) throw new ConvexError("Amount must be greater than zero.");
    const allocated = r2(args.allocations.reduce((a, x) => a + x.amount, 0));
    if (allocated > amount + 0.001) throw new ConvexError("Allocations exceed the payment amount.");
    for (const a of args.allocations) {
      if (a.amount <= 0) continue;
      const id = ctx.db.normalizeId("supplierBills", a.docId);
      const bill = id ? await ctx.db.get(id) : null;
      if (!bill || bill.kind !== "bill" || bill.supplierId !== args.supplierId) throw new ConvexError("Invalid bill allocation.");
      if (bill.status !== "open" && bill.status !== "partial") throw new ConvexError(`${bill.number} is ${bill.status}.`);
      const due = r2(bill.total - bill.amountPaid);
      if (a.amount > due + 0.001) throw new ConvexError(`${bill.number}: paying ${a.amount} but only ${due} is due.`);
      const paid = r2(bill.amountPaid + a.amount);
      await ctx.db.patch(bill._id, { amountPaid: paid, status: paid >= bill.total - 0.001 ? "paid" : "partial" });
    }
    const number = await nextNumber(ctx, "supplierPayment", "PAY");
    const paymentId = await ctx.db.insert("payments", {
      number,
      direction: "paid",
      partyType: "supplier",
      supplierId: args.supplierId,
      branchId: args.branchId,
      date: args.date,
      amount,
      accountId: args.accountId,
      method: args.method,
      reference: args.reference,
      allocations: args.allocations.filter((a) => a.amount > 0),
      unallocated: r2(amount - allocated),
      note: args.note,
      createdBy: member._id,
    });
    const journalEntryId = await postJournal(ctx, {
      date: args.date,
      memo: `Payment ${number} — ${supplier.name}`,
      sourceType: "payment",
      sourceId: paymentId,
      branchId: args.branchId,
      member,
      lines: [
        { account: "ap", debit: amount, partyType: "supplier", partyId: supplier._id },
        { account: args.accountId, credit: amount },
      ],
    });
    await ctx.db.patch(paymentId, { journalEntryId });
    await ctx.db.patch(supplier._id, { balance: r2(supplier.balance - amount) });
    await audit(ctx, member, "payment.paid", "payments", paymentId, { number, amount }, args.branchId);
    return paymentId;
  },
});

/** Pay cash back to a customer against an open credit note. */
export const refundCustomer = mutation({
  args: {
    creditNoteId: v.id("salesDocs"),
    date: v.number(),
    amount: v.number(),
    accountId: v.id("accounts"),
    method: v.string(),
    reference: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "credit.override");
    const cn = await ctx.db.get(args.creditNoteId);
    if (!cn || cn.kind !== "credit_note") throw new ConvexError("Credit note not found.");
    assertBranch(member, cn.branchId);
    await assertCashAccount(ctx, args.accountId);
    const left = r2(cn.total - cn.amountPaid);
    const amount = r2(args.amount);
    if (amount <= 0 || amount > left + 0.001) throw new ConvexError(`Refund must be between 0 and ${left}.`);
    const customer = (await ctx.db.get(cn.customerId))!;
    const number = await nextNumber(ctx, "refund", "RFD");
    const paymentId = await ctx.db.insert("payments", {
      number,
      direction: "refund",
      partyType: "customer",
      customerId: cn.customerId,
      branchId: cn.branchId,
      date: args.date,
      amount,
      accountId: args.accountId,
      method: args.method,
      reference: args.reference,
      allocations: [{ docId: cn._id, amount }],
      unallocated: 0,
      createdBy: member._id,
    });
    const journalEntryId = await postJournal(ctx, {
      date: args.date,
      memo: `Refund ${number} against ${cn.number} — ${customer.name}`,
      sourceType: "payment",
      sourceId: paymentId,
      branchId: cn.branchId,
      member,
      lines: [
        { account: "ar", debit: amount, partyType: "customer", partyId: customer._id },
        { account: args.accountId, credit: amount },
      ],
    });
    await ctx.db.patch(paymentId, { journalEntryId });
    const paid = r2(cn.amountPaid + amount);
    await ctx.db.patch(cn._id, { amountPaid: paid, status: paid >= cn.total - 0.001 ? "refunded" : "open" });
    await ctx.db.patch(customer._id, { balance: r2(customer.balance + amount) });
    await audit(ctx, member, "refund.paid", "payments", paymentId, { number, amount }, cn.branchId);
    return paymentId;
  },
});

/** Reverse a payment and undo its allocations. */
export const voidPayment = mutation({
  args: { id: v.id("payments"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "accounting.journal");
    const p = await ctx.db.get(id);
    if (!p) throw new ConvexError("Payment not found.");
    if (p.note?.startsWith("VOID")) throw new ConvexError("Already void.");
    if (p.direction === "refund") throw new ConvexError("Refunds cannot be voided here; post a journal correction.");
    for (const a of p.allocations) {
      if (p.partyType === "customer") {
        const docId = ctx.db.normalizeId("salesDocs", a.docId);
        const doc = docId ? await ctx.db.get(docId) : null;
        if (doc) {
          const paid = r2(doc.amountPaid - a.amount);
          await ctx.db.patch(doc._id, { amountPaid: paid, status: paid <= 0 ? "open" : "partial" });
        }
      } else {
        const billId = ctx.db.normalizeId("supplierBills", a.docId);
        const bill = billId ? await ctx.db.get(billId) : null;
        if (bill) {
          const paid = r2(bill.amountPaid - a.amount);
          await ctx.db.patch(bill._id, { amountPaid: paid, status: paid <= 0 ? "open" : "partial" });
        }
      }
    }
    if (p.journalEntryId) await reverseJournal(ctx, p.journalEntryId, member, reason);
    if (p.customerId) {
      const c = await ctx.db.get(p.customerId);
      if (c) await ctx.db.patch(c._id, { balance: r2(c.balance + p.amount) });
    }
    if (p.supplierId) {
      const s = await ctx.db.get(p.supplierId);
      if (s) await ctx.db.patch(s._id, { balance: r2(s.balance + p.amount) });
    }
    await ctx.db.patch(id, { note: `VOID: ${reason}`, allocations: [], unallocated: 0 });
    await audit(ctx, member, "payment.voided", "payments", id, reason, p.branchId);
  },
});

/** Apply a payment's unallocated amount to more invoices / bills later. */
export const allocateLater = mutation({
  args: { id: v.id("payments"), allocations: v.array(allocation) },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "customer_payments.manage");
    const p = await ctx.db.get(args.id);
    if (!p) throw new ConvexError("Payment not found.");
    assertBranch(member, p.branchId);
    const total = r2(args.allocations.reduce((a, x) => a + x.amount, 0));
    if (total > p.unallocated + 0.001) throw new ConvexError(`Only ${p.unallocated} is unallocated.`);
    for (const a of args.allocations) {
      if (a.amount <= 0) continue;
      if (p.partyType === "customer") {
        const docId = ctx.db.normalizeId("salesDocs", a.docId);
        const inv = docId ? await ctx.db.get(docId) : null;
        if (!inv || inv.customerId !== p.customerId || inv.kind !== "invoice") throw new ConvexError("Invalid invoice.");
        const paid = r2(inv.amountPaid + a.amount);
        if (paid > inv.total + 0.001) throw new ConvexError(`${inv.number} would be overpaid.`);
        await ctx.db.patch(inv._id, { amountPaid: paid, status: paid >= inv.total - 0.001 ? "paid" : "partial" });
      } else {
        const billId = ctx.db.normalizeId("supplierBills", a.docId);
        const bill = billId ? await ctx.db.get(billId) : null;
        if (!bill || bill.supplierId !== p.supplierId) throw new ConvexError("Invalid bill.");
        const paid = r2(bill.amountPaid + a.amount);
        if (paid > bill.total + 0.001) throw new ConvexError(`${bill.number} would be overpaid.`);
        await ctx.db.patch(bill._id, { amountPaid: paid, status: paid >= bill.total - 0.001 ? "paid" : "partial" });
      }
    }
    await ctx.db.patch(p._id, {
      allocations: [...p.allocations, ...args.allocations.filter((a) => a.amount > 0)],
      unallocated: r2(p.unallocated - total),
    });
    await audit(ctx, member, "payment.allocated", "payments", p._id, { total }, p.branchId);
  },
});
