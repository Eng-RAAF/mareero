import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePerm, assertBranch, filterByBranch, has, getCompany } from "./lib/access";
import { applyMovement, bumpCounter, findBalance } from "./lib/stock";
import { postJournal, reverseJournal } from "./lib/ledger";
import { audit, nextNumber, notifyPermission } from "./lib/system";
import { r2, DAY } from "./lib/money";
import { recordCustomerPayment } from "./payments";

const lineInput = v.object({
  productId: v.id("products"),
  description: v.string(),
  qty: v.number(),
  unitPrice: v.number(),
  discount: v.number(),
});

const PREFIX: Record<string, string> = { quotation: "QT", order: "SO", invoice: "INV", credit_note: "CN" };

function totals(lines: Array<{ qty: number; unitPrice: number; discount: number }>, taxRate: number) {
  const subtotal = r2(lines.reduce((a, l) => a + l.qty * l.unitPrice, 0));
  const discountTotal = r2(lines.reduce((a, l) => a + l.discount, 0));
  const taxAmount = r2(((subtotal - discountTotal) * taxRate) / 100);
  const total = r2(subtotal - discountTotal + taxAmount);
  return { subtotal, discountTotal, taxAmount, total };
}

async function enrich(ctx: any, docs: Doc<"salesDocs">[]) {
  const customers = await ctx.db.query("customers").collect();
  const stores = await ctx.db.query("stores").collect();
  const members = await ctx.db.query("members").collect();
  const now = Date.now();
  return docs.map((d) => ({
    ...d,
    customerName: customers.find((c: any) => c._id === d.customerId)?.name ?? "",
    storeName: stores.find((s: any) => s._id === d.storeId)?.name ?? "",
    createdByName: members.find((m: any) => m._id === d.createdBy)?.name ?? "",
    balanceDue: r2(d.total - d.amountPaid),
    overdue: d.kind === "invoice" && (d.status === "open" || d.status === "partial") && (d.dueDate ?? d.date) < now,
  }));
}

export const list = query({
  args: { kind: v.string(), status: v.optional(v.string()), customerId: v.optional(v.id("customers")) },
  handler: async (ctx, { kind, status, customerId }) => {
    const member = await requirePerm(ctx, "sales.view");
    let rows = status
      ? await ctx.db.query("salesDocs").withIndex("by_kind_status", (q) => q.eq("kind", kind).eq("status", status)).collect()
      : await ctx.db.query("salesDocs").withIndex("by_kind_status", (q) => q.eq("kind", kind)).collect();
    rows = filterByBranch(member, rows).filter((r) => !customerId || r.customerId === customerId);
    rows.sort((a, b) => b.date - a.date || b._creationTime - a._creationTime);
    return await enrich(ctx, rows);
  },
});

export const get = query({
  args: { id: v.id("salesDocs") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "sales.view");
    const doc = await ctx.db.get(id);
    if (!doc) return null;
    assertBranch(member, doc.branchId);
    const [enriched] = await enrich(ctx, [doc]);
    const customer = await ctx.db.get(doc.customerId);
    const products = await ctx.db.query("products").collect();
    const source = doc.sourceDocId ? await ctx.db.get(doc.sourceDocId) : null;
    const converted = doc.convertedToId ? await ctx.db.get(doc.convertedToId) : null;
    return {
      ...enriched,
      customer,
      sourceNumber: source?.number ?? null,
      convertedNumber: converted?.number ?? null,
      lines: doc.lines.map((l) => {
        const p = products.find((x) => x._id === l.productId);
        return { ...l, sku: p?.sku ?? "", unit: p?.unit ?? "" };
      }),
    };
  },
});

async function checkLines(ctx: MutationCtx, member: Doc<"members">, lines: Array<{ discount: number; qty: number }>) {
  if (lines.length === 0) throw new ConvexError("Add at least one line.");
  if (lines.some((l) => l.qty <= 0)) throw new ConvexError("Quantities must be greater than zero.");
  if (lines.some((l) => l.discount > 0) && !has(member, "sales.discount")) {
    throw new ConvexError("You are not authorised to give discounts.");
  }
  void ctx;
}

async function reserve(ctx: MutationCtx, doc: { storeId: Id<"stores">; lines: Array<{ productId: Id<"products">; qty: number }> }, sign: 1 | -1, check: boolean) {
  for (const l of doc.lines) {
    if (check && sign > 0) {
      const bal = await findBalance(ctx, l.productId, doc.storeId);
      const available = (bal?.onHand ?? 0) - (bal?.reserved ?? 0);
      if (available < l.qty) {
        const p = await ctx.db.get(l.productId);
        throw new ConvexError(`${p?.sku}: only ${available} available to reserve.`);
      }
    }
    await bumpCounter(ctx, l.productId, doc.storeId, "reserved", sign * l.qty);
  }
}

/** Credit-limit control. Throws unless the member may override. Returns true if an override was used. */
async function creditCheck(ctx: MutationCtx, member: Doc<"members">, customer: Doc<"customers">, addAmount: number) {
  if (addAmount <= 0) return false;
  const exposure = r2(customer.balance + addAmount);
  const overLimit = exposure > customer.creditLimit;
  const invoices = await ctx.db.query("salesDocs").withIndex("by_customer", (q) => q.eq("customerId", customer._id).eq("kind", "invoice")).collect();
  const hasOverdue = invoices.some((i) => (i.status === "open" || i.status === "partial") && (i.dueDate ?? i.date) < Date.now() - DAY);
  if (!overLimit && !hasOverdue) return false;
  if (!has(member, "credit.override")) {
    throw new ConvexError(
      overLimit
        ? `Credit limit exceeded for ${customer.name}: balance would be ${exposure} against a limit of ${customer.creditLimit}. Record payment now or ask a manager to approve.`
        : `${customer.name} has overdue invoices. A manager must approve further credit.`,
    );
  }
  return true;
}

/** Posts an invoice: issues stock, books revenue/COGS, raises the customer balance. */
async function postInvoice(ctx: MutationCtx, inv: Doc<"salesDocs">, member: Doc<"members">) {
  const customer = await ctx.db.get(inv.customerId);
  if (!customer) throw new ConvexError("Customer not found.");
  let cogs = 0;
  const lines = [];
  for (const l of inv.lines) {
    const { unitCost } = await applyMovement(ctx, {
      productId: l.productId,
      storeId: inv.storeId,
      qty: -l.qty,
      type: "sale",
      sourceType: "invoice",
      sourceId: inv._id,
      reference: inv.number,
      date: inv.date,
      member,
    });
    cogs += l.qty * unitCost;
    lines.push({ ...l, unitCost });
  }
  cogs = r2(cogs);
  const party = { partyType: "customer", partyId: customer._id as string };
  const journalEntryId = await postJournal(ctx, {
    date: inv.date,
    memo: `Invoice ${inv.number} — ${customer.name}`,
    sourceType: "invoice",
    sourceId: inv._id,
    branchId: inv.branchId,
    member,
    lines: [
      { account: "ar", debit: inv.total, ...party },
      { account: "sales_discounts", debit: inv.discountTotal },
      { account: "sales", credit: inv.subtotal },
      { account: "tax_payable", credit: inv.taxAmount },
      { account: "cogs", debit: cogs },
      { account: "inventory", credit: cogs },
    ],
  });
  await ctx.db.patch(inv._id, { lines, journalEntryId, status: "open" });
  await ctx.db.patch(customer._id, { balance: r2(customer.balance + inv.total) });
}

/** Create or update a quotation / sales order / invoice. */
export const save = mutation({
  args: {
    id: v.optional(v.id("salesDocs")),
    kind: v.string(), // quotation | order | invoice
    customerId: v.id("customers"),
    storeId: v.id("stores"),
    date: v.number(),
    dueDate: v.optional(v.number()),
    validUntil: v.optional(v.number()),
    taxRate: v.number(),
    note: v.optional(v.string()),
    lines: v.array(lineInput),
    action: v.string(), // draft | send | confirm | post
    // Invoice paid on the spot (cash/bank). Recorded as a receipt allocated to this invoice.
    payNow: v.optional(
      v.object({ accountId: v.id("accounts"), method: v.string(), amount: v.number(), reference: v.optional(v.string()) }),
    ),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "sales.create");
    if (!["quotation", "order", "invoice"].includes(args.kind)) throw new ConvexError("Unknown document type.");
    const store = await ctx.db.get(args.storeId);
    if (!store) throw new ConvexError("Store not found.");
    assertBranch(member, store.branchId);
    const customer = await ctx.db.get(args.customerId);
    if (!customer) throw new ConvexError("Customer not found.");
    await checkLines(ctx, member, args.lines);
    const t = totals(args.lines, args.taxRate);

    let status = "draft";
    if (args.kind === "quotation" && args.action === "send") status = "sent";
    if (args.kind === "order" && args.action === "confirm") status = "confirmed";
    if (args.kind === "invoice" && args.action === "post") status = "posting";

    const base = {
      customerId: args.customerId,
      branchId: store.branchId,
      storeId: args.storeId,
      date: args.date,
      dueDate: args.kind === "invoice" ? args.dueDate ?? args.date + customer.paymentTermsDays * DAY : args.dueDate,
      validUntil: args.validUntil,
      lines: args.lines,
      taxRate: args.taxRate,
      note: args.note,
      ...t,
    };

    let id = args.id;
    if (id) {
      const existing = await ctx.db.get(id);
      if (!existing || existing.kind !== args.kind) throw new ConvexError("Document not found.");
      if (!["draft", "sent"].includes(existing.status)) throw new ConvexError(`A ${existing.status} document cannot be edited.`);
      await ctx.db.patch(id, { ...base, status: status === "posting" ? "draft" : status });
    } else {
      const number = await nextNumber(ctx, args.kind, PREFIX[args.kind]);
      id = await ctx.db.insert("salesDocs", {
        ...base,
        number,
        kind: args.kind,
        status: status === "posting" ? "draft" : status,
        amountPaid: 0,
        createdBy: member._id,
      });
    }

    if (status === "confirmed") {
      await creditCheck(ctx, member, customer, t.total);
      await reserve(ctx, { storeId: args.storeId, lines: args.lines }, 1, true);
    }
    if (status === "posting") {
      const paidNow = Math.min(args.payNow?.amount ?? 0, t.total);
      const override = await creditCheck(ctx, member, customer, r2(t.total - paidNow));
      const doc = (await ctx.db.get(id))!;
      await postInvoice(ctx, doc, member);
      if (override) await ctx.db.patch(id, { creditApprovedBy: member._id });
      if (args.payNow && paidNow > 0) {
        if (!has(member, "customer_payments.manage")) throw new ConvexError("You cannot record payments.");
        await recordCustomerPayment(ctx, member, {
          customerId: args.customerId,
          branchId: store.branchId,
          date: args.date,
          amount: paidNow,
          accountId: args.payNow.accountId,
          method: args.payNow.method,
          reference: args.payNow.reference,
          allocations: [{ docId: id, amount: paidNow }],
        });
      }
    }
    const doc = (await ctx.db.get(id))!;
    await audit(ctx, member, `${args.kind}.${args.action}`, "salesDocs", id, { number: doc.number, total: t.total }, store.branchId);
    return id;
  },
});

/** quotation → order, quotation → invoice, order → invoice. Each document converts once. */
export const convert = mutation({
  args: { id: v.id("salesDocs"), to: v.string() },
  handler: async (ctx, { id, to }) => {
    const member = await requirePerm(ctx, "sales.create");
    const src = await ctx.db.get(id);
    if (!src) throw new ConvexError("Document not found.");
    assertBranch(member, src.branchId);
    if (src.convertedToId) throw new ConvexError("This document has already been converted.");
    const allowed =
      (src.kind === "quotation" && (to === "order" || to === "invoice") && ["draft", "sent", "accepted"].includes(src.status)) ||
      (src.kind === "order" && to === "invoice" && src.status === "confirmed");
    if (!allowed) throw new ConvexError(`Cannot convert a ${src.status} ${src.kind} to ${to}.`);
    const customer = await ctx.db.get(src.customerId);
    if (!customer) throw new ConvexError("Customer not found.");

    const number = await nextNumber(ctx, to, PREFIX[to]);
    const now = Date.now();
    const newId = await ctx.db.insert("salesDocs", {
      number,
      kind: to,
      customerId: src.customerId,
      branchId: src.branchId,
      storeId: src.storeId,
      date: now,
      dueDate: to === "invoice" ? now + customer.paymentTermsDays * DAY : undefined,
      status: "draft",
      lines: src.lines.map((l) => ({ ...l, unitCost: undefined })),
      subtotal: src.subtotal,
      discountTotal: src.discountTotal,
      taxRate: src.taxRate,
      taxAmount: src.taxAmount,
      total: src.total,
      amountPaid: 0,
      sourceDocId: src._id,
      note: src.note,
      createdBy: member._id,
    });

    if (to === "invoice") {
      if (src.kind === "order") await reserve(ctx, src, -1, false);
      const override = src.kind === "order" ? false : await creditCheck(ctx, member, customer, src.total);
      await postInvoice(ctx, (await ctx.db.get(newId))!, member);
      if (override) await ctx.db.patch(newId, { creditApprovedBy: member._id });
    }
    await ctx.db.patch(src._id, { convertedToId: newId, status: src.kind === "order" ? "invoiced" : "converted" });
    await audit(ctx, member, `${src.kind}.converted`, "salesDocs", newId, { from: src.number, to: number }, src.branchId);
    return newId;
  },
});

export const setStatus = mutation({
  args: { id: v.id("salesDocs"), status: v.string() },
  handler: async (ctx, { id, status }) => {
    const member = await requirePerm(ctx, "sales.create");
    const doc = await ctx.db.get(id);
    if (!doc) throw new ConvexError("Document not found.");
    assertBranch(member, doc.branchId);
    if (doc.kind === "quotation" && ["sent", "accepted", "expired", "cancelled"].includes(status) && !doc.convertedToId) {
      await ctx.db.patch(id, { status });
    } else if (doc.kind === "order" && status === "cancelled" && (doc.status === "draft" || doc.status === "confirmed")) {
      if (doc.status === "confirmed") await reserve(ctx, doc, -1, false);
      await ctx.db.patch(id, { status });
    } else if (doc.kind === "order" && status === "confirmed" && doc.status === "draft") {
      const customer = (await ctx.db.get(doc.customerId))!;
      await creditCheck(ctx, member, customer, doc.total);
      await reserve(ctx, doc, 1, true);
      await ctx.db.patch(id, { status });
    } else {
      throw new ConvexError(`Cannot change a ${doc.status} ${doc.kind} to ${status}.`);
    }
    await audit(ctx, member, `${doc.kind}.${status}`, "salesDocs", id, doc.number, doc.branchId);
  },
});

/** Post a draft invoice. */
export const postDraftInvoice = mutation({
  args: { id: v.id("salesDocs") },
  handler: async (ctx, { id }) => {
    const member = await requirePerm(ctx, "sales.create");
    const doc = await ctx.db.get(id);
    if (!doc || doc.kind !== "invoice") throw new ConvexError("Invoice not found.");
    assertBranch(member, doc.branchId);
    if (doc.status !== "draft") throw new ConvexError("Only draft invoices can be posted.");
    const customer = (await ctx.db.get(doc.customerId))!;
    const override = await creditCheck(ctx, member, customer, doc.total);
    await postInvoice(ctx, doc, member);
    if (override) await ctx.db.patch(id, { creditApprovedBy: member._id });
    await audit(ctx, member, "invoice.post", "salesDocs", id, doc.number, doc.branchId);
  },
});

/** Void an unpaid invoice: reverses the journal and returns stock at its original cost. */
export const voidInvoice = mutation({
  args: { id: v.id("salesDocs"), reason: v.string() },
  handler: async (ctx, { id, reason }) => {
    const member = await requirePerm(ctx, "credit.override");
    const inv = await ctx.db.get(id);
    if (!inv || inv.kind !== "invoice") throw new ConvexError("Invoice not found.");
    assertBranch(member, inv.branchId);
    if (inv.status === "void") throw new ConvexError("Already void.");
    if (inv.status === "draft") {
      await ctx.db.patch(id, { status: "void" });
      return;
    }
    if (inv.amountPaid > 0) throw new ConvexError("This invoice has payments. Issue a credit note instead.");
    for (const l of inv.lines) {
      await applyMovement(ctx, {
        productId: l.productId,
        storeId: inv.storeId,
        qty: l.qty,
        unitCost: l.unitCost ?? 0,
        type: "sale_return",
        sourceType: "invoice_void",
        sourceId: inv._id,
        reference: inv.number,
        date: Date.now(),
        member,
        note: reason,
      });
    }
    if (inv.journalEntryId) await reverseJournal(ctx, inv.journalEntryId, member, reason);
    const customer = await ctx.db.get(inv.customerId);
    if (customer) await ctx.db.patch(customer._id, { balance: r2(customer.balance - inv.total) });
    await ctx.db.patch(id, { status: "void" });
    await audit(ctx, member, "invoice.void", "salesDocs", id, reason, inv.branchId);
  },
});

/** Credit note / sales return. Optionally puts the goods back on the shelf. */
export const createCreditNote = mutation({
  args: {
    invoiceId: v.optional(v.id("salesDocs")),
    customerId: v.id("customers"),
    storeId: v.id("stores"),
    date: v.number(),
    returnsStock: v.boolean(),
    reason: v.string(),
    taxRate: v.number(),
    lines: v.array(lineInput),
  },
  handler: async (ctx, args) => {
    const member = await requirePerm(ctx, "sales.create");
    if (!has(member, "credit.override") && !has(member, "sales.discount")) {
      throw new ConvexError("Credit notes require manager authorisation.");
    }
    const store = await ctx.db.get(args.storeId);
    if (!store) throw new ConvexError("Store not found.");
    assertBranch(member, store.branchId);
    const customer = await ctx.db.get(args.customerId);
    if (!customer) throw new ConvexError("Customer not found.");
    const invoice = args.invoiceId ? await ctx.db.get(args.invoiceId) : null;
    if (invoice) {
      if (invoice.customerId !== args.customerId) throw new ConvexError("Invoice belongs to another customer.");
      // Cannot return more than was invoiced (net of earlier credit notes)
      const earlier = (await ctx.db.query("salesDocs").withIndex("by_customer", (q) => q.eq("customerId", args.customerId).eq("kind", "credit_note")).collect()).filter(
        (c) => c.sourceDocId === invoice._id && c.status !== "void",
      );
      for (const l of args.lines) {
        const sold = invoice.lines.filter((x) => x.productId === l.productId).reduce((a, x) => a + x.qty, 0);
        const returned = earlier.flatMap((c) => c.lines).filter((x) => x.productId === l.productId).reduce((a, x) => a + x.qty, 0);
        if (l.qty > sold - returned) throw new ConvexError(`${l.description}: returning more than was sold on ${invoice.number}.`);
      }
    }
    if (args.lines.length === 0) throw new ConvexError("Add at least one line.");
    const t = totals(args.lines, args.taxRate);
    const number = await nextNumber(ctx, "credit_note", "CN");
    const id = await ctx.db.insert("salesDocs", {
      number,
      kind: "credit_note",
      customerId: args.customerId,
      branchId: store.branchId,
      storeId: args.storeId,
      date: args.date,
      status: "open",
      lines: args.lines,
      ...t,
      taxRate: args.taxRate,
      amountPaid: 0,
      sourceDocId: args.invoiceId,
      returnsStock: args.returnsStock,
      note: args.reason,
      createdBy: member._id,
    });

    let costBack = 0;
    const lines = [];
    for (const l of args.lines) {
      let unitCost: number | undefined;
      if (args.returnsStock) {
        const fromInvoice = invoice?.lines.find((x) => x.productId === l.productId)?.unitCost;
        const res = await applyMovement(ctx, {
          productId: l.productId,
          storeId: args.storeId,
          qty: l.qty,
          unitCost: fromInvoice,
          type: "sale_return",
          sourceType: "credit_note",
          sourceId: id,
          reference: number,
          date: args.date,
          member,
          note: args.reason,
        });
        unitCost = res.unitCost;
        costBack += l.qty * res.unitCost;
      }
      lines.push({ ...l, unitCost });
    }
    costBack = r2(costBack);
    const party = { partyType: "customer", partyId: customer._id as string };
    const journalEntryId = await postJournal(ctx, {
      date: args.date,
      memo: `Credit note ${number} — ${customer.name}: ${args.reason}`,
      sourceType: "credit_note",
      sourceId: id,
      branchId: store.branchId,
      member,
      lines: [
        { account: "sales_returns", debit: r2(t.subtotal - t.discountTotal) },
        { account: "tax_payable", debit: t.taxAmount },
        { account: "ar", credit: t.total, ...party },
        { account: "inventory", debit: costBack },
        { account: "cogs", credit: costBack },
      ],
    });
    await ctx.db.patch(id, { lines, journalEntryId });
    await ctx.db.patch(customer._id, { balance: r2(customer.balance - t.total) });
    await audit(ctx, member, "credit_note.posted", "salesDocs", id, { number, total: t.total }, store.branchId);
    await notifyPermission(ctx, "accounting.view", `Credit note ${number} issued`, `${customer.name}: ${t.total}`, "/sales/credit-notes", store.branchId, member._id);
    return id;
  },
});

/** Apply an open credit note against an open invoice (no cash moves; both sides sit in AR). */
export const applyCredit = mutation({
  args: { creditNoteId: v.id("salesDocs"), invoiceId: v.id("salesDocs"), amount: v.number() },
  handler: async (ctx, { creditNoteId, invoiceId, amount }) => {
    const member = await requirePerm(ctx, "customer_payments.manage");
    const cn = await ctx.db.get(creditNoteId);
    const inv = await ctx.db.get(invoiceId);
    if (!cn || cn.kind !== "credit_note" || !inv || inv.kind !== "invoice") throw new ConvexError("Documents not found.");
    if (cn.customerId !== inv.customerId) throw new ConvexError("Different customers.");
    assertBranch(member, inv.branchId);
    const cnLeft = r2(cn.total - cn.amountPaid);
    const invLeft = r2(inv.total - inv.amountPaid);
    if (amount <= 0 || amount > cnLeft + 0.001 || amount > invLeft + 0.001) throw new ConvexError("Amount exceeds what is available.");
    const cnPaid = r2(cn.amountPaid + amount);
    const invPaid = r2(inv.amountPaid + amount);
    await ctx.db.patch(cn._id, { amountPaid: cnPaid, status: cnPaid >= cn.total ? "applied" : "open" });
    await ctx.db.patch(inv._id, { amountPaid: invPaid, status: invPaid >= inv.total ? "paid" : "partial" });
    await audit(ctx, member, "credit_note.applied", "salesDocs", cn._id, { invoice: inv.number, amount }, inv.branchId);
  },
});

export const taxDefault = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "sales.view");
    const company = await getCompany(ctx);
    return company.defaultTaxRate;
  },
});
